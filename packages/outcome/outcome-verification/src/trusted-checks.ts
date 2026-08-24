import { hashCanonical } from './canonical.js'
import type { EvidenceDependency, VerificationContext, VerificationResult, VerifierCategory, VerifierDefinition } from './types.js'

export interface TrustedCheckResult {
  readonly passed: boolean
  readonly reason: string
  readonly result?: unknown
  readonly sourceEventSeqs?: readonly number[]
  readonly dependencies?: readonly EvidenceDependency[]
}

export interface TrustedCheck {
  readonly id: string
  readonly version: string
  run(context: VerificationContext): TrustedCheckResult | Promise<TrustedCheckResult>
}

/**
 * Deployment-owned allow-list of reviewed checks. Contracts reference stable
 * check ids; they never embed arbitrary shell strings into acceptance data.
 */
export class TrustedCheckRegistry {
  private readonly checks = new Map<string, TrustedCheck>()

  register(check: TrustedCheck): () => void {
    if (!check.id.trim()) throw new Error('trusted check id must be non-empty')
    if (!check.version.trim()) throw new Error(`trusted check ${check.id} version must be non-empty`)
    if (this.checks.has(check.id)) throw new Error(`trusted check already registered: ${check.id}`)
    this.checks.set(check.id, check)
    return () => { this.checks.delete(check.id) }
  }

  resolve(id: string): TrustedCheck {
    const check = this.checks.get(id)
    if (!check) throw new Error(`trusted check is not registered: ${id}`)
    return check
  }

  list(): readonly TrustedCheck[] {
    return [...this.checks.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  fingerprint(): string {
    return hashCanonical(this.list().map(check => ({ id: check.id, version: check.version })))
  }
}

export function createTrustedCheckVerifier(
  checks: TrustedCheckRegistry,
  options: { readonly id?: string; readonly version?: string; readonly category?: VerifierCategory } = {},
): VerifierDefinition {
  return {
    id: options.id ?? 'trusted-check.pass',
    version: options.version ?? '2',
    category: options.category ?? 'acceptance',
    deterministic: true,
    async verify(context, args): Promise<VerificationResult> {
      const checkId = args['check']
      if (typeof checkId !== 'string' || checkId.length === 0) {
        return { passed: false, reason: 'trusted check id is required', source: 'tool' }
      }
      let check: TrustedCheck
      try { check = checks.resolve(checkId) }
      catch (error: unknown) {
        return { passed: false, reason: error instanceof Error ? error.message : String(error), source: 'tool' }
      }
      const result = await check.run(context)
      return {
        passed: result.passed,
        reason: `${check.id}@${check.version}: ${result.reason}`,
        source: 'tool',
        result: result.result ?? null,
        sourceEventSeqs: result.sourceEventSeqs ?? [],
        dependencies: result.dependencies ?? [{ kind: 'runtime', key: `trusted-check:${check.id}`, version: check.version }],
      }
    },
  }
}
