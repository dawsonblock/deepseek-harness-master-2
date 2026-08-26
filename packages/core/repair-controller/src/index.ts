/**
 * Cordis service for repair/escalation decisions. The service is a thin
 * wrapper around the pure {@link decideRepair} function — it holds no state
 * and makes no model calls, file mutations, or event writes. The agent loop
 * orchestrates the controller; the controller does not orchestrate the loop.
 *
 * @module @deepseek-ai/dsh-repair-controller
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import { decideRepair } from './decide.ts'
import type { RepairDecision, RepairDecisionInput, RepairLimits } from './types.ts'
import { DEFAULT_REPAIR_LIMITS } from './types.ts'

/**
 * The repair-controller service (`ctx.repairController`). A pure decision
 * service that returns the next action after a verification result. The
 * caller (agent loop) is responsible for executing the decision, running
 * verification, and persisting events.
 */
export class RepairControllerService extends Service {
  static readonly inject = [] as const

  readonly limits: RepairLimits

  constructor(ctx: Context, config: { limits?: RepairLimits } = {}) {
    super(ctx, 'repairController')
    this.limits = config.limits ?? DEFAULT_REPAIR_LIMITS
  }

  /**
   * Decide the next repair action. Pure and deterministic.
   * @param input - attempt history, latest failure, and budget.
   * @returns the next action: complete, flash-repair, pro-escalate, or stop.
   */
  decide(input: Omit<RepairDecisionInput, 'limits'>): RepairDecision {
    return decideRepair({ ...input, limits: this.limits })
  }
}

export { decideRepair, computeFailureFingerprint, classifyProgress, normalizeFailureText, countFailures, isSameFailure, classifyProviderFailure, computeFailurePackageId, computeProgressMetrics } from './decide.ts'
export { isLegalTransition, assertLegalTransition, stateFromDecision } from './state-machine.ts'
export type { RepairState } from './state-machine.ts'
export {
  evidenceFollowsVerification,
  decisionFollowsEvidence,
  escalationFollowsDecision,
  newRoutingFollowsEscalation,
  findDuplicateEvidence,
  findDuplicateDecisions,
  findDuplicateEscalations,
  verifyEventOrdering,
} from './event-ordering.ts'
export { DEFAULT_REPAIR_LIMITS } from './types.ts'
export type {
  ModelRef,
  ProgressClass,
  ProgressMetrics,
  VerificationStatus,
  FailurePackage,
  RepairAttempt,
  RepairLimits,
  RepairBudget,
  EscalationReason,
  StopReason,
  ProviderFailureKind,
  ProviderFailure,
  RepairDecision,
  RepairDecisionInput,
  RepairEvidenceEventData,
  RepairDecisionEventData,
  ModelEscalationEventData,
  RepairCompletedEventData,
} from './types.ts'
