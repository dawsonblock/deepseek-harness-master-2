/**
 * Runtime invariant for `@deepseek-ai/dsh-runtime-resource-governor`.
 *
 * @module @deepseek-ai/dsh-runtime-resource-governor/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-runtime-resource-governor'

/** Cordis companion plugin name. */
export const name = 'runtime-resource-governor-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: the resource governor is a pure admission decision
 * service with no owned event-stream relationships. Its correctness is
 * verified by the deterministic test suite in tests/.
 */
const install: InvariantInstaller = (_ctx, _fail) => {
  // The resource governor holds no mutable session state, owns no registries,
  // and has no event-stream relationships to assert. Subagent admission and
  // resource accounting are pure functions of the current resource state.
}

/**
 * Register the runtime-resource-governor invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
