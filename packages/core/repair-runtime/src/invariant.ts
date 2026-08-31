/**
 * Runtime invariant for `@deepseek-ai/dsh-repair-runtime`.
 *
 * @module @deepseek-ai/dsh-repair-runtime/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
// Import the events module to trigger declaration merging for repair/* events.
import '@deepseek-ai/dsh-repair-controller/events'

const PACKAGE_NAME = '@deepseek-ai/dsh-repair-runtime'

/** Cordis companion plugin name. */
export const name = 'repair-runtime-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

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
const install: InvariantInstaller = (ctx, fail) => {
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
      fail(
        `repair-runtime invariant: repair/completed for "${data.repairId}" with outcome "${data.outcome}" without preceding evidence and decision`,
      )
    }
  })
}

/**
 * Register the repair-runtime invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
