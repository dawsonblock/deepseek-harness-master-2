/**
 * Runtime invariant for `@deepseek-ai/dsh-runtime-performance-telemetry`.
 *
 * @module @deepseek-ai/dsh-runtime-performance-telemetry/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-runtime-performance-telemetry'

/** Cordis companion plugin name. */
export const name = 'runtime-performance-telemetry-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: performance telemetry is a read-only observation
 * service with no owned event-stream relationships. Its correctness is
 * verified by the deterministic test suite in tests/.
 */
const install: InvariantInstaller = (_ctx, _fail) => {
  // Performance telemetry observes turn, context-composition, model-wait, and
  // tool-interval timing without owning mutable state or event-stream
  // relationships. Telemetry emission is a pure projection of observed events.
}

/**
 * Register the runtime-performance-telemetry invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
