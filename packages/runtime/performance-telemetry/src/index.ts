/**
 * First-party runtime performance/context telemetry.
 *
 * v0.14.1 measures model/tool time from monotonic execution spans around the
 * actual `llm/stream` and `tools/execute` seams instead of inferring those
 * intervals from durable event timestamps. This keeps synchronous Session
 * listeners, projection and persistence work in orchestration time where it
 * belongs. Emitted diagnostics remain ignorable and never affect correctness.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'

export const name = 'runtime-performance-telemetry'
export const inject = ['tokenMeter', 'sessions']

export interface Interval {
  start: number
  end: number
}

interface TurnTrace {
  turn: number
  start: number
  modelIntervals: Interval[]
  toolIntervals: Interval[]
}

/** Length of the union of monotonic intervals. */
export function unionDuration(intervals: readonly Interval[]): number {
  if (intervals.length === 0) return 0
  const sorted = [...intervals]
    .filter(interval => Number.isFinite(interval.start)
      && Number.isFinite(interval.end)
      && interval.end >= interval.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)
  if (sorted.length === 0) return 0
  let total = 0
  let start = sorted[0]!.start
  let end = sorted[0]!.end
  for (let index = 1; index < sorted.length; index += 1) {
    const interval = sorted[index]!
    if (interval.start <= end) {
      end = Math.max(end, interval.end)
      continue
    }
    total += end - start
    start = interval.start
    end = interval.end
  }
  return total + (end - start)
}

export interface TurnPerformanceSample {
  turnWallMs: number
  modelWaitMs: number
  externalToolMs: number
  orchestrationMs: number
  orchestrationOverheadRatio: number
}

/** Derive one turn sample from monotonic execution spans. */
export function deriveTurnPerformanceSample(
  turnWallMs: number,
  modelIntervals: readonly Interval[],
  toolIntervals: readonly Interval[],
): TurnPerformanceSample {
  const wall = Math.max(0, turnWallMs)
  const modelWaitMs = Math.min(wall, unionDuration(modelIntervals))
  const externalToolMs = Math.min(
    Math.max(0, wall - modelWaitMs),
    unionDuration(toolIntervals),
  )
  const orchestrationMs = Math.max(0, wall - modelWaitMs - externalToolMs)
  return {
    turnWallMs: wall,
    modelWaitMs,
    externalToolMs,
    orchestrationMs,
    orchestrationOverheadRatio: wall === 0 ? 0 : orchestrationMs / wall,
  }
}

function tracesFor(
  all: WeakMap<Session, Map<number, TurnTrace>>,
  session: Session,
): Map<number, TurnTrace> {
  let traces = all.get(session)
  if (traces === undefined) {
    traces = new Map()
    all.set(session, traces)
  }
  return traces
}

function appendLater(session: Session, type: 'context/composition' | 'runtime/performance-sample', data: unknown): void {
  queueMicrotask(() => {
    try {
      session.append(type, data as never, { ignorable: true })
    } catch {
      // Diagnostics are fail-open: a closed/disposed session must not turn
      // telemetry into an execution failure.
    }
  })
}

export function apply(ctx: Context): void {
  const allTraces = new WeakMap<Session, Map<number, TurnTrace>>()
  const activeTurns = new WeakMap<Session, number>()

  const activeTrace = (session: Session): TurnTrace | undefined => {
    const turn = activeTurns.get(session)
    return turn === undefined ? undefined : tracesFor(allTraces, session).get(turn)
  }

  // Measure the actual model stream seam. The timer starts only after the
  // agent loop has appended model/request and all synchronous Session observers
  // have returned, fixing v0.14's systematic under-count of orchestration.
  ctx.on('llm/stream', (options, next) => {
    if (options.sessionId === undefined) return next()
    const session = ctx.sessions.get(options.sessionId as never)
    const trace = session === undefined ? undefined : activeTrace(session)
    if (trace === undefined) return next()
    const started = performance.now()
    const stream = next()
    return (async function* measuredStream() {
      try {
        for await (const chunk of stream) yield chunk
      } finally {
        trace.modelIntervals.push({ start: started, end: performance.now() })
      }
    })()
  })

  // Likewise measure only the around-dispatch/tool body seam. Ordered
  // preparation/finalization and Session listeners remain orchestration time.
  ctx.on('tools/execute', async (exec, next) => {
    const session = exec.agent?.session
    const trace = session === undefined ? undefined : activeTrace(session)
    if (trace === undefined) return next()
    const started = performance.now()
    try {
      return await next()
    } finally {
      trace.toolIntervals.push({ start: started, end: performance.now() })
    }
  })

  ctx.on('session/event', (session, event) => {
    if (event.type === 'context/composition' || event.type === 'runtime/performance-sample') return
    const traces = tracesFor(allTraces, session)

    if (event.type === 'model/request') {
      const measurement = ctx.tokenMeter.measure(session)
      appendLater(session, 'context/composition', {
        version: 1,
        totalTokens: measurement.estimatedRequestTokens,
        reasoningTokens: measurement.reasoningSurfaceTokens,
        reasoningContextRatio: measurement.reasoningContextRatio,
      })
      return
    }

    if (event.type === 'turn/start') {
      traces.set(event.data.turn, {
        turn: event.data.turn,
        start: performance.now(),
        modelIntervals: [],
        toolIntervals: [],
      })
      activeTurns.set(session, event.data.turn)
      return
    }

    if (event.type !== 'turn/end') return
    const trace = traces.get(event.data.turn)
    if (trace === undefined) return
    traces.delete(event.data.turn)
    activeTurns.delete(session)

    const sample = deriveTurnPerformanceSample(
      performance.now() - trace.start,
      trace.modelIntervals,
      trace.toolIntervals,
    )

    appendLater(session, 'runtime/performance-sample', {
      version: 2,
      turn: trace.turn,
      ...sample,
      timingSource: 'monotonic-execution-spans',
    })
  })
}
