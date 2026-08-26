/**
 * Session event declarations for the repair controller. These are added to
 * `SessionEventMap` via declaration merging so the session log can carry
 * repair evidence, decisions, escalations, and completion records.
 *
 * @module @deepseek-ai/dsh-repair-controller/events
 */

import type {
  RepairEvidenceEventData,
  RepairDecisionEventData,
  ModelEscalationEventData,
  RepairCompletedEventData,
} from './types.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Failure evidence collected after one verified-failed repair attempt.
     * @mode durable
     * @param repairId - the repair sequence this evidence belongs to.
     * @param attempt - 1-based attempt number within the repair sequence.
     * @param routingDecisionId - joins to the `model/routing-decision` for this attempt.
     * @param failureFingerprint - deterministic hash of the failure evidence.
     * @param progress - progress classification relative to the prior failed attempt.
     */
    'repair/evidence': RepairEvidenceEventData

    /**
     * One repair controller decision after verification.
     * @mode durable
     * @param repairId - the repair sequence this decision belongs to.
     * @param action - what the controller decided: flash-repair, pro-escalate, complete, or stop.
     */
    'repair/decision': RepairDecisionEventData

    /**
     * Model escalation from Flash to Pro within a repair sequence. Gives
     * `RoutingOutcome` explicit repair provenance instead of inference.
     * @mode durable
     * @param repairId - the repair sequence this escalation belongs to.
     * @param fromRoutingDecisionId - the Flash routing decision being repaired.
     * @param toRoutingDecisionId - the Pro routing decision taking over.
     * @param repairOf - the routing decision being repaired (same as fromRoutingDecisionId for the first escalation).
     */
    'model/escalation': ModelEscalationEventData

    /**
     * Repair sequence completion with task-level accounting.
     * @mode durable
     * @param repairId - the repair sequence that completed.
     * @param verified - whether the final attempt passed verification.
     * @param totalAttempts - total attempts across Flash and Pro.
     * @param totalCostUsd - cumulative cost across all attempts.
     */
    'repair/completed': RepairCompletedEventData
  }
}
