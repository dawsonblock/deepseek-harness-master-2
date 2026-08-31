/**
 * Runtime invariant for `@deepseek-ai/dsh-repair-controller`.
 *
 * @module @deepseek-ai/dsh-repair-controller/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-repair-controller'

/** Cordis companion plugin name. */
export const name = 'repair-controller-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** No runtime invariant: the repair controller is a pure decision service with no owned data relationships. */
const install: InvariantInstaller = (_ctx, _fail) => {
  // The repair controller holds no mutable state, owns no registries, and
  // has no event-stream relationships to assert. Its correctness is verified
  // by the deterministic test suite in tests/decide.spec.ts.
}

/**
 * Register the repair-controller invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
