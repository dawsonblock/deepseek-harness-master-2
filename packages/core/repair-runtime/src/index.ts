/**
 * Repair runtime plugin: hooks goal verification failure to the
 * {@link RepairControllerService} with durable event persistence. Opt-in via
 * cordis.yml config; does not change existing workflows when disabled.
 *
 * The plugin watches `goal/verification` session events. When verification
 * fails, it builds a {@link FailurePackage} from the verification checks,
 * calls `RepairController.decide()`, emits `repair/evidence` and
 * `repair/decision`, and either queues a repair followup message (with
 * failure evidence for the model) or blocks the goal.
 *
 * On Flash→Pro escalation, the plugin emits `model/escalation` with explicit
 * repair provenance. On completion or stop, it emits `repair/completed` with
 * task-level accounting.
 *
 * @module @deepseek-ai/dsh-repair-runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalRef, GoalVerificationCheck, GoalView } from '@deepseek-ai/dsh-goal'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { FailurePackage, ModelRef, RepairAttempt, RepairDecision } from '@deepseek-ai/dsh-repair-controller'
import { classifyProgress, computeFailureFingerprint } from '@deepseek-ai/dsh-repair-controller'
// Import the events module to trigger declaration merging for repair/* and model/escalation events.
import '@deepseek-ai/dsh-repair-controller/events'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** Plugin configuration. */
export interface RepairRuntimeConfig {
  /** Whether the repair loop is enabled. Default: false. */
  enabled: boolean
  /** The Flash model ref for repair attempts. Required when enabled. */
  flashModel?: { provider: string; model: string }
  /** The Pro model ref for escalation. Required when enabled. */
  proModel?: { provider: string; model: string }
  /** Max Flash attempts. Default: 3. */
  maxFlashAttempts?: number
  /** Max Pro attempts. Default: 2. */
  maxProAttempts?: number
  /** Max total attempts. Default: 5. */
  maxTotalAttempts?: number
}

/** Per-goal repair state. */
interface RepairState {
  repairId: string
  attempts: RepairAttempt[]
  totalCostUsd: number
  elapsedMs: number
  startedAt: number
  flashAttempts: number
  proAttempts: number
}

/** Build a FailurePackage from verification checks. */
function buildFailurePackage(checks: readonly GoalVerificationCheck[], changedFiles: readonly string[]): FailurePackage {
  const failedCriteria = checks
    .filter(check => check.role === 'acceptance' && !check.passed)
    .map(check => check.reason)
  const failingTests = checks
    .filter(check => check.name.includes('test'))
    .filter(check => !check.passed)
    .map(check => check.reason)
  const typeErrors = checks
    .filter(check => check.name.includes('type'))
    .filter(check => !check.passed)
    .flatMap(check => check.evidence ?? [check.reason])
  const buildErrors = checks
    .filter(check => check.name.includes('build'))
    .filter(check => !check.passed)
    .flatMap(check => check.evidence ?? [check.reason])
  return {
    failedCriteria,
    failingTests,
    typeErrors,
    buildErrors,
    changedFiles,
  }
}

/** Render a repair prompt for the model from failure evidence. */
function renderRepairPrompt(failure: FailurePackage, attempt: number): ContentBlock[] {
  const lines: string[] = [
    `Repair attempt ${attempt}: the previous attempt failed verification.`,
    '',
    'Failed criteria:',
    ...failure.failedCriteria.map(c => `- ${c}`),
    '',
    'Failing tests:',
    ...failure.failingTests.map(t => `- ${t}`),
    '',
    'Type errors:',
    ...failure.typeErrors.map(e => `- ${e}`),
    '',
    'Build errors:',
    ...failure.buildErrors.map(e => `- ${e}`),
    '',
    'Fix the issues above. The workspace state from the previous attempt is preserved.',
  ]
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Render a Pro escalation prompt with full context. */
function renderProEscalationPrompt(failure: FailurePackage, flashAttempts: number): ContentBlock[] {
  const lines: string[] = [
    `Escalation from Flash after ${flashAttempts} failed attempt(s).`,
    'You are taking over a task that Flash could not complete.',
    'The workspace state from the previous attempts is preserved.',
    '',
    'Failed criteria:',
    ...failure.failedCriteria.map(c => `- ${c}`),
    '',
    'Failing tests:',
    ...failure.failingTests.map(t => `- ${t}`),
    '',
    'Type errors:',
    ...failure.typeErrors.map(e => `- ${e}`),
    '',
    'Build errors:',
    ...failure.buildErrors.map(e => `- ${e}`),
    '',
    'Repair the work. You may rewrite the previous attempts\' changes or start fresh.',
  ]
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Extract the model ref from a routing decision event. */
function modelFromRoutingDecision(events: readonly SessionEvent[], routingDecisionId: string): ModelRef | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event === undefined) continue
    if ((event.type as string) === 'model/routing-decision') {
      const data = event.data as unknown as { routingDecisionId?: string; selected: { provider: string; model: string } }
      if (data.routingDecisionId === routingDecisionId) {
        return { provider: data.selected.provider, model: data.selected.model }
      }
    }
  }
  return undefined
}

/** Find the latest routing decision id for a turn. */
function latestRoutingDecisionId(events: readonly SessionEvent[], turn: number): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event === undefined) continue
    if ((event.type as string) === 'model/routing-decision') {
      const data = event.data as unknown as { turn?: number; routingDecisionId?: string }
      if (data.turn === turn && data.routingDecisionId !== undefined) {
        return data.routingDecisionId
      }
    }
  }
  return undefined
}

/** Find changed files from tool calls in the current turn. */
function changedFilesInTurn(events: readonly SessionEvent[], turn: number): string[] {
  const files: string[] = []
  for (const event of events) {
    if (event.type === 'tool/call' && (event.data as { turn?: number }).turn === turn) {
      const data = event.data as { name: string; arguments: string }
      if (data.name === 'write_file' || data.name === 'edit_file' || data.name === 'str_replace_editor') {
        try {
          const args = JSON.parse(data.arguments) as { file_path?: string; path?: string }
          const path = args.file_path ?? args.path
          if (path !== undefined) files.push(path)
        } catch {
          /* ignore unparseable args */
        }
      }
    }
  }
  return [...new Set(files)]
}

/**
 * Reconstruct repair state for one goal from the durable session log.
 * After a crash and restart, this function rebuilds the {@link RepairState}
 * by replaying repair/evidence, repair/decision, model/escalation, and
 * repair/completed events. If a repair/completed event exists for the
 * repairId, the repair is finished and undefined is returned.
 *
 * @param events - the full session event log.
 * @param goalId - the goal id to reconstruct state for.
 * @param flashModel - the Flash model ref for reconstructed attempts.
 * @param proModel - the Pro model ref for escalated attempts.
 * @returns the reconstructed state, or undefined if no repair or repair completed.
 */
export function reconstructRepairState(
  events: readonly SessionEvent[],
  goalId: string,
  flashModel: ModelRef = { provider: 'deepseek', model: 'deepseek-v4-flash' },
  proModel: ModelRef = { provider: 'deepseek', model: 'deepseek-v4-pro' },
): RepairState | undefined {
  const repairEvents = events.filter(
    e => (e.type as string).startsWith('repair/') || (e.type as string) === 'model/escalation',
  )
  if (repairEvents.length === 0) return undefined

  let repairId: string | undefined
  let completed = false
  const attempts: RepairAttempt[] = []
  let flashAttempts = 0
  let proAttempts = 0

  for (const event of repairEvents) {
    const data = event.data as Record<string, unknown>
    if (typeof data.repairId === 'string' && data.repairId.includes(goalId)) {
      repairId = data.repairId
    }
    if (event.type === 'repair/completed' && data.repairId === repairId) {
      completed = true
      break
    }
    if (event.type === 'repair/evidence' && data.repairId === repairId) {
      const attemptNum = data.attempt as number
      const fingerprint = data.failureFingerprint as string
      const progress = data.progress as RepairAttempt['progress']
      attempts.push({
        attempt: attemptNum,
        model: flashModel,
        routingDecisionId: data.routingDecisionId as string,
        verified: false,
        verificationStatus: 'verified-fail',
        failureFingerprint: fingerprint,
        ...(progress !== undefined ? { progress } : {}),
        costUsd: 0,
        latencyMs: 0,
      })
    }
    if (event.type === 'repair/decision' && data.repairId === repairId) {
      const action = data.action as string
      if (action === 'flash-repair') flashAttempts += 1
      if (action === 'pro-escalate') {
        proAttempts += 1
        const last = attempts.at(-1)
        if (last !== undefined) {
          attempts[attempts.length - 1] = { ...last, model: proModel }
        }
      }
    }
  }

  if (repairId === undefined || completed) return undefined

  return {
    repairId,
    attempts,
    totalCostUsd: 0,
    elapsedMs: 0,
    startedAt: Date.now(),
    flashAttempts,
    proAttempts,
  }
}

/** Plugin entry point. */
export function apply(ctx: Context, config: RepairRuntimeConfig = { enabled: false }): void {
  if (!config.enabled) return

  const flashModel: ModelRef = config.flashModel ?? { provider: 'deepseek', model: 'deepseek-v4-flash' }
  const proModel: ModelRef = config.proModel ?? { provider: 'deepseek', model: 'deepseek-v4-pro' }

  const repairStates = new Map<string, RepairState>()

  /** Get or create repair state for a goal, reconstructing from the log on first access. */
  function stateFor(agent: Agent, goal: GoalView): RepairState {
    const key = `${agent.id}:${goal.id}`
    const existing = repairStates.get(key)
    if (existing !== undefined) return existing
    const reconstructed = reconstructRepairState(agent.session.events, goal.id, flashModel, proModel)
    if (reconstructed !== undefined) {
      repairStates.set(key, reconstructed)
      return reconstructed
    }
    const state: RepairState = {
      repairId: `repair-${goal.id}-${Date.now()}`,
      attempts: [],
      totalCostUsd: 0,
      elapsedMs: 0,
      startedAt: Date.now(),
      flashAttempts: 0,
      proAttempts: 0,
    }
    repairStates.set(key, state)
    return state
  }

  /** Build a RepairAttempt from the latest verification and session data. */
  function buildAttempt(
    session: Session,
    turn: number,
    verified: boolean,
    failure: FailurePackage | undefined,
    model: ModelRef,
    attemptNumber: number,
  ): RepairAttempt {
    const routingDecisionId = latestRoutingDecisionId(session.events, turn) ?? `unknown-${attemptNumber}`
    const priorFailure = stateForAttempts(session, turn)
    const progress = failure !== undefined && !verified
      ? classifyProgress(priorFailure, failure)
      : undefined
    const fingerprint = failure !== undefined && !verified
      ? computeFailureFingerprint(failure)
      : undefined
    return {
      attempt: attemptNumber,
      model,
      routingDecisionId,
      verified,
      verificationStatus: verified ? 'verified-pass' : 'verified-fail',
      ...(fingerprint !== undefined ? { failureFingerprint: fingerprint } : {}),
      ...(progress !== undefined ? { progress } : {}),
      ...(failure !== undefined && !verified ? { failurePackage: failure } : {}),
      costUsd: 0,
      latencyMs: 0,
    }
  }

  /** Find the prior failure package from repair attempts. */
  function stateForAttempts(_session: Session, _turn: number): FailurePackage | undefined {
    return undefined
  }

  ctx.effect(function* () {
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (event.type !== 'goal/verification') return
      const data = event.data as {
        goal: GoalRef
        passed: boolean
        checks: readonly GoalVerificationCheck[]
      }
      if (data.passed) return

      const agent = ctx.agents.get(session.id)
      if (agent === undefined || agent.session !== session) return

      const goal = ctx.goals.get(agent)
      if (goal === undefined || goal.id !== data.goal.id) return

      const turn = session.events.reduce(
        (max, e) => e.type === 'turn/start' ? Math.max(max, (e.data as { turn: number }).turn) : max, 0,
      )

      const changedFiles = changedFilesInTurn(session.events, turn)
      const failure = buildFailurePackage(data.checks, changedFiles)
      const state = stateFor(agent, goal)

      const routingDecisionId = latestRoutingDecisionId(session.events, turn)
      const model = routingDecisionId !== undefined
        ? modelFromRoutingDecision(session.events, routingDecisionId) ?? flashModel
        : flashModel

      const attemptNumber = state.attempts.length + 1
      const attempt = buildAttempt(session, turn, false, failure, model, attemptNumber)
      state.attempts.push(attempt)

      const fingerprint = attempt.failureFingerprint ?? computeFailureFingerprint(failure)

      // Emit repair/evidence
      session.append('repair/evidence', {
        repairId: state.repairId,
        turn,
        step: 0,
        attempt: attemptNumber,
        routingDecisionId: attempt.routingDecisionId,
        failureFingerprint: fingerprint,
        progress: attempt.progress ?? 'none',
        failedCriteria: failure.failedCriteria,
        failingTests: failure.failingTests,
        typeErrors: failure.typeErrors,
        buildErrors: failure.buildErrors,
        changedFiles: failure.changedFiles,
      }, { ignorable: true })

      // Call the repair controller
      const repairController = ctx.get('repairController') as { decide: (input: object) => RepairDecision } | undefined
      if (repairController === undefined) {
        ctx.logger.warn(`repair-runtime: RepairController service not available; blocking goal "${goal.id}"`)
        ctx.goals.block(agent, { id: goal.id, revision: goal.revision }, {
          code: 'repair-controller-unavailable',
          message: 'RepairController service is not registered',
        })
        return
      }

      const decision = repairController.decide({
        sessionId: session.id,
        turn,
        step: 0,
        initialModel: flashModel,
        currentModel: model,
        attempts: state.attempts,
        latestFailure: failure,
        budget: {
          totalCostUsd: state.totalCostUsd,
          elapsedMs: Date.now() - state.startedAt,
        },
      })

      // Emit repair/decision
      session.append('repair/decision', {
        repairId: state.repairId,
        turn,
        step: 0,
        attempt: attemptNumber,
        action: decision.action,
        ...(decision.action === 'pro-escalate' ? { reason: decision.reason } : {}),
        ...(decision.action === 'stop' ? { reason: decision.reason } : {}),
        failureFingerprint: fingerprint,
      }, { ignorable: true })

      switch (decision.action) {
        case 'complete': {
          session.append('repair/completed', {
            repairId: state.repairId,
            turn,
            step: 0,
            finalRoutingDecisionId: attempt.routingDecisionId,
            verified: true,
            totalAttempts: state.attempts.length,
            flashAttempts: state.flashAttempts,
            proAttempts: state.proAttempts,
            totalCostUsd: state.totalCostUsd,
            elapsedMs: Date.now() - state.startedAt,
          }, { ignorable: true })
          repairStates.delete(`${agent.id}:${goal.id}`)
          return
        }
        case 'flash-repair': {
          state.flashAttempts += 1
          const prompt = renderRepairPrompt(decision.evidence, state.attempts.length + 1)
          const message = createUserMessage({
            content: prompt,
            source: { kind: 'goal', goalId: goal.id, revision: goal.revision, round: goal.roundsStarted + 1 },
          })
          agent.followup(message)
          return
        }
        case 'pro-escalate': {
          state.proAttempts += 1
          // Emit model/escalation
          session.append('model/escalation', {
            repairId: state.repairId,
            turn,
            step: 0,
            fromRoutingDecisionId: attempt.routingDecisionId,
            toRoutingDecisionId: `pro-${state.repairId}-${state.proAttempts}`,
            repairOf: attempt.routingDecisionId,
            fromModel: model.model,
            toModel: proModel.model,
            reason: decision.reason,
            failureFingerprint: fingerprint,
            flashAttempts: state.flashAttempts,
          }, { ignorable: true })

          const prompt = renderProEscalationPrompt(decision.evidence, state.flashAttempts)
          const message = createUserMessage({
            content: prompt,
            source: { kind: 'goal', goalId: goal.id, revision: goal.revision, round: goal.roundsStarted + 1 },
          })
          agent.followup(message)
          return
        }
        case 'stop': {
          session.append('repair/completed', {
            repairId: state.repairId,
            turn,
            step: 0,
            finalRoutingDecisionId: attempt.routingDecisionId,
            verified: false,
            totalAttempts: state.attempts.length,
            flashAttempts: state.flashAttempts,
            proAttempts: state.proAttempts,
            totalCostUsd: state.totalCostUsd,
            elapsedMs: Date.now() - state.startedAt,
          }, { ignorable: true })
          ctx.goals.block(agent, { id: goal.id, revision: goal.revision }, {
            code: 'repair-exhausted',
            message: `Repair exhausted: ${decision.reason}`,
          })
          repairStates.delete(`${agent.id}:${goal.id}`)
          return
        }
      }
    })

    ctx.on('agent/disposed', ({ agent }) => {
      for (const key of repairStates.keys()) {
        if (key.startsWith(`${agent.id}:`)) repairStates.delete(key)
      }
    })
  })
}

export { default as invariant } from './invariant.ts'
