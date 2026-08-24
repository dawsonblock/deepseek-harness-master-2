import type {
  ResourceAdmission,
  ResourceBudgetDimension,
  RootResourceBudget,
  RootResourceUsage,
} from './types.js'

interface MutableRootUsage {
  descendantsStarted: number
  concurrentOneShotChildren: number
  modelCalls: number
  reasoningTokens: number
  eventBytes: number
  wallTimeMs: number
  rejectedAdmissions: number
  startTimes: number[]
}

function assertLimit(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new TypeError(`${name} must be a finite non-negative number`)
  }
}

export class ResourceBudgetExceededError extends Error {
  constructor(
    public readonly rootId: string,
    public readonly dimension: ResourceBudgetDimension,
    public readonly limit: number,
    public readonly actual: number,
  ) {
    super(`resource budget exceeded for ${rootId}: ${dimension} ${actual} > ${limit}`)
    this.name = 'ResourceBudgetExceededError'
  }
}

/**
 * Process-local root-wide resource accounting. Deployments can reconstruct or
 * seed counters after restart from durable telemetry; this class deliberately
 * does not invent persistence or distributed consensus semantics.
 */
export class RootResourceGovernor {
  private readonly roots = new Map<string, MutableRootUsage>()

  constructor(public readonly budget: RootResourceBudget) {
    assertLimit(budget.maxConcurrentOneShotChildren, 'maxConcurrentOneShotChildren')
    assertLimit(budget.maxDescendantsStarted, 'maxDescendantsStarted')
    assertLimit(budget.maxSubagentStartsPerMinute, 'maxSubagentStartsPerMinute')
    assertLimit(budget.maxModelCalls, 'maxModelCalls')
    assertLimit(budget.maxReasoningTokens, 'maxReasoningTokens')
    assertLimit(budget.maxEventBytes, 'maxEventBytes')
    assertLimit(budget.maxWallTimeMs, 'maxWallTimeMs')
  }

  admitSubagent(rootId: string, kind: 'one-shot' | 'continuable', now = Date.now()): ResourceAdmission {
    const usage = this.mutable(rootId)
    usage.startTimes = usage.startTimes.filter(time => now - time < 60_000)
    this.assertWouldFit(rootId, 'descendants-started', usage.descendantsStarted + 1, this.budget.maxDescendantsStarted)
    this.assertWouldFit(rootId, 'subagent-start-rate', usage.startTimes.length + 1, this.budget.maxSubagentStartsPerMinute)
    if (kind === 'one-shot') {
      this.assertWouldFit(
        rootId,
        'concurrent-one-shot-children',
        usage.concurrentOneShotChildren + 1,
        this.budget.maxConcurrentOneShotChildren,
      )
    }
    usage.descendantsStarted += 1
    usage.startTimes.push(now)
    if (kind === 'one-shot') usage.concurrentOneShotChildren += 1
    let committed = false
    let closed = false
    return {
      rootId,
      kind,
      admittedAt: now,
      commit: () => {
        if (closed) throw new Error('cannot commit a closed resource admission')
        committed = true
      },
      rollback: () => {
        if (closed) return
        if (committed) throw new Error('cannot roll back a committed resource admission')
        closed = true
        usage.descendantsStarted = Math.max(0, usage.descendantsStarted - 1)
        const index = usage.startTimes.lastIndexOf(now)
        if (index >= 0) usage.startTimes.splice(index, 1)
        if (kind === 'one-shot') usage.concurrentOneShotChildren = Math.max(0, usage.concurrentOneShotChildren - 1)
      },
      release: () => {
        if (closed) return
        closed = true
        if (kind === 'one-shot') usage.concurrentOneShotChildren = Math.max(0, usage.concurrentOneShotChildren - 1)
      },
    }
  }

  recordModelUsage(rootId: string, modelCalls = 1, reasoningTokens = 0): void {
    const usage = this.mutable(rootId)
    this.assertIncrement(rootId, 'model-calls', usage.modelCalls, modelCalls, this.budget.maxModelCalls)
    this.assertIncrement(rootId, 'reasoning-tokens', usage.reasoningTokens, reasoningTokens, this.budget.maxReasoningTokens)
    usage.modelCalls += modelCalls
    usage.reasoningTokens += reasoningTokens
  }

  recordEventBytes(rootId: string, bytes: number): void {
    const usage = this.mutable(rootId)
    this.assertIncrement(rootId, 'event-bytes', usage.eventBytes, bytes, this.budget.maxEventBytes)
    usage.eventBytes += bytes
  }

  recordWallTime(rootId: string, durationMs: number): void {
    const usage = this.mutable(rootId)
    this.assertIncrement(rootId, 'wall-time-ms', usage.wallTimeMs, durationMs, this.budget.maxWallTimeMs)
    usage.wallTimeMs += durationMs
  }

  snapshot(rootId: string): RootResourceUsage {
    const usage = this.mutable(rootId)
    return {
      rootId,
      descendantsStarted: usage.descendantsStarted,
      concurrentOneShotChildren: usage.concurrentOneShotChildren,
      modelCalls: usage.modelCalls,
      reasoningTokens: usage.reasoningTokens,
      eventBytes: usage.eventBytes,
      wallTimeMs: usage.wallTimeMs,
      rejectedAdmissions: usage.rejectedAdmissions,
    }
  }

  reset(rootId?: string): void {
    if (rootId === undefined) this.roots.clear()
    else this.roots.delete(rootId)
  }

  private mutable(rootId: string): MutableRootUsage {
    const existing = this.roots.get(rootId)
    if (existing !== undefined) return existing
    const created: MutableRootUsage = {
      descendantsStarted: 0,
      concurrentOneShotChildren: 0,
      modelCalls: 0,
      reasoningTokens: 0,
      eventBytes: 0,
      wallTimeMs: 0,
      rejectedAdmissions: 0,
      startTimes: [],
    }
    this.roots.set(rootId, created)
    return created
  }

  private assertIncrement(
    rootId: string,
    dimension: ResourceBudgetDimension,
    current: number,
    increment: number,
    limit: number | undefined,
  ): void {
    if (!Number.isFinite(increment) || increment < 0) throw new TypeError(`${dimension} increment must be finite and non-negative`)
    this.assertWouldFit(rootId, dimension, current + increment, limit)
  }

  private assertWouldFit(
    rootId: string,
    dimension: ResourceBudgetDimension,
    actual: number,
    limit: number | undefined,
  ): void {
    if (limit === undefined || actual <= limit) return
    this.mutable(rootId).rejectedAdmissions += 1
    throw new ResourceBudgetExceededError(rootId, dimension, limit, actual)
  }
}
