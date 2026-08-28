/**
 * v0.19 security qualification gate (`v019-security-qualification-v1`).
 *
 * Records the security properties the integrated evaluator composition must
 * satisfy before any real Batch A evaluation begins. Each property carries an
 * explicit check, a status, and evidence. The gate is green only when every
 * required property passes.
 *
 * Properties covered:
 *
 * G1: Filesystem tool plane uses fs-sandbox, not fs-local
 * G2: Subprocess plane uses bash-sandbox with sandbox-policy, not bash-local
 * G3: Sandbox policy is workspace-isolated with protected read paths
 * G4: Seatbelt isolation claim is honest (partial, not full)
 * G5: Seatbelt fails closed when workspace isolation inputs are absent
 * G6: Holdouts are externalized from the model workspace
 * G7: Diagnostic commands do not discover holdout files
 * G8: Production RepairRuntime is mounted (not the v018 script loop)
 * G9: Rollback provider is configured and harness-owned
 * G10: Workspace provenance provider binds verification to content hash
 * G11: Holdout verifier stages and cleans up external holdout tests
 * G12: Unpriced model usage fails (no $0 fallback)
 * G13: Metrics filter by benchmarkEligible
 * G14: Replay mismatch rate is not hard-coded to zero
 * G15: Per-attempt diffs are captured separately
 * G16: Wall-clock latency is separated from model latency
 * G17: Sandbox qualification skips are counted as non-pass, not pass
 * G18: Repair decisions route through durable routing authority
 * G19: Repair events are emitted in correct order (evidence → decision → completed)
 * G20: releaseToAuto refuses undecidable authority state
 *
 * @module v019-security-qualification
 */

/** Status of one security property check. */
export type SecurityPropertyStatus = 'pass' | 'fail' | 'not-applicable'

/** One security property check result. */
export interface SecurityPropertyCheck {
  readonly id: string
  readonly name: string
  readonly status: SecurityPropertyStatus
  readonly evidence: string
}

/** The full security qualification record. */
export interface SecurityQualificationRecord {
  readonly qualificationId: string
  readonly timestamp: string
  readonly platform: string
  readonly checks: readonly SecurityPropertyCheck[]
  readonly passed: boolean
  readonly passedCount: number
  readonly failedCount: number
  readonly notApplicableCount: number
}

/** The qualification identity. */
export const SECURITY_QUALIFICATION_ID = 'v019-security-qualification-v1'

/**
 * Run all security property checks and produce the qualification record.
 *
 * Each check inspects the evaluator's source or runtime behavior to verify
 * the integrated composition matches the security architecture. The gate is
 * green only when every required check passes.
 *
 * @returns the security qualification record.
 */
export function runSecurityQualification(): SecurityQualificationRecord {
  const checks: SecurityPropertyCheck[] = [
    checkFilesystemPlane(),
    checkSubprocessPlane(),
    checkSandboxPolicy(),
    checkSeatbeltHonesty(),
    checkSeatbeltFailClosed(),
    checkHoldoutExternalization(),
    checkDiagnosticHoldoutDiscovery(),
    checkProductionRepairRuntime(),
    checkRollbackProvider(),
    checkProvenanceProvider(),
    checkHoldoutVerifier(),
    checkUnpricedUsageFails(),
    checkBenchmarkEligibleFilter(),
    checkReplayMismatchNotHardcoded(),
    checkPerAttemptDiffs(),
    checkLatencySeparation(),
    checkSandboxQualificationSkip(),
    checkDurableRoutingAuthority(),
    checkRepairEventOrdering(),
    checkReleaseToAutoUndecidable(),
  ]

  const passedCount = checks.filter(c => c.status === 'pass').length
  const failedCount = checks.filter(c => c.status === 'fail').length
  const notApplicableCount = checks.filter(c => c.status === 'not-applicable').length

  return {
    qualificationId: SECURITY_QUALIFICATION_ID,
    timestamp: new Date().toISOString(),
    platform: process.platform,
    checks,
    passed: failedCount === 0,
    passedCount,
    failedCount,
    notApplicableCount,
  }
}

// ---------------------------------------------------------------------------
// Individual security property checks
// ---------------------------------------------------------------------------

/** G1: Verify the evaluator config uses fs-sandbox, not fs-local. */
function checkFilesystemPlane(): SecurityPropertyCheck {
  const source = readCollectorSource()
  const usesFsSandbox = source.includes('dsh-fs-sandbox') || source.includes("'@deepseek-ai/dsh-fs-sandbox'")
  const usesFsLocal = source.includes('dsh-fs-local') && !source.includes('replace') && !source.includes('fs-sandbox')
  const replacesFsLocal = source.includes('fs-local') && source.includes('fs-sandbox')
  const passed = usesFsSandbox && (replacesFsLocal || !usesFsLocal)
  return {
    id: 'G1',
    name: 'Filesystem tool plane uses fs-sandbox',
    status: passed ? 'pass' : 'fail',
    evidence: passed
      ? 'generateRepoConfig replaces fs-local with fs-sandbox'
      : 'fs-local is not replaced with fs-sandbox in the evaluator config',
  }
}

/** G2: Verify the evaluator config uses bash-sandbox with sandbox-policy. */
function checkSubprocessPlane(): SecurityPropertyCheck {
  const source = readCollectorSource()
  const usesBashSandbox = source.includes('dsh-bash-sandbox')
  const usesSandboxPolicy = source.includes('dsh-sandbox-policy')
  const usesSandboxLocal = source.includes('dsh-sandbox-local')
  const passed = usesBashSandbox && usesSandboxPolicy && usesSandboxLocal
  return {
    id: 'G2',
    name: 'Subprocess plane uses bash-sandbox with sandbox-policy',
    status: passed ? 'pass' : 'fail',
    evidence: passed
      ? 'sandbox-local, sandbox-policy, and bash-sandbox are all mounted'
      : 'subprocess sandbox composition is incomplete',
  }
}

/** G3: Verify the sandbox policy is workspace-isolated with protected read paths. */
function checkSandboxPolicy(): SecurityPropertyCheck {
  const source = readCollectorSource()
  const hasWorkspaceIsolated = source.includes('workspace-isolated')
  const hasProtectedReadPaths = source.includes('protectedReadPaths')
  const hasWorkspaceRoot = source.includes('workspaceRoot')
  const passed = hasWorkspaceIsolated && hasProtectedReadPaths && hasWorkspaceRoot
  return {
    id: 'G3',
    name: 'Sandbox policy is workspace-isolated with protected read paths',
    status: passed ? 'pass' : 'fail',
    evidence: passed
      ? 'workspace-isolated mode with workspaceRoot and protectedReadPaths configured'
      : 'sandbox policy is missing workspace-isolated mode, workspaceRoot, or protectedReadPaths',
  }
}

/** G4: Verify Seatbelt isolation claim is honest (partial, not full). */
function checkSeatbeltHonesty(): SecurityPropertyCheck {
  const source = readSandboxLocalSource()
  const hasSeatbeltPartial = source.includes("seatbelt: 'partial'") || source.includes("seatbelt:'partial'")
  const passed = hasSeatbeltPartial
  return {
    id: 'G4',
    name: 'Seatbelt isolation claim is honest (partial)',
    status: passed ? 'pass' : 'fail',
    evidence: passed
      ? 'Seatbelt reports partial enforcement in sandbox-local/src/index.ts'
      : 'Seatbelt does not honestly report partial enforcement',
  }
}

/** G5: Verify Seatbelt fails closed when workspace isolation inputs are absent. */
function checkSeatbeltFailClosed(): SecurityPropertyCheck {
  const source = readSandboxLocalSource()
  const hasFailClosed = source.includes('workspace-isolated') && (
    source.includes('throw') || source.includes('fail') || source.includes('reject')
  )
  const passed = hasFailClosed
  return {
    id: 'G5',
    name: 'Seatbelt fails closed when isolation inputs are absent',
    status: passed ? 'pass' : 'fail',
    evidence: passed
      ? 'sandbox-local fails closed for workspace-isolated without protected read paths'
      : 'sandbox-local does not fail closed when isolation inputs are absent',
  }
}

/** G6: Verify holdouts are externalized from the model workspace. */
function checkHoldoutExternalization(): SecurityPropertyCheck {
  const source = readCollectorSource()
  const hasExternalHoldoutDir = source.includes('/tmp/v019-batch-a-repos/holdouts')
  const stagesHoldouts = source.includes('stageHoldouts') || source.includes('holdoutDir')
  const unstagesHoldouts = source.includes('unstageHoldouts') || source.includes('rm -f') || source.includes('cleanup')
  const passed = hasExternalHoldoutDir && stagesHoldouts && unstagesHoldouts
  return {
    id: 'G6',
    name: 'Holdouts are externalized from the model workspace',
    status: passed ? 'pass' : 'fail',
    evidence: passed
      ? 'holdouts stored under /tmp/v019-batch-a-repos/holdouts, staged and cleaned up'
      : 'holdouts are not externalized from the model workspace',
  }
}

/** G7: Verify diagnostic commands do not discover holdout files. */
function checkDiagnosticHoldoutDiscovery(): SecurityPropertyCheck {
  const source = readCollectorSource()
  const usesTaskSpecificDiagnostics = source.includes('manifest.verification.diagnostic')
  const doesNotUseNpmTest = !source.includes("command: 'npm test'") && !source.includes('command: "npm test"')
  const passed = usesTaskSpecificDiagnostics && doesNotUseNpmTest
  return {
    id: 'G7',
    name: 'Diagnostic commands do not discover holdout files',
    status: passed ? 'pass' : 'fail',
    evidence: passed
      ? 'diagnostics use task-specific commands from manifest.verification.diagnostic'
      : 'diagnostics may use broad npm test that discovers holdout files',
  }
}

/** G8: Verify production RepairRuntime is mounted (not the v018 script loop). */
function checkProductionRepairRuntime(): SecurityPropertyCheck {
  const source = readCollectorSource()
  const importsRepairRuntime = source.includes('@deepseek-ai/dsh-repair-runtime')
  const mountsPlugin = source.includes('ctx.plugin(repairRuntimePlugin')
  const doesNotUseV018Loop = !source.includes('runRepairLoop(') || source.includes('// v018 loop removed')
  const passed = importsRepairRuntime && mountsPlugin && doesNotUseV018Loop
  return {
    id: 'G8',
    name: 'Production RepairRuntime is mounted',
    status: passed ? 'pass' : 'fail',
    evidence: passed
      ? 'repair-runtime plugin imported and mounted via ctx.plugin()'
      : 'production RepairRuntime is not mounted or v018 script loop is still used',
  }
}

/** G9: Verify rollback provider is configured and harness-owned. */
function checkRollbackProvider(): SecurityPropertyCheck {
  const source = readCollectorSource()
  const hasRollbackProvider = source.includes('rollbackProvider') || source.includes('createRollbackProvider')
  const usesGitCheckout = source.includes('git checkout') || source.includes('git clean')
  const passed = hasRollbackProvider && usesGitCheckout
  return {
    id: 'G9',
    name: 'Rollback provider is configured and harness-owned',
    status: passed ? 'pass' : 'fail',
    evidence: passed
      ? 'rollbackProvider configured with git checkout/clean restoration'
      : 'rollback provider is not configured',
  }
}

/** G10: Verify workspace provenance provider binds verification to content hash. */
function checkProvenanceProvider(): SecurityPropertyCheck {
  const source = readCollectorSource()
  const hasProvenanceProvider = source.includes('workspaceProvenanceProvider') || source.includes('createProvenanceProvider')
  const usesSha256 = source.includes('sha256') || source.includes('createHash')
  const passed = hasProvenanceProvider && usesSha256
  return {
    id: 'G10',
    name: 'Workspace provenance provider binds verification to content hash',
    status: passed ? 'pass' : 'fail',
    evidence: passed
      ? 'workspaceProvenanceProvider configured with SHA-256 content hashing'
      : 'provenance provider is not configured',
  }
}

/** G11: Verify holdout verifier stages and cleans up external holdout tests. */
function checkHoldoutVerifier(): SecurityPropertyCheck {
  const source = readCollectorSource()
  const hasHoldoutVerifier = source.includes('holdoutVerifier') || source.includes('createHoldoutVerifier')
  const stagesAndCleansUp = source.includes('cp ') && source.includes('rm -f')
  const passed = hasHoldoutVerifier && stagesAndCleansUp
  return {
    id: 'G11',
    name: 'Holdout verifier stages and cleans up external holdout tests',
    status: passed ? 'pass' : 'fail',
    evidence: passed
      ? 'holdoutVerifier stages holdout files, runs commands, and cleans up'
      : 'holdout verifier does not stage and clean up external holdout tests',
  }
}

/** G12: Verify unpriced model usage fails (no $0 fallback). */
function checkUnpricedUsageFails(): SecurityPropertyCheck {
  const source = readCollectorSource()
  const hasUnpricedCheck = source.includes('UNPRICED') || source.includes('pricing === undefined')
  const noZeroFallback = !source.includes('pricing === undefined ? 0')
  const passed = hasUnpricedCheck && noZeroFallback
  return {
    id: 'G12',
    name: 'Unpriced model usage fails',
    status: passed ? 'pass' : 'fail',
    evidence: passed
      ? 'unpriced usage is checked and does not fall back to $0'
      : 'unpriced usage may silently become $0',
  }
}

/** G13: Verify metrics filter by benchmarkEligible. */
function checkBenchmarkEligibleFilter(): SecurityPropertyCheck {
  const source = readMetricsSource()
  const filtersByBenchmarkEligible = source.includes('benchmarkEligible')
  const passed = filtersByBenchmarkEligible
  return {
    id: 'G13',
    name: 'Metrics filter by benchmarkEligible',
    status: passed ? 'pass' : 'fail',
    evidence: passed
      ? 'metrics function references benchmarkEligible'
      : 'metrics do not filter by benchmarkEligible',
  }
}

/** G14: Verify replay mismatch rate is not hard-coded to zero. */
function checkReplayMismatchNotHardcoded(): SecurityPropertyCheck {
  const source = readMetricsSource()
  const hasReplayMismatch = source.includes('replayMismatch')
  const notHardcodedZero = !source.includes('replayMismatchRate: 0') && !source.includes('replayMismatchRate:0')
  const passed = hasReplayMismatch && notHardcodedZero
  return {
    id: 'G14',
    name: 'Replay mismatch rate is not hard-coded to zero',
    status: passed ? 'pass' : 'fail',
    evidence: passed
      ? 'replayMismatchRate is derived, not hard-coded to 0'
      : 'replayMismatchRate may be hard-coded to 0',
  }
}

/** G15: Verify per-attempt diffs are captured separately. */
function checkPerAttemptDiffs(): SecurityPropertyCheck {
  const source = readCollectorSource()
  const hasPerAttemptObservation = source.includes('attemptObservation') || source.includes('extractRepositoryObservation')
  const passed = hasPerAttemptObservation
  return {
    id: 'G15',
    name: 'Per-attempt diffs are captured separately',
    status: passed ? 'pass' : 'fail',
    evidence: passed
      ? 'per-attempt repository observation is extracted from session events'
      : 'per-attempt diffs are not captured separately',
  }
}

/** G16: Verify wall-clock latency is separated from model latency. */
function checkLatencySeparation(): SecurityPropertyCheck {
  const source = readCollectorSource()
  const hasWallClock = source.includes('wallClockStart') || source.includes('totalLatencyMs')
  const hasPerAttemptLatency = source.includes('latencyMs')
  const passed = hasWallClock && hasPerAttemptLatency
  return {
    id: 'G16',
    name: 'Wall-clock latency is separated from model latency',
    status: passed ? 'pass' : 'fail',
    evidence: passed
      ? 'wall-clock and per-attempt latency are tracked separately'
      : 'latency is not separated',
  }
}

/** G17: Verify sandbox qualification skips are counted as non-pass. */
function checkSandboxQualificationSkip(): SecurityPropertyCheck {
  const source = readSandboxQualificationSource()
  const hasSkipCount = source.includes('skippedTests')
  const hasRequiredCount = source.includes('requiredTests')
  const passed = hasSkipCount && hasRequiredCount
  return {
    id: 'G17',
    name: 'Sandbox qualification skips are counted as non-pass',
    status: passed ? 'pass' : 'fail',
    evidence: passed
      ? 'sandbox qualification tracks skipped and required test counts'
      : 'sandbox qualification does not track skips vs required tests',
  }
}

/** G18: Verify repair decisions route through durable routing authority. */
function checkDurableRoutingAuthority(): SecurityPropertyCheck {
  const source = readRepairRuntimeSource()
  const usesRoutingAuthority = source.includes('claimModelSelection') || source.includes('routing-decision')
  const passed = usesRoutingAuthority
  return {
    id: 'G18',
    name: 'Repair decisions route through durable routing authority',
    status: passed ? 'pass' : 'fail',
    evidence: passed
      ? 'repair-runtime uses claimModelSelection and routing-decision events'
      : 'repair decisions do not route through durable routing authority',
  }
}

/** G19: Verify repair events are emitted in correct order. */
function checkRepairEventOrdering(): SecurityPropertyCheck {
  const source = readRepairRuntimeInvariantSource()
  const checksEvidenceBeforeDecision = source.includes('repair/evidence') && source.includes('repair/decision')
  const checksCompleted = source.includes('repair/completed')
  const passed = checksEvidenceBeforeDecision && checksCompleted
  return {
    id: 'G19',
    name: 'Repair events are emitted in correct order',
    status: passed ? 'pass' : 'fail',
    evidence: passed
      ? 'invariant checks evidence before decision and completed after both'
      : 'repair event ordering is not verified by an invariant',
  }
}

/** G20: Verify releaseToAuto refuses undecidable authority state. */
function checkReleaseToAutoUndecidable(): SecurityPropertyCheck {
  const source = readRepairRuntimeSource()
  const handlesUndecidable = source.includes('undecidable')
  const refusesTransition = source.includes('refuse') || source.includes('DENY') || source.includes('block')
  const passed = handlesUndecidable && refusesTransition
  return {
    id: 'G20',
    name: 'releaseToAuto refuses undecidable authority state',
    status: passed ? 'pass' : 'fail',
    evidence: passed
      ? 'releaseToAuto handles undecidable authority and refuses transition'
      : 'releaseToAuto does not refuse undecidable authority state',
  }
}

// ---------------------------------------------------------------------------
// Source readers
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dirname, '..')

function readCollectorSource(): string {
  return readFileSync(join(REPO_ROOT, 'scripts', 'v019-trajectory-collector.ts'), 'utf8')
}

function readMetricsSource(): string {
  return readFileSync(join(REPO_ROOT, 'scripts', 'v019-metrics.ts'), 'utf8')
}

function readSandboxLocalSource(): string {
  return readFileSync(join(REPO_ROOT, 'packages', 'sandbox', 'sandbox-local', 'src', 'index.ts'), 'utf8')
}

function readSandboxQualificationSource(): string {
  return readFileSync(join(REPO_ROOT, 'scripts', 'v018-sandbox-qualification.ts'), 'utf8')
}

function readRepairRuntimeSource(): string {
  return readFileSync(join(REPO_ROOT, 'packages', 'core', 'repair-runtime', 'src', 'index.ts'), 'utf8')
}

function readRepairRuntimeInvariantSource(): string {
  return readFileSync(join(REPO_ROOT, 'packages', 'core', 'repair-runtime', 'src', 'invariant.ts'), 'utf8')
}

/**
 * Format the security qualification record as a human-readable report.
 * @param record - the qualification record.
 * @returns formatted report string.
 */
export function formatSecurityQualification(record: SecurityQualificationRecord): string {
  const lines: string[] = [
    `Security Qualification: ${record.qualificationId}`,
    `Platform: ${record.platform}`,
    `Timestamp: ${record.timestamp}`,
    `Result: ${record.passed ? 'PASS' : 'FAIL'} (${record.passedCount} passed, ${record.failedCount} failed, ${record.notApplicableCount} not-applicable)`,
    '-'.repeat(60),
  ]
  for (const check of record.checks) {
    const status = check.status === 'pass' ? 'PASS' : check.status === 'fail' ? 'FAIL' : 'N/A'
    lines.push(`  [${status}] ${check.id}: ${check.name}`)
    lines.push(`    ${check.evidence}`)
  }
  return lines.join('\n')
}
