/**
 * Routing outcome measurement: joins routing decisions, token accounting, tool
 * execution quality, and verification results into one derived record per
 * routing decision.
 *
 * Canonical truth remains the session event stream:
 * - `model/routing-decision` — route selection
 * - `model/usage` — per-attempt provider accounting
 * - `tool/call` / `tool/result` — tool execution
 * - `goal/verification` / `goal/outcome-receipt` — verification
 *
 * `RoutingOutcome` is a derived projection, not another mutable truth source.
 *
 * @module @deepseek-ai/dsh-token-meter/routing-outcome
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ModelPricing } from './pricing.ts'
import type { ContextWorkloadFeatures } from './context-estimate.ts'
import { calculateCost, lookupPricing } from './pricing.ts'
import { extractUsageRecords } from './aggregate.ts'

/** Structural event shape: token-meter does not depend on dsh-goal or
 * dsh-llm-model-router declaration merging, so it reads events by
 * discriminant tag with a structural cast. */
interface StructuralEvent {
  type: string
  seq: number
  data: Record<string, unknown>
}

/** Cast a SessionEvent to a structural event for tag-based inspection. */
function asStructural(event: SessionEvent): StructuralEvent {
  return event as unknown as StructuralEvent
}

/** The route selection for one routing decision. */
export interface RoutingOutcomeRoute {
  provider: string
  model: string
  /** Who owned the decision: router, user, sdk, or policy. */
  authority: string
}

/** Token accounting and cost for one routing decision. */
export interface RoutingOutcomeAccounting {
  /** Number of paid attempts (including retries). */
  attempts: number
  inputTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  outputTokens: number
  reasoningTokens: number
  costUsd: number
  pricingVersion: string
  /** Whether the cost is exact or a conservative estimate. */
  costConfidence: 'exact' | 'conservative-estimate'
}

/** Tool execution quality for one routing decision's turn/step range. */
export interface RoutingOutcomeExecutionQuality {
  toolCalls: number
  toolFailures: number
  /** Number of repair iterations (goal rounds after a failed verification). */
  repairIterations: number
}

/** Verification outcome for one routing decision. */
export interface RoutingOutcomeOutcome {
  status: 'verified-pass' | 'verified-fail' | 'unverified' | 'incomplete'
  /** Verification score when the verifier produces one. */
  score?: number
  /** Number of criteria that passed. */
  criteriaPassed?: number
  /** Total number of criteria evaluated. */
  criteriaTotal?: number
  /** Outcome receipt hash when an evidence-backed receipt was emitted. */
  receiptId?: string
}

/** Provenance of a repair relationship between two routing decisions.
 * Explicit metadata is provider- or router-authoritative; inferred
 * relationships are derived from event ordering and must not be treated as
 * training truth without corroborating provenance.
 *
 * Explicit attribution is forward-compatible: the reader supports a
 * `repairOf` field on `model/routing-decision` events, but no current
 * producer writes it. Until a real producer exists, all non-`none`
 * attributions will be `inferred`. */
export type RepairAttribution =
  | { kind: 'explicit'; routingDecisionId: string }
  | { kind: 'inferred'; routingDecisionId: string }
  | { kind: 'none' }

/** One routing decision's full measurement: route + accounting + quality + outcome. */
export interface RoutingOutcome {
  routingDecisionId: string
  execution: {
    sessionId: string
    turn: number
    step: number
  }
  route: RoutingOutcomeRoute
  accounting: RoutingOutcomeAccounting
  executionQuality: RoutingOutcomeExecutionQuality
  outcome: RoutingOutcomeOutcome
  /** Provenance of the repair relationship, or `none` when this decision is not a repair. */
  repairAttribution: RepairAttribution
}

/** Structural workload features captured at routing decision time. */
export interface WorkloadFeatures {
  /** Prompt token estimate at the time of the routing decision. */
  promptTokens?: number
  /** Conversation token estimate up to this routing decision. */
  conversationTokens?: number
  /** Number of attached or retrieved files in context. */
  attachedFiles?: number
  /** Repository file count (when available). */
  repositoryFileCount?: number
  /** Number of tools visible to the model. */
  toolCount?: number
  /** Number of distinct tool classes invoked so far in the session. */
  toolClassesUsed?: number
  /** Repair iteration number (0 for initial attempt, 1+ for repairs). */
  repairIteration?: number
  /** Context utilization ratio (0–1) at the time of routing. */
  contextUtilization?: number
  /** Context budget features captured before the routing decision. These are
   * pre-decision features satisfying `featureSeq < routingDecisionSeq`. */
  context?: ContextWorkloadFeatures
}

/** A routing decision with its workload features and outcome. */
export interface RoutingOutcomeWithFeatures extends RoutingOutcome {
  features?: WorkloadFeatures
}

/** One routing decision event projected to its join-relevant fields. */
interface RoutingDecisionRecord {
  routingDecisionId: string
  turn: number
  step: number
  provider: string
  model: string
  authority: string
  seq: number
  /** Explicit repair-of metadata when the routing decision event carries it. */
  repairOf?: string
}

/** Extract routing decision records from the session event stream. */
function extractRoutingDecisions(events: readonly SessionEvent[]): RoutingDecisionRecord[] {
  const records: RoutingDecisionRecord[] = []
  for (const event of events) {
    const se = asStructural(event)
    if (se.type !== 'model/routing-decision') continue
    const data = se.data as {
      turn: number
      step: number
      routingDecisionId?: string
      selected: { provider: string; model: string }
      authority: string
      repairOf?: string
    }
    if (data.routingDecisionId !== undefined) {
      records.push({
        routingDecisionId: data.routingDecisionId,
        turn: data.turn,
        step: data.step,
        provider: data.selected.provider,
        model: data.selected.model,
        authority: data.authority,
        seq: se.seq,
        ...data.repairOf !== undefined ? { repairOf: data.repairOf } : {},
      })
    }
  }
  return records
}

/** Count tool calls and failures within a turn/step range. */
function countToolActivity(
  events: readonly SessionEvent[],
  turn: number,
  step: number,
): { toolCalls: number; toolFailures: number } {
  let toolCalls = 0
  let toolFailures = 0
  for (const event of events) {
    const se = asStructural(event)
    if (se.type === 'tool/call') {
      const data = se.data as { turn: number; step: number }
      if (data.turn === turn && data.step === step) toolCalls += 1
    } else if (se.type === 'tool/result') {
      const data = se.data as { turn: number; step: number; message: { content: Array<{ isError?: boolean }> } }
      if (data.turn === turn && data.step === step) {
        const isError = data.message.content.some(block => block.isError === true)
        if (isError) toolFailures += 1
      }
    }
  }
  return { toolCalls, toolFailures }
}

/** Find the verification outcome for a goal that overlaps the routing decision's turn.
 * Scans events after the routing decision's seq, stopping at the next routing
 * decision in the same turn so a repair decision does not inherit the prior
 * decision's verification result. */
function findVerificationOutcome(
  events: readonly SessionEvent[],
  turn: number,
  afterSeq: number,
): RoutingOutcomeOutcome {
  let outcome: RoutingOutcomeOutcome = { status: 'incomplete' }
  for (const event of events) {
    const se = asStructural(event)
    if (se.seq <= afterSeq) continue
    // Stop at the next routing decision in the same turn: it begins a new
    // execution scope whose verification belongs to that decision, not this one.
    if (se.type === 'model/routing-decision') {
      const data = se.data as { turn: number }
      if (data.turn === turn) break
    }
    if (se.type === 'goal/outcome-receipt') {
      const data = se.data as {
        overallVerdict: 'pass' | 'pass-with-warnings'
        criteria: Array<{ state: string }>
        receiptHash: string
      }
      const passed = data.criteria.filter(c => c.state === 'pass').length
      const total = data.criteria.length
      outcome = {
        status: 'verified-pass',
        criteriaPassed: passed,
        criteriaTotal: total,
        receiptId: data.receiptHash,
      }
    } else if (se.type === 'goal/verification') {
      const data = se.data as {
        passed: boolean
        checks: Array<{ passed: boolean }>
      }
      const passed = data.checks.filter(c => c.passed).length
      const total = data.checks.length
      // goal/verification is the final gate; it overrides outcome-receipt status.
      outcome = {
        status: data.passed ? 'verified-pass' : 'verified-fail',
        criteriaPassed: passed,
        criteriaTotal: total,
        ...outcome.receiptId !== undefined ? { receiptId: outcome.receiptId } : {},
      }
    } else if (se.type === 'turn/end') {
      const data = se.data as { turn: number; reason: { kind: string } }
      if (data.turn === turn) {
        if (outcome.status === 'incomplete') {
          // Turn ended without verification.
          outcome = { status: 'unverified' }
        }
        break
      }
    }
  }
  return outcome
}

/** Count repair iterations: goal rounds after a failed verification within this turn. */
function countRepairIterations(
  events: readonly SessionEvent[],
  turn: number,
): number {
  let repairs = 0
  let sawFailedVerification = false
  for (const event of events) {
    const se = asStructural(event)
    if (se.type === 'goal/verification') {
      const data = se.data as { passed: boolean }
      if (!data.passed) sawFailedVerification = true
    } else if (se.type === 'goal/change') {
      const data = se.data as { operation: string; goal: { roundsStarted?: number } }
      if (sawFailedVerification && data.operation === 'edit') {
        repairs += 1
        sawFailedVerification = false
      }
    } else if (se.type === 'turn/end') {
      const data = se.data as { turn: number }
      if (data.turn === turn) break
    }
  }
  return repairs
}

/**
 * Derive the repair attribution for a routing decision. Explicit metadata
 * (`repairOf` on the routing-decision event) is authoritative. When explicit
 * metadata is absent, inference requires all of:
 * - same session (guaranteed by construction)
 * - same turn
 * - a failed verification between the prior decision and this one
 * - no intervening user/task boundary (`user/message`, `turn/end`+`turn/start`)
 *
 * Inferred relationships preserve uncertainty: they must not be treated as
 * training truth without corroborating provenance.
 *
 * @param decisions - all routing decision records in the session.
 * @param current - the routing decision to attribute.
 * @param events - the full session event stream, for boundary verification.
 * @returns the repair attribution (`explicit`, `inferred`, or `none`).
 */
function deriveRepairAttribution(
  decisions: readonly RoutingDecisionRecord[],
  current: RoutingDecisionRecord,
  events: readonly SessionEvent[],
): RepairAttribution {
  if (current.repairOf !== undefined) {
    return { kind: 'explicit', routingDecisionId: current.repairOf }
  }
  for (const prior of decisions) {
    if (prior.turn !== current.turn) continue
    if (prior.seq >= current.seq) continue
    if (prior.routingDecisionId === current.routingDecisionId) continue
    if (hasFailedVerificationBetween(events, prior.seq, current.seq)
      && !hasInterveningBoundary(events, prior.seq, current.seq)) {
      return { kind: 'inferred', routingDecisionId: prior.routingDecisionId }
    }
  }
  return { kind: 'none' }
}

/** Whether a failed `goal/verification` event occurs between two seqs. */
function hasFailedVerificationBetween(
  events: readonly SessionEvent[],
  afterSeq: number,
  beforeSeq: number,
): boolean {
  for (const event of events) {
    const se = asStructural(event)
    if (se.seq <= afterSeq) continue
    if (se.seq >= beforeSeq) break
    if (se.type === 'goal/verification') {
      const data = se.data as { passed: boolean }
      if (!data.passed) return true
    }
  }
  return false
}

/** Whether a user/task boundary event occurs between two seqs. */
function hasInterveningBoundary(
  events: readonly SessionEvent[],
  afterSeq: number,
  beforeSeq: number,
): boolean {
  for (const event of events) {
    const se = asStructural(event)
    if (se.seq <= afterSeq) continue
    if (se.seq >= beforeSeq) break
    if (se.type === 'user/message' || se.type === 'turn/end' || se.type === 'turn/start') {
      return true
    }
  }
  return false
}

/**
 * Derive routing outcomes from the session event stream.
 *
 * Joins `model/routing-decision`, `model/usage`, `tool/call`/`tool/result`,
 * and `goal/verification`/`goal/outcome-receipt` events into one
 * `RoutingOutcome` per routing decision.
 * @param events - the full session event stream.
 * @param sessionId - the session id.
 * @param pricingRegistry - optional pricing registry for cost calculation.
 * @returns one `RoutingOutcome` per routing decision, in log order.
 */
export function deriveRoutingOutcomes(
  events: readonly SessionEvent[],
  sessionId: string,
  pricingRegistry?: readonly ModelPricing[],
): readonly RoutingOutcome[] {
  const decisions = extractRoutingDecisions(events)
  const usageRecords = extractUsageRecords(events, sessionId)
  const results: RoutingOutcome[] = []

  for (const decision of decisions) {
    // Find all model/usage records for this routing decision.
    const decisionUsage = usageRecords.filter(
      record => record.routingDecisionId === decision.routingDecisionId,
    )

    // Aggregate token usage.
    let inputTokens = 0
    let cacheHitTokens = 0
    let cacheMissTokens = 0
    let outputTokens = 0
    let reasoningTokens = 0
    let costUsd = 0
    let pricingVersion = ''
    let costConfidence: 'exact' | 'conservative-estimate' = 'conservative-estimate'

    for (const record of decisionUsage) {
      inputTokens += record.usage.inputTokens
      cacheHitTokens += record.usage.cacheReadTokens ?? 0
      cacheMissTokens += record.usage.cacheMissTokens ?? 0
      outputTokens += record.usage.outputTokens
      reasoningTokens += record.usage.reasoningTokens ?? 0
      if (pricingRegistry !== undefined) {
        const pricing = lookupPricing(pricingRegistry, record.provider, record.model)
        if (pricing !== undefined) {
          const cost = calculateCost(record.usage, pricing)
          costUsd += cost.amount
          pricingVersion = pricing.version
          costConfidence = cost.confidence
        }
      }
    }

    // Count tool activity for this turn/step.
    const { toolCalls, toolFailures } = countToolActivity(events, decision.turn, decision.step)

    // Find verification outcome (scoped to events after this routing decision).
    const outcome = findVerificationOutcome(events, decision.turn, decision.seq)

    // Count repair iterations.
    const repairIterations = countRepairIterations(events, decision.turn)

    // Derive repair attribution with provenance.
    const repairAttribution = deriveRepairAttribution(decisions, decision, events)

    results.push({
      routingDecisionId: decision.routingDecisionId,
      execution: {
        sessionId,
        turn: decision.turn,
        step: decision.step,
      },
      route: {
        provider: decision.provider,
        model: decision.model,
        authority: decision.authority,
      },
      accounting: {
        attempts: decisionUsage.length,
        inputTokens,
        cacheHitTokens,
        cacheMissTokens,
        outputTokens,
        reasoningTokens,
        costUsd,
        pricingVersion,
        costConfidence,
      },
      executionQuality: {
        toolCalls,
        toolFailures,
        repairIterations,
      },
      outcome,
      repairAttribution,
    })
  }

  return results
}

/** Task-level economics: aggregates all routing outcomes for one session/task. */
export interface TaskEconomics {
  /** Total cost across all routing decisions. */
  totalCostUsd: number
  /** Total paid model calls across all routing decisions. */
  totalModelCalls: number
  /** Total cost from Flash model calls. */
  flashCostUsd: number
  /** Total cost from Pro model calls. */
  proCostUsd: number
  /** Number of repair iterations. */
  repairs: number
  /** Whether the final verification passed. */
  finalVerifiedOutcome: boolean
  /** Number of routing decisions. */
  routingDecisions: number
}

/**
 * Derive task-level economics from routing outcomes.
 * @param outcomes - the routing outcomes for one session.
 * @returns aggregated task economics.
 */
export function deriveTaskEconomics(outcomes: readonly RoutingOutcome[]): TaskEconomics {
  let totalCostUsd = 0
  let totalModelCalls = 0
  let flashCostUsd = 0
  let proCostUsd = 0
  let repairs = 0
  let finalVerifiedOutcome = false

  for (const outcome of outcomes) {
    totalCostUsd += outcome.accounting.costUsd
    totalModelCalls += outcome.accounting.attempts
    if (outcome.route.model.includes('flash')) flashCostUsd += outcome.accounting.costUsd
    else if (outcome.route.model.includes('pro')) proCostUsd += outcome.accounting.costUsd
    repairs += outcome.executionQuality.repairIterations
    if (outcome.outcome.status === 'verified-pass') finalVerifiedOutcome = true
  }

  return {
    totalCostUsd,
    totalModelCalls,
    flashCostUsd,
    proCostUsd,
    repairs,
    finalVerifiedOutcome,
    routingDecisions: outcomes.length,
  }
}

/** Options for {@link deriveWorkloadFeatures}. */
export interface DeriveWorkloadFeaturesOptions {
  /** The routing decision's seq. Events at or after this seq are excluded
   * from feature derivation. This cutoff invariant ensures post-decision
   * events (including the decision's own outcome, usage, and verification)
   * cannot leak into pre-decision features. */
  cutoffSeq: number
}

/**
 * Derive workload features from the session event stream up to a routing
 * decision's cutoff. These structural signals are captured at routing decision
 * time so future learned routing has explanatory features correlated with
 * outcomes.
 *
 * Permanent ML-data invariant: `featureSeq < routingDecisionSeq`. Every
 * feature is derived from events with `seq < cutoffSeq`. The routing-decision
 * event itself must not feed its own feature vector. Post-decision events
 * (usage, verification, repair) cannot alter the returned features.
 *
 * @param events - the full session event stream.
 * @param options - `{ cutoffSeq }` naming the routing decision's seq.
 * @returns workload features computed from events before the routing decision.
 */
export function deriveWorkloadFeatures(
  events: readonly SessionEvent[],
  options: DeriveWorkloadFeaturesOptions,
): WorkloadFeatures {
  const { cutoffSeq } = options
  let conversationTokens = 0
  let toolClassesUsed = 0
  let repairIteration = 0
  const toolNames = new Set<string>()
  let sawFailedVerification = false
  let contextFeatures: ContextWorkloadFeatures | undefined

  for (const event of events) {
    const se = asStructural(event)
    if (se.seq >= cutoffSeq) break

    if (se.type === 'assistant/message') {
      // Approximate conversation tokens from provider usage when available.
      const data = se.data as { usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number } }
      if (data.usage?.totalTokens !== undefined) {
        conversationTokens = data.usage.totalTokens
      } else if (data.usage?.inputTokens !== undefined && data.usage?.outputTokens !== undefined) {
        conversationTokens += data.usage.inputTokens + data.usage.outputTokens
      }
    } else if (se.type === 'model/usage') {
      const data = se.data as { usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number } }
      if (data.usage?.totalTokens !== undefined) {
        conversationTokens = Math.max(conversationTokens, data.usage.totalTokens)
      }
    } else if (se.type === 'tool/call') {
      const data = se.data as { name: string }
      if (!toolNames.has(data.name)) {
        toolNames.add(data.name)
        toolClassesUsed += 1
      }
    } else if (se.type === 'goal/verification') {
      const data = se.data as { passed: boolean }
      if (!data.passed) sawFailedVerification = true
    } else if (se.type === 'goal/change') {
      const data = se.data as { operation: string }
      if (sawFailedVerification && data.operation === 'edit') {
        repairIteration += 1
        sawFailedVerification = false
      }
    } else if (se.type === 'model/context-preflight') {
      const data = se.data as {
        phase: 'pre-routing' | 'post-routing'
        estimatedInputTokens: number
        contextWindowTokens: number
        remainingTokens: number
        usageRatio: number
        estimatorId: string
        estimatorVersion: string
      }
      if (data.phase === 'pre-routing') {
        contextFeatures = {
          estimatedInputTokens: data.estimatedInputTokens,
          contextWindowTokens: data.contextWindowTokens,
          requestedOutputTokens: 0,
          remainingContextTokens: data.remainingTokens,
          contextUsageRatio: data.usageRatio,
          estimatorId: data.estimatorId,
          estimatorVersion: data.estimatorVersion,
        }
      }
    }
  }

  const features: WorkloadFeatures = {
    conversationTokens,
    toolClassesUsed,
    repairIteration,
    ...contextFeatures === undefined ? {} : { context: contextFeatures },
  }

  return features
}

/**
 * Derive routing outcomes with workload features attached.
 *
 * Combines {@link deriveRoutingOutcomes} with {@link deriveWorkloadFeatures} so
 * each routing outcome carries the structural signals that were present at
 * decision time.
 * @param events - the full session event stream.
 * @param sessionId - the session id.
 * @param pricingRegistry - optional pricing registry for cost calculation.
 * @returns one `RoutingOutcomeWithFeatures` per routing decision, in log order.
 */
export function deriveRoutingOutcomesWithFeatures(
  events: readonly SessionEvent[],
  sessionId: string,
  pricingRegistry?: readonly ModelPricing[],
): readonly RoutingOutcomeWithFeatures[] {
  const outcomes = deriveRoutingOutcomes(events, sessionId, pricingRegistry)
  return outcomes.map((outcome) => {
    const decisionSeq = events.find((e) => {
      const se = asStructural(e)
      if (se.type !== 'model/routing-decision') return false
      const data = se.data as { routingDecisionId?: string }
      return data.routingDecisionId === outcome.routingDecisionId
    })
    const seq = decisionSeq !== undefined ? asStructural(decisionSeq).seq : 0
    const features = deriveWorkloadFeatures(events, { cutoffSeq: seq })
    return { ...outcome, features }
  })
}
