/**
 * Runtime invariant for `@deepseek-ai/dsh-repair-controller`.
 *
 * @module @deepseek-ai/dsh-repair-controller/invariant
 */

import type { Context } from '@deepseek-ai/cordis'

/** No runtime invariant: the repair controller is a pure decision service with no owned data relationships. */
export default function invariant(_ctx: Context): void {
  // The repair controller holds no mutable state, owns no registries, and
  // has no event-stream relationships to assert. Its correctness is verified
  // by the deterministic test suite in tests/decide.spec.ts.
}
