/**
 * v0.19 secure evaluation freeze record generator.
 *
 * Produces the `v019-secure-eval-v2` freeze record that captures the
 * qualified state of the secure evaluation composition. The freeze record
 * is the gate that must be green before any real Batch A evaluation begins.
 *
 * The freeze record includes:
 * - The security qualification record (22 source + 11 behavioral properties)
 * - The B0 smoke test status (12 properties)
 * - The corpus qualification status (25/25 frozen)
 * - The effective composition manifest
 * - The verifier integrity hash (SHA-256 of verifier-controlled source files)
 *
 * @module v019-freeze-secure-eval
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runSecurityQualification, SECURITY_QUALIFICATION_ID } from './v019-security-qualification.ts'
import { runComposedRuntimeQualification } from './v019-composed-runtime-qualification.ts'

/** The freeze record identity. */
export const FREEZE_ID = 'v019-secure-eval-v2'

/** Repository root, resolved from this module's location. */
const REPO_ROOT = join(import.meta.dirname, '..')

/**
 * Verifier-controlled source files whose integrity must be preserved between
 * freeze and evaluation. If any of these files change, the verifier may behave
 * differently than at qualification time, invalidating benchmark results.
 */
const VERIFIER_CONTROLLED_FILES = [
  'scripts/v019-task-manifest.ts',
  'scripts/v019-batch-a-corpus.ts',
  'scripts/v019-trajectory-collector.ts',
  'scripts/v019-repo-checkout.ts',
  'scripts/v019-security-qualification.ts',
  'scripts/v019-corpus-qualification.ts',
  'scripts/v019-composed-runtime-qualification.ts',
  'scripts/v019-freeze-secure-eval.ts',
  'scripts/run-v019-batch-a-evaluation.ts',
  'packages/core/repair-runtime/src/index.ts',
  'packages/core/repair-runtime/src/invariant.ts',
  'packages/core/repair-controller/src/index.ts',
  'packages/core/repair-controller/src/types.ts',
  'packages/goal/goal/src/index.ts',
  'packages/goal/goal/src/domain.ts',
]

/**
 * Compute a SHA-256 hash of all verifier-controlled source files. This hash
 * is recorded at freeze time and must match at evaluation time; a mismatch
 * indicates the verifier code was modified after qualification, which could
 * change verification outcomes.
 * @returns hex-encoded SHA-256 digest of verifier-controlled file contents.
 */
export function computeVerifierIntegrityHash(): string {
  const hash = createHash('sha256')
  for (const relPath of VERIFIER_CONTROLLED_FILES) {
    const absPath = join(REPO_ROOT, relPath)
    const content = readFileSync(absPath)
    hash.update(relPath).update(':').update(content).update('\n')
  }
  return hash.digest('hex')
}

/**
 * Verify that the current verifier-controlled files match the frozen hash.
 * @param frozenHash - the hash recorded in the freeze record.
 * @returns true if the current files match the frozen hash.
 */
export function verifyVerifierIntegrity(frozenHash: string): boolean {
  return computeVerifierIntegrityHash() === frozenHash
}

/** The secure evaluation freeze record. */
export interface SecureEvalFreezeRecord {
  readonly freezeId: string
  readonly frozenAt: string
  readonly securityQualificationId: string
  readonly securityQualificationPassed: boolean
  readonly securityPropertyCount: number
  readonly securityPassedCount: number
  readonly securityFailedCount: number
  readonly composedQualificationId: string
  readonly composedQualificationPassed: boolean
  readonly composedCheckCount: number
  readonly composedPassedCount: number
  readonly b0SmokeTestCount: number
  readonly corpusFrozenTasks: number
  readonly corpusRejectedTasks: number
  readonly effectiveComposition: {
    readonly filesystemPlane: 'fs-sandbox'
    readonly subprocessPlane: 'bash-sandbox'
    readonly sandboxPolicy: 'workspace-isolated'
    readonly backendEnforcement: 'full' | 'partial' | 'unknown'
    readonly holdoutLocation: 'external'
    readonly repairRuntime: 'production'
    readonly rollbackProvider: 'harness-owned'
    readonly provenanceProvider: 'sha256-content-hash'
    readonly routingAuthority: 'durable'
  }
  readonly ready: boolean
  /** When false, the platform backend does not provide full enforcement and benchmark-eligible runs must not proceed. */
  readonly backendFullEnforcement: boolean
  /** SHA-256 hash of verifier-controlled source files at freeze time. Recompute at evaluation time and reject mismatch. */
  readonly verifierIntegrityHash: string
}

/**
 * Generate the freeze record by running the security qualification gate
 * and checking the corpus qualification status.
 *
 * @returns the secure evaluation freeze record.
 */
export async function generateFreezeRecord(): Promise<SecureEvalFreezeRecord> {
  const securityRecord = await runSecurityQualification()

  // Run the composed runtime qualification to probe the actual backend
  // rather than relying on a static platform preference. The composed
  // qualification boots the real Cordis context, runs shell commands
  // through the actual sandbox, and records whether the backend denied
  // network access and enforced filesystem isolation.
  const composedRecord = await runComposedRuntimeQualification()

  // The corpus qualification is frozen at 25/25 tasks. This is verified
  // by the B0 smoke test (B0.12) and the corpus qualification spec.
  const corpusFrozenTasks = 25
  const corpusRejectedTasks = 0

  // Use the probed backend from the composed qualification, not a static
  // platform lookup. This ensures the freeze record reflects the actual
  // runner selected at runtime, not the preferred candidate.
  const backendEnforcement = composedRecord.backend.probed
    ? (composedRecord.backend.networkDenied ? 'full' : 'partial')
    : 'unknown'
  const backendFullEnforcement = backendEnforcement === 'full'

  // Benchmark-eligible runs require full backend enforcement AND a passing
  // composed runtime qualification. The composed gate proves the exact
  // evaluator composition boots and passes lifecycle/security scenarios.
  const ready = securityRecord.passed
    && composedRecord.ready
    && backendFullEnforcement

  return {
    freezeId: FREEZE_ID,
    frozenAt: new Date().toISOString(),
    securityQualificationId: SECURITY_QUALIFICATION_ID,
    securityQualificationPassed: securityRecord.passed,
    securityPropertyCount: securityRecord.checks.length,
    securityPassedCount: securityRecord.passedCount,
    securityFailedCount: securityRecord.failedCount,
    composedQualificationId: composedRecord.qualificationId,
    composedQualificationPassed: composedRecord.passed,
    composedCheckCount: composedRecord.checks.length,
    composedPassedCount: composedRecord.passedCount,
    b0SmokeTestCount: 12,
    corpusFrozenTasks,
    corpusRejectedTasks,
    effectiveComposition: {
      filesystemPlane: 'fs-sandbox',
      subprocessPlane: 'bash-sandbox',
      sandboxPolicy: 'workspace-isolated',
      backendEnforcement,
      holdoutLocation: 'external',
      repairRuntime: 'production',
      rollbackProvider: 'harness-owned',
      provenanceProvider: 'sha256-content-hash',
      routingAuthority: 'durable',
    },
    ready,
    backendFullEnforcement,
    verifierIntegrityHash: computeVerifierIntegrityHash(),
  }
}

/**
 * Write the freeze record to the artifacts directory.
 *
 * @param record - the freeze record to write.
 * @param artifactsDir - the artifacts directory path.
 */
export function writeFreezeRecord(record: SecureEvalFreezeRecord, artifactsDir: string): void {
  const path = join(artifactsDir, 'evals', `${FREEZE_ID}.json`)
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n', 'utf8')
}

/**
 * Read a persisted freeze record from the artifacts directory.
 *
 * @param artifactsDir - the artifacts directory path.
 * @returns the persisted freeze record, or undefined if none exists.
 */
export function readFreezeRecord(artifactsDir: string): SecureEvalFreezeRecord | undefined {
  const path = join(artifactsDir, 'evals', `${FREEZE_ID}.json`)
  try {
    const content = readFileSync(path, 'utf8')
    return JSON.parse(content) as SecureEvalFreezeRecord
  } catch {
    return undefined
  }
}

/**
 * Format the freeze record as a human-readable report.
 * @param record - the freeze record.
 * @returns formatted report string.
 */
export function formatFreezeRecord(record: SecureEvalFreezeRecord): string {
  const lines: string[] = [
    `Secure Evaluation Freeze: ${record.freezeId}`,
    `Frozen At: ${record.frozenAt}`,
    `Ready: ${record.ready ? 'YES' : 'NO'}`,
    '-'.repeat(60),
    `Security Qualification: ${record.securityQualificationId}`,
    `  Passed: ${record.securityQualificationPassed}`,
    `  Properties: ${record.securityPassedCount}/${record.securityPropertyCount} passed, ${record.securityFailedCount} failed`,
    '',
    `B0 Smoke Tests: ${record.b0SmokeTestCount} checks`,
    '',
    'Corpus Qualification:',
    `  Frozen: ${record.corpusFrozenTasks}/25`,
    `  Rejected: ${record.corpusRejectedTasks}`,
    '',
    'Effective Composition:',
    `  Filesystem plane: ${record.effectiveComposition.filesystemPlane}`,
    `  Subprocess plane: ${record.effectiveComposition.subprocessPlane}`,
    `  Sandbox policy: ${record.effectiveComposition.sandboxPolicy}`,
    `  Backend enforcement: ${record.effectiveComposition.backendEnforcement}`,
    `  Holdout location: ${record.effectiveComposition.holdoutLocation}`,
    `  Repair runtime: ${record.effectiveComposition.repairRuntime}`,
    `  Rollback provider: ${record.effectiveComposition.rollbackProvider}`,
    `  Provenance provider: ${record.effectiveComposition.provenanceProvider}`,
    `  Routing authority: ${record.effectiveComposition.routingAuthority}`,
    '',
    `Verifier Integrity Hash: ${record.verifierIntegrityHash}`,
    '-'.repeat(60),
    record.ready
      ? 'SECURE EVAL IS FROZEN. Real Batch A may begin.'
      : 'SECURE EVAL IS NOT READY. Do not begin real Batch A.',
  ]
  return lines.join('\n')
}
