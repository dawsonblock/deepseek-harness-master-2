import type { VerifierCategory, VerifierDefinition, VerificationResult } from './types.js'
import { TrustedCheckRegistry, createTrustedCheckVerifier, type TrustedCheckResult } from './trusted-checks.js'

/** @deprecated Prefer TrustedCheckRegistry + createTrustedCheckVerifier. */
export interface TrustedNamedCheckResult extends TrustedCheckResult {}

/** @deprecated Prefer TrustedCheckRegistry. */
export interface TrustedNamedCheck {
  readonly version: string
  run(): TrustedNamedCheckResult | Promise<TrustedNamedCheckResult>
}

/**
 * Backward-compatible adapter for v0.9 callers. New code should register checks
 * on TrustedCheckRegistry so the allow-list itself can be fingerprinted.
 */
export function createTrustedNamedCheckVerifier(
  checks: Readonly<Record<string, TrustedNamedCheck | undefined>>,
  options: { readonly id?: string; readonly version?: string; readonly category?: VerifierCategory } = {},
): VerifierDefinition {
  const registry = new TrustedCheckRegistry()
  for (const [id, check] of Object.entries(checks)) {
    if (!check) continue
    registry.register({ id, version: check.version, run: () => check.run() })
  }
  const verifier = createTrustedCheckVerifier(registry, options)
  return {
    ...verifier,
    async verify(context, args): Promise<VerificationResult> {
      return verifier.verify(context, args)
    },
  }
}
