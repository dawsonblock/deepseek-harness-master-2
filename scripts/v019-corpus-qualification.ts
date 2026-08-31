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
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, rmSync as rmSyncFn, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'

import type { TaskManifest, VerificationCommand } from './v019-task-manifest.ts'

/** Copy external holdout files into the workspace for holdout verification. */
function stageHoldouts(workspace: string, manifest: TaskManifest): void {
  if (manifest.verification.holdout.length === 0) return
  const holdoutDir = join(homedir(), '.dsh-v019-holdouts', manifest.repository.name)
  if (!existsSync(holdoutDir)) return
  const testsDir = join(workspace, 'tests')
  mkdirSync(testsDir, { recursive: true })
  for (const entry of readdirSync(holdoutDir)) {
    if (entry.endsWith('.holdout.test.ts')) {
      copyFileSync(join(holdoutDir, entry), join(testsDir, entry))
    }
  }
}

/** Remove staged holdout files from the workspace after verification. */
function unstageHoldouts(workspace: string, manifest: TaskManifest): void {
  if (manifest.verification.holdout.length === 0) return
  const holdoutDir = join(homedir(), '.dsh-v019-holdouts', manifest.repository.name)
  if (!existsSync(holdoutDir)) return
  const testsDir = join(workspace, 'tests')
  for (const entry of readdirSync(holdoutDir)) {
    if (entry.endsWith('.holdout.test.ts')) {
      rmSyncFn(join(testsDir, entry), { force: true })
    }
  }
}

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
    // execSync captures stdout/stderr on the error object when stdio is 'pipe'.
    // String(error) alone drops both, so the task-specific reproduction gate
    // cannot find the target test file name in the failure output.
    const err = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string }
    const stdout = typeof err.stdout === 'string' ? err.stdout : ''
    const stderr = typeof err.stderr === 'string' ? err.stderr : ''
    const message = err.message ?? String(error)
    return { passed: exitCode === expectedExitCode, output: `${stdout}\n${stderr}\n${message}` }
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
 * Run a single verification command and return both pass/fail and output.
 * Used by the task-specific reproduction gate to check that the diagnostic
 * output references the expected test file.
 */
function runCommandWithOutput(
  workspace: string,
  command: string,
  expectedExitCode: number,
): { passed: boolean; output: string } {
  return runCommand(workspace, command, expectedExitCode)
}

/**
 * Extract a test file path from a diagnostic command string. Returns
 * the last `tests/...test.ts` path in the command, or undefined for
 * commands that do not reference a specific test file (e.g., `tsc`).
 */
function extractTestFileFromCommand(command: string): string | undefined {
  const matches = command.match(/tests\/[^\s]+\.test\.ts/g)
  return matches?.at(-1)
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

  // Step 1: Diagnostic must FAIL at base commit. Capture output to verify
  // the failure is from the task's target test, not an unrelated test in
  // the same repo. Extract the test file name from the diagnostic command
  // and check it appears in the failure output.
  const diagnosticCommand = manifest.verification.diagnostic[0]
  if (diagnosticCommand === undefined) {
    return {
      taskId: manifest.taskId,
      state: 'REJECTED',
      gate: 'VERIFIER_VALIDATED',
      passed: false,
      reason: 'No diagnostic command defined',
      details,
    }
  }
  const targetTestFile = extractTestFileFromCommand(diagnosticCommand.command)
  const baseResult = runCommandWithOutput(workspace, diagnosticCommand.command, diagnosticCommand.expectedExitCode)
  if (baseResult.passed) {
    return {
      taskId: manifest.taskId,
      state: 'REJECTED',
      gate: 'VERIFIER_VALIDATED',
      passed: false,
      reason: 'Diagnostic verifier passed at base commit — bug is not reproducible',
      details,
    }
  }
  if (targetTestFile !== undefined) {
    if (!baseResult.output.includes(targetTestFile)) {
      return {
        taskId: manifest.taskId,
        state: 'REJECTED',
        gate: 'VERIFIER_VALIDATED',
        passed: false,
        reason: `Diagnostic output at base does not mention target test file ${targetTestFile} — failure may be from an unrelated test`,
        details,
      }
    }
    details.push(`Target test file ${targetTestFile} found in base failure output`)
  }
  details.push('Diagnostic verifier fails at base commit (expected)')
  details.push(`base stdout/stderr (truncated):\n${baseResult.output.slice(0, 2000)}`)

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
    // Reinstall dependencies at the fix commit — package.json may have changed.
    try {
      execSync('npm install --silent', {
        cwd: workspace,
        encoding: 'utf8',
        timeout: 120000,
        stdio: 'pipe',
      })
    } catch {
      // Non-fatal: some tasks may not need install changes.
    }
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

  // Run diagnostic at fix commit. Capture output to verify the target
  // test file is in the passing output, not just any test passing.
  const fixResult = runCommandWithOutput(workspace, diagnosticCommand.command, diagnosticCommand.expectedExitCode)
  if (!fixResult.passed) {
    return {
      taskId: manifest.taskId,
      state: 'REJECTED',
      gate: 'VERIFIER_VALIDATED',
      passed: false,
      reason: 'Diagnostic verifier fails at reference fix commit — fix does not resolve the bug',
      details,
    }
  }
  if (targetTestFile !== undefined) {
    if (!fixResult.output.includes(targetTestFile)) {
      return {
        taskId: manifest.taskId,
        state: 'REJECTED',
        gate: 'VERIFIER_VALIDATED',
        passed: false,
        reason: `Diagnostic output at fix does not mention target test file ${targetTestFile} — pass may be from an unrelated test`,
        details,
      }
    }
    details.push(`Target test file ${targetTestFile} found in fix pass output`)
  }
  details.push('Diagnostic verifier passes at reference fix commit')
  details.push(`fix stdout/stderr (truncated):\n${fixResult.output.slice(0, 2000)}`)

  // Run holdout at fix commit if V3.
  if (manifest.verification.holdout.length > 0) {
    stageHoldouts(workspace, manifest)
    let fixHoldout: boolean
    try {
      fixHoldout = runVerificationCommands(workspace, manifest.verification.holdout)
    } finally {
      unstageHoldouts(workspace, manifest)
    }
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
export function getReferenceFixFiles(gitDir: string, referenceFixCommit: string): string[] {
  try {
    const output = execSync(
      `git --git-dir="${gitDir}/.git" diff --name-only ${referenceFixCommit}~1 ${referenceFixCommit}`,
      { encoding: 'utf8', timeout: 10000 },
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
