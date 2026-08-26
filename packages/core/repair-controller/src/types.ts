/**
 * Type definitions for the repair controller. Pure types only — no runtime
 * code. The {@link RepairController} service consumes these to make
 * deterministic repair and escalation decisions after verification failure.
 *
 * @module @deepseek-ai/dsh-repair-controller/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/** A provider/model pair identifying one model endpoint. */
export interface ModelRef {
  readonly provider: string
  readonly model: string
}

/** Progress classification for a failed attempt relative to prior attempts. */
export type ProgressClass = 'none' | 'partial' | 'regression' | 'resolved'

/** Verification status for one repair attempt. */
export type VerificationStatus = 'verified-pass' | 'verified-fail' | 'unverified' | 'incomplete'

/** Objective verification evidence collected from a failed attempt. */
export interface FailurePackage {
  readonly failedCriteria: readonly string[]
  readonly failingTests: readonly string[]
  readonly typeErrors: readonly string[]
  readonly buildErrors: readonly string[]
  readonly changedFiles: readonly string[]
}

/** One completed repair attempt's evidence for deterministic decisions. */
export interface RepairAttempt {
  /** 1-based attempt number within the repair sequence. */
  readonly attempt: number
  readonly model: ModelRef
  /** Joins to the `model/routing-decision` event for this attempt. */
  readonly routingDecisionId: string
  readonly verified: boolean
  readonly verificationStatus: VerificationStatus
  /** Deterministic hash of the failure evidence; absent on pass. */
  readonly failureFingerprint?: string
  /** Progress relative to the prior failed attempt; absent on first or pass. */
  readonly progress?: ProgressClass
  readonly failurePackage?: FailurePackage
  /** Deterministic ID for the failure package; absent on pass. */
  readonly failurePackageId?: string
  readonly costUsd: number
  readonly latencyMs: number
}

/** Runtime-owned hard limits. The model cannot increase these. */
export interface RepairLimits {
  readonly maxFlashAttempts: number
  readonly maxProAttempts: number
  readonly maxTotalAttempts: number
  /** Maximum cumulative cost per task in USD. */
  readonly maxTaskCostUsd?: number
  /** Maximum elapsed time per task in milliseconds. */
  readonly maxElapsedMs?: number
  /** Maximum output tokens per task. */
  readonly maxOutputTokens?: number
}

export const DEFAULT_REPAIR_LIMITS: RepairLimits = {
  maxFlashAttempts: 3,
  maxProAttempts: 2,
  maxTotalAttempts: 5,
}

/**
 * Quantitative progress metrics stored alongside a progress
 * classification. Enables post-hoc debugging of repair decisions.
 */
export interface ProgressMetrics {
  readonly priorFailureCount: number
  readonly currentFailureCount: number
  readonly intersectionCount: number
  readonly unionCount: number
  readonly jaccard: number
  readonly newFailureCount: number
  readonly resolvedFailureCount: number
}

/** Cost and time budget for the repair sequence. */
export interface RepairBudget {
  readonly totalCostUsd: number
  readonly elapsedMs: number
}

/** Why a Pro escalation was chosen. */
export type EscalationReason =
  | 'same-failure-no-progress'
  | 'flash-limit-exhausted'
  | 'regression-detected'

/** Why the repair sequence stopped. */
export type StopReason =
  | 'attempt-limit'
  | 'cost-limit'
  | 'time-limit'
  | 'verification-impossible'
  | 'pro-exhausted'
  | 'escalation-model-unavailable'

/**
 * Canonical provider failure kind. Classifies HTTP and transport errors
 * so the repair loop can distinguish abort-worthy failures from
 * retryable ones without parsing raw error text.
 */
export type ProviderFailureKind =
  | 'authentication'
  | 'authorization'
  | 'rate-limit'
  | 'billing'
  | 'timeout'
  | 'network'
  | 'server'
  | 'invalid-request'
  | 'empty-response'
  | 'protocol'
  | 'unknown'

/**
 * Canonical provider failure record. Produced by classifying raw
 * provider errors before the repair loop sees them. The repair loop
 * uses {@link ProviderFailure.retryable} to decide whether to
 * checkpoint-and-resume or abort.
 */
export interface ProviderFailure {
  readonly provider: string
  readonly model?: string
  readonly kind: ProviderFailureKind
  readonly httpStatus?: number
  readonly providerCode?: string
  readonly retryable: boolean
  readonly requestId?: string
  readonly message: string
}

/** The decision returned by {@link RepairController.decide}. */
export type RepairDecision =
  | { readonly action: 'complete' }
  | { readonly action: 'flash-repair'; readonly evidence: FailurePackage }
  | { readonly action: 'pro-escalate'; readonly evidence: FailurePackage; readonly reason: EscalationReason }
  | { readonly action: 'stop'; readonly reason: StopReason }

/** Input to {@link RepairController.decide}. */
export interface RepairDecisionInput {
  readonly sessionId: SessionId
  readonly turn: number
  readonly step: number
  readonly initialModel: ModelRef
  readonly currentModel: ModelRef
  readonly attempts: readonly RepairAttempt[]
  readonly latestFailure?: FailurePackage
  readonly budget: RepairBudget
  readonly limits: RepairLimits
  /** Whether the Pro model is available for escalation. Default: true. */
  readonly proModelAvailable?: boolean
  /** Whether the current model was manually selected by the user. */
  readonly manualModelSelection?: boolean
}

/**
 * Durable record of failure evidence for one repair attempt. Emitted as the
 * `repair/evidence` session event.
 */
export interface RepairEvidenceEventData {
  readonly repairId: string
  readonly turn: number
  readonly step: number
  readonly attempt: number
  readonly routingDecisionId: string
  readonly failureFingerprint: string
  /** Deterministic ID for idempotent event emission on restart. */
  readonly failurePackageId?: string
  readonly progress: ProgressClass
  readonly failedCriteria: readonly string[]
  readonly failingTests: readonly string[]
  readonly typeErrors: readonly string[]
  readonly buildErrors: readonly string[]
  readonly changedFiles: readonly string[]
}

/**
 * Durable record of one repair controller decision. Emitted as the
 * `repair/decision` session event.
 */
export interface RepairDecisionEventData {
  readonly repairId: string
  readonly turn: number
  readonly step: number
  readonly attempt: number
  readonly action: 'flash-repair' | 'pro-escalate' | 'complete' | 'stop'
  readonly reason?: EscalationReason | StopReason
  readonly failureFingerprint?: string
}

/**
 * Durable record of a model escalation from Flash to Pro within a repair
 * sequence. Emitted as the `model/escalation` session event. Gives
 * `RoutingOutcome` explicit repair provenance instead of inference.
 */
export interface ModelEscalationEventData {
  readonly repairId: string
  readonly turn: number
  readonly step: number
  readonly fromRoutingDecisionId: string
  readonly toRoutingDecisionId: string
  /** The routing decision being repaired. */
  readonly repairOf: string
  readonly fromModel: string
  readonly toModel: string
  readonly reason: EscalationReason
  readonly failureFingerprint: string
  readonly flashAttempts: number
}

/**
 * Durable record of repair sequence completion. Emitted as the
 * `repair/completed` session event. Provides task-level accounting.
 */
export interface RepairCompletedEventData {
  readonly repairId: string
  readonly turn: number
  readonly step: number
  readonly finalRoutingDecisionId: string
  readonly verified: boolean
  readonly totalAttempts: number
  readonly flashAttempts: number
  readonly proAttempts: number
  readonly totalCostUsd: number
  readonly elapsedMs: number
}
