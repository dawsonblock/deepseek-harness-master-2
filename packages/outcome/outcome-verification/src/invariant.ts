/**
 * Runtime invariant for `@deepseek-ai/dsh-outcome-verification`.
 *
 * @module @deepseek-ai/dsh-outcome-verification/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-outcome-verification'

/** Cordis companion plugin name. */
export const name = 'outcome-verification-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: outcome verification is a pure acceptance-pack
 * evaluation library with no owned event-stream relationships. Its
 * correctness is verified by the deterministic test suite in tests/.
 */
const install: InvariantInstaller = (_ctx, _fail) => {
  // Outcome verification holds no mutable session state, owns no registries,
  // and has no event-stream relationships to assert. Acceptance pack
  // evaluation is a pure function of pack inputs and trusted-check results.
}

/**
 * Register the outcome-verification invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
