/**
 * Runtime invariant for `@deepseek-ai/dsh-agent-kernel-hardening`.
 *
 * @module @deepseek-ai/dsh-agent-kernel-hardening/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-agent-kernel-hardening'

/** Cordis companion plugin name. */
export const name = 'agent-kernel-hardening-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/**
 * No runtime invariant: agent-kernel-hardening is a replay-derived analysis
 * and ablation diagnostics library with no owned event-stream relationships.
 * Its correctness is verified by the deterministic test suite in tests/.
 */
const install: InvariantInstaller = (_ctx, _fail) => {
  // Agent-kernel-hardening holds no mutable session state, owns no registries,
  // and has no event-stream relationships to assert. Replay-derived recovery
  // and ablation diagnostics are pure functions of session event inputs.
}

/**
 * Register the agent-kernel-hardening invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
