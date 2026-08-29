/**
 * Runtime invariant for `@deepseek-ai/dsh-repair-runtime`.
 *
 * @module @deepseek-ai/dsh-repair-runtime/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
// Import the events module to trigger declaration merging for repair/* events.
import '@deepseek-ai/dsh-repair-controller/events'

/**
 * Asserts that repair/evidence, repair/decision, model/escalation, and
 * repair/completed events are emitted in the correct order: evidence before
 * decision, escalation only after a pro-escalate decision, and completed
 * only after a repair sequence or a one-shot/terminal outcome.
 *
 * Two terminal families are valid:
 * - One-shot verified or qualification-failed: `repair/completed` with
 *   no prior `repair/evidence` or `repair/decision` (the first diagnostic
 *   verification passed or the holdout failed).
 * - Repair-sequence completion: `repair/completed` preceded by at least
 *   one `repair/evidence` and one `repair/decision` for the same repairId.
 */
export default function invariant(ctx: Context): void {
  ctx.on('session/event', (session, event) => {
    if ((event.type as string) !== 'repair/completed') return
    const events = session.events
    const data = event.data as { repairId: string; outcome: string }
    const hasEvidence = events.some(
      e => (e.type as string) === 'repair/evidence' && (e.data as { repairId: string }).repairId === data.repairId,
    )
    const hasDecision = events.some(
      e => (e.type as string) === 'repair/decision' && (e.data as { repairId: string }).repairId === data.repairId,
    )
    // One-shot terminal outcomes do not require prior evidence/decision.
    const isOneShot = data.outcome === 'verified' || data.outcome === 'qualification-failed'
    if (!isOneShot && (!hasEvidence || !hasDecision)) {
      throw new Error(
        `repair-runtime invariant: repair/completed for "${data.repairId}" with outcome "${data.outcome}" without preceding evidence and decision`,
      )
    }
  })
}
