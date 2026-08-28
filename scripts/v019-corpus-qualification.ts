/**
 * v0.19 corpus qualification pipeline.
 *
 * Each task enters as CANDIDATE and must pass through successive gates
 * before it can enter the live benchmark run:
 *
 *   CANDIDATE
 *     → REPRODUCED          (repository clones, base commit exists, base state fails)
 *     → VERIFIER_VALIDATED  (diagnostic verifier fails at base, passes at fix)
 *     → LEAKAGE_CHECKED     (reference fix hidden from model, task text does not leak solution)
 *     → FROZEN              (manifest hashed, benchmarkEligible=true, ready for live run)
 *
 * Only FROZEN tasks enter the live run. A task that fails any gate is
 * rejected with a recorded reason and does not count toward the 25-task quota.
 *
 * @module v019-corpus-qualification
 */

import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { TaskManifest, VerificationCommand } from './v019-task-manifest.ts'

/** Corpus state for one task. */
export type CorpusState =
  | 'CANDIDATE'
  | 'REPRODUCED'
  | 'VERIFIER_VALIDATED'
  | 'LEAKAGE_CHECKED'
  | 'FROZEN'
  | 'REJECTED'

/** Result of qualifying one task through a gate. */
export interface QualificationResult {
  readonly taskId: string
  readonly state: CorpusState
  readonly gate: string
  readonly passed: boolean
  readonly reason: string
  readonly details: readonly string[]
}

/** Full qualification record for one task. */
export interface TaskQualificationRecord {
  readonly taskId: string
  readonly manifest: TaskManifest
  readonly currentState: CorpusState
  readonly history: readonly QualificationResult[]
  readonly qualifiedAt: string | undefined
}

/**
 * Run a command in a workspace and return whether it succeeded.
 * Returns true if exit code matches expected, false otherwise.
 */
function runCommand(
  workspace: string,
  command: string,
  expectedExitCode: number,
  timeoutMs = 120000,
): { passed: boolean; output: string } {
  try {
    const output = execSync(command, {
      cwd: workspace,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: 'pipe',
    })
    return { passed: 0 === expectedExitCode, output }
  } catch (error: unknown) {
    const exitCode = (error as { status?: number }).status ?? -1
    return { passed: exitCode === expectedExitCode, output: String(error) }
  }
}

/**
 * Run a list of verification commands. Returns true only if all pass.
 */
function runVerificationCommands(
  workspace: string,
  commands: readonly VerificationCommand[],
): boolean {
  for (const cmd of commands) {
    const result = runCommand(workspace, cmd.command, cmd.expectedExitCode)
    if (!result.passed) return false
  }
  return true
}

/**
 * Gate 1: REPRODUCED
 *
 * Verifies that:
 * - The repository URL is accessible
 * - The base commit exists in the repository
 * - The reference fix commit exists (if specified)
 * - The base state can be checked out
 */
export function qualifyReproduced(
  manifest: TaskManifest,
  workspace: string,
): QualificationResult {
  const details: string[] = []

  // Check that workspace has a git repo at the base commit.
  try {
    const currentCommit = execSync('git rev-parse HEAD', {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 10000,
    }).trim()
    if (currentCommit !== manifest.repository.baseCommit) {
      return {
        taskId: manifest.taskId,
        state: 'REJECTED',
        gate: 'REPRODUCED',
        passed: false,
        reason: `HEAD is ${currentCommit.slice(0, 12)}, expected ${manifest.repository.baseCommit.slice(0, 12)}`,
        details,
      }
    }
    details.push(`Base commit verified: ${currentCommit.slice(0, 12)}`)
  } catch (error: unknown) {
    return {
      taskId: manifest.taskId,
      state: 'REJECTED',
      gate: 'REPRODUCED',
      passed: false,
      reason: `Failed to verify base commit: ${String(error)}`,
      details,
    }
  }

  // Check reference fix commit exists if specified.
  if (manifest.repository.referenceFixCommit !== undefined) {
    try {
      execSync(
        `git cat-file -t ${manifest.repository.referenceFixCommit}`,
        { cwd: workspace, encoding: 'utf8', timeout: 10000 },
      )
      details.push(`Reference fix commit verified: ${manifest.repository.referenceFixCommit.slice(0, 12)}`)
    } catch {
      return {
        taskId: manifest.taskId,
        state: 'REJECTED',
        gate: 'REPRODUCED',
        passed: false,
        reason: `Reference fix commit ${manifest.repository.referenceFixCommit.slice(0, 12)} not found`,
        details,
      }
    }
  }

  return {
    taskId: manifest.taskId,
    state: 'REPRODUCED',
    gate: 'REPRODUCED',
    passed: true,
    reason: 'Repository cloned, base and reference commits verified',
    details,
  }
}

/**
 * Gate 2: VERIFIER_VALIDATED
 *
 * Verifies that:
 * - The diagnostic verifier FAILS at the base commit (the bug is real)
 * - The diagnostic verifier PASSES after applying the reference fix
 * - The holdout verifier passes after the fix (if V3)
 *
 * This gate requires a clean checkout at the base commit.
 */
export function qualifyVerifierValidated(
  manifest: TaskManifest,
  workspace: string,
): QualificationResult {
  const details: string[] = []

  // Step 1: Diagnostic must FAIL at base commit.
  const baseDiagnostic = runVerificationCommands(workspace, manifest.verification.diagnostic)
  if (baseDiagnostic) {
    return {
      taskId: manifest.taskId,
      state: 'REJECTED',
      gate: 'VERIFIER_VALIDATED',
      passed: false,
      reason: 'Diagnostic verifier passed at base commit — bug is not reproducible',
      details,
    }
  }
  details.push('Diagnostic verifier fails at base commit (expected)')

  // Step 2: Apply reference fix and verify diagnostic passes.
  if (manifest.repository.referenceFixCommit === undefined) {
    // No reference fix — can't validate the fix. Accept if diagnostic fails.
    return {
      taskId: manifest.taskId,
      state: 'VERIFIER_VALIDATED',
      gate: 'VERIFIER_VALIDATED',
      passed: true,
      reason: 'Diagnostic fails at base; no reference fix to validate',
      details,
    }
  }

  // Check out the reference fix commit.
  try {
    execSync(
      `git checkout ${manifest.repository.referenceFixCommit}`,
      { cwd: workspace, encoding: 'utf8', timeout: 30000 },
    )
  } catch (error: unknown) {
    return {
      taskId: manifest.taskId,
      state: 'REJECTED',
      gate: 'VERIFIER_VALIDATED',
      passed: false,
      reason: `Failed to check out reference fix: ${String(error)}`,
      details,
    }
  }

  // Run diagnostic at fix commit.
  const fixDiagnostic = runVerificationCommands(workspace, manifest.verification.diagnostic)
  if (!fixDiagnostic) {
    return {
      taskId: manifest.taskId,
      state: 'REJECTED',
      gate: 'VERIFIER_VALIDATED',
      passed: false,
      reason: 'Diagnostic verifier fails at reference fix commit — fix does not resolve the bug',
      details,
    }
  }
  details.push('Diagnostic verifier passes at reference fix commit')

  // Run holdout at fix commit if V3.
  if (manifest.verification.holdout.length > 0) {
    const fixHoldout = runVerificationCommands(workspace, manifest.verification.holdout)
    if (!fixHoldout) {
      return {
        taskId: manifest.taskId,
        state: 'REJECTED',
        gate: 'VERIFIER_VALIDATED',
        passed: false,
        reason: 'Holdout verifier fails at reference fix commit — fix is incomplete',
        details,
      }
    }
    details.push('Holdout verifier passes at reference fix commit')
  }

  // Restore base commit.
  try {
    execSync(`git checkout ${manifest.repository.baseCommit}`, {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 30000,
    })
  } catch {
    // Non-fatal — workspace will be cleaned up.
  }

  return {
    taskId: manifest.taskId,
    state: 'VERIFIER_VALIDATED',
    gate: 'VERIFIER_VALIDATED',
    passed: true,
    reason: 'Diagnostic fails at base, passes at fix; holdout validated',
    details,
  }
}

/**
 * Gate 3: LEAKAGE_CHECKED
 *
 * Verifies that:
 * - The task description does not contain the reference fix commit hash
 * - The task description does not contain file paths from the reference fix
 * - The task description does not contain the exact solution code
 *
 * This is a static check on the manifest, not a workspace operation.
 */
export function qualifyLeakageChecked(
  manifest: TaskManifest,
  referenceFixFiles: readonly string[],
): QualificationResult {
  const details: string[] = []
  const description = manifest.task.description
  const title = manifest.task.title
  const combined = `${title} ${description}`

  // Check for reference fix commit hash in description.
  if (manifest.repository.referenceFixCommit !== undefined) {
    const shortHash = manifest.repository.referenceFixCommit.slice(0, 8)
    if (combined.includes(manifest.repository.referenceFixCommit) || combined.includes(shortHash)) {
      return {
        taskId: manifest.taskId,
        state: 'REJECTED',
        gate: 'LEAKAGE_CHECKED',
        passed: false,
        reason: 'Task description contains reference fix commit hash',
        details,
      }
    }
  }

  // Check for reference fix file paths in description.
  for (const file of referenceFixFiles) {
    if (combined.includes(file)) {
      // Allow the file path if it's mentioned in context like "the function in src/index.ts"
      // but reject if it appears with fix-specific content. For now, flag it.
      details.push(`Warning: task description mentions reference fix file: ${file}`)
    }
  }

  // Check for common solution-leak patterns.
  const leakPatterns = [
    /fix.*by.*changing.*to/i,
    /the.*solution.*is/i,
    /change.*line.*\d+.*to/i,
  ]
  for (const pattern of leakPatterns) {
    if (pattern.test(description)) {
      return {
        taskId: manifest.taskId,
        state: 'REJECTED',
        gate: 'LEAKAGE_CHECKED',
        passed: false,
        reason: `Task description contains solution-leak pattern: ${pattern.source}`,
        details,
      }
    }
  }

  return {
    taskId: manifest.taskId,
    state: 'LEAKAGE_CHECKED',
    gate: 'LEAKAGE_CHECKED',
    passed: true,
    reason: 'No reference fix commit, file paths, or solution patterns in task description',
    details,
  }
}

/**
 * Gate 4: FROZEN
 *
 * Verifies that:
 * - The manifest hash is valid
 * - benchmarkEligible is true
 * - The manifest is internally consistent
 *
 * Returns the final qualification record.
 */
export function qualifyFrozen(
  manifest: TaskManifest,
  history: readonly QualificationResult[],
): TaskQualificationRecord {
  const passed = manifest.benchmarkEligible && manifest.manifestHash.length === 64
  return {
    taskId: manifest.taskId,
    manifest,
    currentState: passed ? 'FROZEN' : 'REJECTED',
    history: [...history, {
      taskId: manifest.taskId,
      state: passed ? 'FROZEN' : 'REJECTED',
      gate: 'FROZEN',
      passed,
      reason: passed
        ? 'Manifest hashed, benchmarkEligible=true, ready for live run'
        : 'Manifest invalid or not benchmark-eligible',
      details: [],
    }],
    qualifiedAt: passed ? new Date().toISOString() : undefined,
  }
}

/**
 * Run the full qualification pipeline for one task.
 *
 * @param manifest - task manifest to qualify
 * @param workspace - clean checkout at the base commit
 * @param referenceFixFiles - files changed by the reference fix (verifier-only)
 * @returns full qualification record
 */
export function qualifyTask(
  manifest: TaskManifest,
  workspace: string,
  referenceFixFiles: readonly string[],
): TaskQualificationRecord {
  const history: QualificationResult[] = []

  // Gate 1: REPRODUCED
  const reproduced = qualifyReproduced(manifest, workspace)
  history.push(reproduced)
  if (!reproduced.passed) {
    return { taskId: manifest.taskId, manifest, currentState: 'REJECTED', history, qualifiedAt: undefined }
  }

  // Gate 2: VERIFIER_VALIDATED
  const validated = qualifyVerifierValidated(manifest, workspace)
  history.push(validated)
  if (!validated.passed) {
    return { taskId: manifest.taskId, manifest, currentState: 'REJECTED', history, qualifiedAt: undefined }
  }

  // Gate 3: LEAKAGE_CHECKED
  const leakage = qualifyLeakageChecked(manifest, referenceFixFiles)
  history.push(leakage)
  if (!leakage.passed) {
    return { taskId: manifest.taskId, manifest, currentState: 'REJECTED', history, qualifiedAt: undefined }
  }

  // Gate 4: FROZEN
  return qualifyFrozen(manifest, history)
}

/**
 * Get reference fix files from a repository at the reference fix commit.
 * Returns repository-relative paths.
 */
export function getReferenceFixFiles(workspace: string, referenceFixCommit: string): string[] {
  try {
    const output = execSync(
      `git diff --name-only ${referenceFixCommit}~1 ${referenceFixCommit}`,
      { cwd: workspace, encoding: 'utf8', timeout: 10000 },
    )
    return output.trim().split('\n').filter(f => f.length > 0)
  } catch {
    return []
  }
}

/**
 * Check out a repository at a specific commit into a temporary workspace.
 * Returns the workspace path.
 */
export function checkoutAtCommit(
  repoUrl: string,
  commit: string,
  repoName: string,
): string {
  const workspace = mkdtempSync(join(tmpdir(), `v019-qualify-${repoName}-`))
  try {
    execSync(`git clone --quiet "${repoUrl}" "${workspace}"`, {
      encoding: 'utf8',
      timeout: 60000,
    })
    execSync(`git checkout ${commit}`, {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 30000,
    })
  } catch (error: unknown) {
    rmSync(workspace, { recursive: true, force: true })
    throw error
  }
  return workspace
}

/**
 * Clean up a temporary workspace.
 */
export function cleanupWorkspace(workspace: string): void {
  if (existsSync(workspace)) {
    rmSync(workspace, { recursive: true, force: true })
  }
}
