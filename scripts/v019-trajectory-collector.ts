/**
 * v0.19 trajectory collector.
 *
 * Runs synthetic multi-repository tasks through the production RepairRuntime
 * plugin. Captures full trajectory data including repository context, tool
 * calls, changed files, and verification results for each attempt.
 *
 * The production RepairRuntime hooks into goal/verification events, uses the
 * durable routing authority for model selection, and emits durable repair
 * events (repair/evidence, repair/decision, repair/completed, model/escalation).
 * Holdout verification, workspace provenance, and rollback are injected via
 * plugin config.
 *
 * @module v019-trajectory-collector
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

import type { Context } from '@deepseek-ai/cordis'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import type { GoalCompletionVerifier } from '@deepseek-ai/dsh-goal'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { calculateCost, DEFAULT_PRICING_REGISTRY, lookupPricingAt } from '@deepseek-ai/dsh-token-meter'

import {
  type ModelRef,
  type RepairDecision,
} from '@deepseek-ai/dsh-repair-controller'

import * as repairRuntimePlugin from '@deepseek-ai/dsh-repair-runtime'
import type { RepairRuntimeConfig } from '@deepseek-ai/dsh-repair-runtime'

import {
  extractRepositoryObservation,
  intersectPaths,
} from './v019-session-extraction.ts'

import type { TaskManifest } from './v019-task-manifest.ts'
import { type RepoMetadata, type RepoCheckout, type BaselineSnapshot, restoreBaseline, hashWorkspaceContents } from './v019-repo-checkout.ts'

/** Checkpoint state for one task during evaluation. */
export type TaskState =
  | 'PENDING'
  | 'CHECKOUT'
  | 'SETUP'
  | 'RUNNING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'FAILED_INFRA'

/** Control-plane status distinguishes runtime correctness from model capability. */
export type ControlPlaneStatus = 'PASS' | 'FAIL' | 'NOT_EVALUATED'

/** Full trajectory record for one task. */
export interface TaskTrajectory {
  readonly taskId: string
  readonly taskManifestHash: string
  readonly experimentId: string
  readonly benchmarkEligible: boolean
  readonly repository: RepoMetadata
  readonly category: string
  readonly taskDescription: string
  readonly baseCommit: string
  readonly referenceFixCommit: string | undefined
  readonly taskState: TaskState
  readonly controlPlaneStatus: ControlPlaneStatus
  readonly modelCapabilityStatus: 'PASS' | 'FAIL' | 'NOT_EVALUATED'
  readonly finalVerified: boolean
  readonly holdoutPass: boolean | undefined
  readonly verificationStrength: string
  readonly flashAttempts: number
  readonly proAttempts: number
  readonly escalatedToPro: boolean
  readonly totalCostUsd: number
  readonly totalLatencyMs: number
  readonly totalOutputTokens: number
  readonly totalCacheReadTokens: number
  readonly totalCacheMissTokens: number
  readonly attempts: readonly AttemptTrajectory[]
  readonly changedFiles: readonly string[]
  /** All files touched by the reference fix commit. Empty if no reference fix exists. Verifier-only. */
  readonly referenceFixFiles: readonly string[]
  /** Files from the reference fix commit that the agent inspected. Empty if no reference fix exists. */
  readonly referenceFixFilesInspected: readonly string[]
  /** Files from the reference fix commit that the agent modified. Empty if no reference fix exists. */
  readonly referenceFixFilesModified: readonly string[]
  readonly rollbackUsed: boolean
  readonly aborted: boolean
  readonly abortReason: string | undefined
  readonly terminalOutcome: string
  readonly failureCategory: string | undefined
  readonly timestamp: string
}

/** Full trajectory record for one attempt within a task. */
export interface AttemptTrajectory {
  readonly attempt: number
  readonly model: string
  readonly routingDecisionId: string
  readonly verified: boolean
  readonly diagnosticPass: boolean
  readonly holdoutPass: boolean | undefined
  readonly failureFingerprint: string | undefined
  readonly progress: string | undefined
  readonly failedCriteria: readonly string[]
  readonly failingTests: readonly string[]
  readonly typeErrors: readonly string[]
  readonly buildErrors: readonly string[]
  readonly usage: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly reasoningTokens: number
    readonly totalTokens: number
    readonly cacheReadTokens: number
    readonly cacheMissTokens: number
  }
  readonly costUsd: number
  readonly latencyMs: number
  readonly repairAction: RepairDecision['action']
  readonly repairReason: string | undefined
  readonly changedFiles: readonly string[]
  readonly toolCallCount: number
  readonly filesInspected: readonly string[]
  readonly terminalOutcome: string
}

const REPO_ROOT = join(import.meta.dirname, '..')

/**
 * Run one synthetic multi-repository task through the production RepairRuntime.
 *
 * Boots a Cordis context with the repair-controller, goal, and tool-goal
 * plugins, then mounts the repair-runtime plugin programmatically with full
 * config (including holdout verifier, rollback, and provenance providers that
 * cannot be expressed in YAML). A goal completion verifier runs the task's
 * diagnostic commands. After each agent turn, verification is triggered
 * programmatically; the repair-runtime plugin handles repair decisions,
 * model escalation, and holdout verification.
 */
export async function runTaskTrajectory(
  manifest: TaskManifest,
  workspace: string,
  experimentId: string,
  benchmarkEligible: boolean,
  repoMetadata: RepoMetadata,
  referenceFixFiles: readonly string[],
  checkout?: RepoCheckout,
  baseline?: BaselineSnapshot,
): Promise<TaskTrajectory> {
  const flashModel: ModelRef = { provider: 'deepseek', model: 'deepseek-v4-flash' }
  const proModel: ModelRef = { provider: 'deepseek', model: 'deepseek-v4-pro' }

  const wallClockStart = Date.now()
  const allEvents: SessionEvent[] = []
  let uninstallFailLoud: (() => void) | undefined
  let ctx: Context | undefined

  try {
    const configPath = await generateRepoConfig(flashModel.model, workspace)
    await mkdir(join(workspace, 'sessions'), { recursive: true })
    loadEnv('v019-evaluation')
    uninstallFailLoud = installFailLoud('v019-evaluation')
    ctx = await boot('v019-evaluation', resolveConfigPath(configPath, undefined))

    // Mount the repair-runtime plugin programmatically with full config,
    // including function-type fields that cannot be expressed in YAML.
    const repairConfig: RepairRuntimeConfig = {
      enabled: true,
      flashModel: { provider: flashModel.provider, model: flashModel.model },
      proModel: { provider: proModel.provider, model: proModel.model },
      maxFlashAttempts: manifest.limits.maxFlashAttempts,
      maxProAttempts: manifest.limits.maxProAttempts,
      maxTotalAttempts: manifest.limits.maxTotalAttempts,
      holdoutVerifier: createHoldoutVerifier(workspace, manifest, baseline),
      workspaceProvenanceProvider: createProvenanceProvider(workspace),
      rollbackProvider: createRollbackProvider(workspace, checkout, baseline),
      failOnMissingUsage: true,
    }
    await ctx.plugin(repairRuntimePlugin, repairConfig)

    // Register a goal completion verifier that runs the task's diagnostic
    // commands. The repair-runtime plugin watches goal/verification events
    // emitted by verifyCompletion() and handles repair decisions.
    // Hash verifier-controlled files before model execution. The diagnostic
    // verifier re-hashes these files on each verification call and rejects
    // the task if the model has tampered with them.
    const verifierFileHash = hashVerifierControlledFiles(workspace)

    const diagnosticVerifier: GoalCompletionVerifier = {
      name: 'v019-diagnostic',
      version: '1',
      verify: () => {
        // Check verifier-controlled files have not been tampered with.
        const currentHash = hashVerifierControlledFiles(workspace)
        if (currentHash !== verifierFileHash) {
          return {
            name: 'v019-diagnostic',
            role: 'acceptance',
            passed: false,
            reason: 'verifier-controlled files were modified by the model — task rejected',
            evidence: [`expected hash: ${verifierFileHash}`, `actual hash: ${currentHash}`],
          }
        }
        const result = runDiagnosticSync(workspace, manifest)
        const evidence: string[] = []
        if (!result.passed) {
          if (result.failedCommand !== undefined) {
            evidence.push(`Command: ${result.failedCommand}`)
          }
          if (result.stdout.length > 0) {
            evidence.push(`stdout:\n${result.stdout}`)
          }
          if (result.stderr.length > 0) {
            evidence.push(`stderr:\n${result.stderr}`)
          }
        }
        return {
          name: 'v019-diagnostic',
          role: 'acceptance',
          passed: result.passed,
          reason: result.passed ? '' : `diagnostic verification failed: ${result.failedCommand ?? 'unknown command'}`,
          evidence,
        }
      },
    }
    const goalsService = ctx.get('goals')
    if (goalsService === undefined) throw new Error('goals service not available')
    goalsService.registerAcceptanceVerifier(diagnosticVerifier)

    // Get the root agent and create a goal for this task.
    const agents = ctx.get('agents')?.roots() ?? []
    const agent = agents[0]
    if (agent === undefined || agents.length !== 1) {
      throw new Error(`trajectory collector requires exactly one root agent, found ${agents.length}`)
    }

    goalsService.create(agent, { objective: manifest.task.description })

    // Capture all session events for trajectory extraction.
    const disposeListener = ctx.on('session/event', (_session, event) => {
      allEvents.push(event)
    })

    try {
      // Send the task to the agent. The agent works on it and becomes idle.
      await runFixtureTurn(ctx, { task: manifest.task.description })

      // After each agent idle, trigger goal verification. The repair-runtime
      // plugin handles repair decisions: flash-repair sends a followup, pro-
      // escalate sends a followup with a different model, stop blocks the goal.
      // Loop until the goal is no longer active.
      let verificationRounds = 0
      const maxVerificationRounds = manifest.limits.maxTotalAttempts + 2
      while (verificationRounds < maxVerificationRounds) {
        verificationRounds += 1
        const currentGoal = goalsService.get(agent)
        if (currentGoal === undefined || currentGoal.phase !== 'active') break

        // Pass a workspace snapshot provider so the hash is computed AFTER
        // verifiers run, binding the state that was actually tested.
        await goalsService.verifyCompletion(
          agent,
          { id: currentGoal.id, revision: currentGoal.revision },
          () => computeWorkspaceHash(workspace),
        )
        await agent.whenIdle()

        // Check if the repair-runtime plugin completed or blocked the goal.
        const postGoal = goalsService.get(agent)
        if (postGoal === undefined || postGoal.phase !== 'active') break
      }
    } finally {
      disposeListener()
    }

    await ctx.sessions.flush(agent.session)
  } finally {
    // Dispose the Cordis context fiber so event handlers, plugin effects,
    // services, and session infrastructure are cleaned up before the next
    // task boots a fresh context in the same process.
    if (ctx !== undefined) {
      try { await ctx.fiber.dispose() } catch { /* context may already be disposed */ }
    }
    uninstallFailLoud?.()
  }

  // Extract trajectory from session events.
  return buildTrajectoryFromEvents(
    allEvents, manifest, workspace, experimentId, benchmarkEligible,
    repoMetadata, referenceFixFiles, wallClockStart, checkout,
  )
}

/** Build a FAILED_INFRA trajectory for tasks that failed before reaching the repair loop. */
export function buildInfraFailureTrajectory(
  manifest: TaskManifest,
  experimentId: string,
  benchmarkEligible: boolean,
  repoMetadata: RepoMetadata | undefined,
  failureReason: string,
): TaskTrajectory {
  return {
    taskId: manifest.taskId,
    taskManifestHash: manifest.manifestHash,
    experimentId,
    benchmarkEligible,
    repository: repoMetadata ?? {
      name: manifest.repository.name,
      url: manifest.repository.url,
      baseCommit: manifest.repository.baseCommit,
      size: manifest.repoSize,
      loc: 0, fileCount: 0, packageCount: 0, testCount: 0,
    },
    category: manifest.category,
    taskDescription: manifest.task.description,
    baseCommit: manifest.repository.baseCommit,
    referenceFixCommit: manifest.repository.referenceFixCommit,
    taskState: 'FAILED_INFRA',
    controlPlaneStatus: 'NOT_EVALUATED',
    modelCapabilityStatus: 'NOT_EVALUATED',
    finalVerified: false,
    holdoutPass: undefined,
    verificationStrength: manifest.verification.strength,
    flashAttempts: 0,
    proAttempts: 0,
    escalatedToPro: false,
    totalCostUsd: 0,
    totalLatencyMs: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheMissTokens: 0,
    attempts: [],
    changedFiles: [],
    referenceFixFiles: [],
    referenceFixFilesInspected: [],
    referenceFixFilesModified: [],
    rollbackUsed: false,
    aborted: true,
    abortReason: failureReason,
    terminalOutcome: 'infra-failure',
    failureCategory: 'F6-build-environment',
    timestamp: new Date().toISOString(),
  }
}

export async function generateRepoConfig(model: string, workspace: string): Promise<string> {
  const basePath = join(REPO_ROOT, 'examples', 'headless-agent', 'cordis.yml')
  let base = await readFile(basePath, 'utf8')
  base = base.replace(/model: deepseek-v4-flash/, `model: ${model}`)
  base = base.replace(
    /compression: !!js "process.env.DSH_SNAPSHOT === undefined \? 'zstd' : 'none'"/,
    "compression: 'none'",
  )
  base = base.replace(/cwd: !!js process\.cwd\(\)/g, `cwd: '${workspace}'`)
  base = base.replace(
    /- id: bash\n  name: '@deepseek-ai\/dsh-bash-local'/,
    `- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: workspace-isolated
    workspaceRoot: '${workspace}'
    readOnlyPaths:
      - '${join(workspace, 'node_modules')}'
      - '${join(workspace, 'dist')}'
    protectedReadPaths:
      - '${join(REPO_ROOT, 'scripts')}'
      - '${join(REPO_ROOT, 'artifacts')}'
      - '${join(REPO_ROOT, '.agents')}'
      - '${join(REPO_ROOT, 'packages')}'
      - '${join(REPO_ROOT, 'docs')}'
      - '${join(REPO_ROOT, 'website')}'
- id: bash
  name: '@deepseek-ai/dsh-bash-sandbox'`,
  )
  // Replace fs-local with fs-sandbox so model-facing file tools are fenced
  // by the sandbox policy (read+write containment under workspace-isolated).
  base = base.replace(
    /- id: fs-local\n  name: '@deepseek-ai\/dsh-fs-local'/,
    `- id: fs-sandbox
  name: '@deepseek-ai/dsh-fs-sandbox'`,
  )
  // Add goal, tool-goal, and repair-controller plugins so the production
  // RepairRuntime can hook into goal/verification events. The repair-runtime
  // plugin itself is mounted programmatically after boot with full config
  // (including function-type fields that cannot be expressed in YAML).
  base = base.replace(
    /- id: persistence/,
    `- id: goal
  name: '@deepseek-ai/dsh-goal'
- id: tool-goal
  name: '@deepseek-ai/dsh-tool-goal'
- id: repair-controller
  name: '@deepseek-ai/dsh-repair-controller'
- id: persistence`,
  )
  const configPath = join(workspace, '.v019-cordis.yml')
  await writeFile(configPath, base, 'utf8')
  return configPath
}

// ---------------------------------------------------------------------------
// Verifier: runs the repository's own build and test commands
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 hash of the workspace's source files. Delegates to the
 * canonical `hashWorkspaceContents` in `v019-repo-checkout.ts` so that
 * verification, completion authorization, provenance, baseline freeze/restore,
 * rollback verification, and composed qualification all use the same
 * implementation.
 *
 * @param workspace - the workspace root to hash.
 * @returns a hex SHA-256 digest of the workspace contents.
 */
function computeWorkspaceHash(workspace: string): string {
  return hashWorkspaceContents(workspace)
}

// ---------------------------------------------------------------------------
// Production RepairRuntime helpers: holdout, provenance, rollback, trajectory
// ---------------------------------------------------------------------------

/** Result of running diagnostic verification commands. */
interface DiagnosticResult {
  readonly passed: boolean
  readonly failedCommand?: string
  readonly stdout: string
  readonly stderr: string
}

/**
 * Run diagnostic verification commands synchronously for the goal completion
 * verifier. Captures stdout/stderr from failed commands so the repair model
 * receives real test failure output instead of a generic message.
 */
function runDiagnosticSync(workspace: string, manifest: TaskManifest): DiagnosticResult {
  for (const cmd of manifest.verification.diagnostic) {
    try {
      execSync(cmd.command, { cwd: workspace, encoding: 'utf8', timeout: 120000, stdio: 'pipe' })
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string }
      const stdout = typeof err.stdout === 'string' ? err.stdout : ''
      const stderr = typeof err.stderr === 'string' ? err.stderr : ''
      // Truncate to avoid overwhelming the model prompt; keep the tail
      // where stack traces and assertion failures typically appear.
      const maxLen = 4000
      const truncate = (s: string): string => s.length > maxLen ? `...(${s.length - maxLen} chars truncated)...\n${s.slice(-maxLen)}` : s
      return {
        passed: false,
        failedCommand: cmd.command,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
      }
    }
  }
  return { passed: true, stdout: '', stderr: '' }
}

/**
 * Compute a SHA-256 hash of verifier-controlled task files before model
 * execution. This protects the verifier environment from model tampering:
 * the diagnostic verifier re-hashes these files and rejects modifications
 * before final verification.
 *
 * Verifier-controlled files are files the model should not alter: package
 * manifests, test configurations, and test setup files. The model workspace
 * is extracted from a git archive without .git, so the model cannot use git
 * to inspect these — but it can still overwrite them with tool calls.
 */
function hashVerifierControlledFiles(workspace: string): string {
  const hash = createHash('sha256')
  const controlledFiles = [
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'tsconfig.json',
    'vitest.config.ts',
    'vitest.config.mts',
    'vitest.config.js',
    'vite.config.ts',
  ]
  // Also include diagnostic test files and test setup. A model modifying
  // these files could make diagnostic verification pass without actually
  // solving the task. Walk common test directories to find test files.
  const testDirs = ['tests', 'test', '__tests__', 'src/__tests__']
  const testFilePatterns = [
    /\.test\.ts$/, /\.test\.tsx$/, /\.test\.js$/, /\.test\.jsx$/,
    /\.spec\.ts$/, /\.spec\.tsx$/, /\.spec\.js$/, /\.spec\.jsx$/,
    /\.test\.py$/, /\.test\.rs$/,
    /^test_.*\.py$/, /_test\.py$/, /^test_.*\.rs$/, /_test\.rs$/,
    /\.test\.go$/, /_test\.go$/,
    /\.test\.java$/, /Test\.java$/,
  ]
  const testSetupFiles = ['tests/setup.ts', 'tests/setup.js', 'test/setup.ts', 'test/setup.js', 'tests/setup.mts', '__tests__/setup.ts', 'tests/setup.py', 'conftest.py']

  const allFiles = [...controlledFiles, ...testSetupFiles]

  // Walk test directories recursively for test files. Historical
  // repositories commonly organize tests in nested subdirectories
  // (e.g. tests/unit/foo.test.ts, tests/integration/api/bar.spec.ts).
  const walkTestDir = (dirRel: string, dirAbs: string): void => {
    try {
      const entries = readdirSync(dirAbs, { withFileTypes: true })
      for (const entry of entries) {
        const entryAbs = join(dirAbs, entry.name)
        const entryRel = join(dirRel, entry.name)
        if (entry.isDirectory()) {
          walkTestDir(entryRel, entryAbs)
        } else if (entry.isFile() && testFilePatterns.some(p => p.test(entry.name))) {
          allFiles.push(entryRel)
        }
      }
    } catch {
      // Test directory doesn't exist — skip.
    }
  }
  for (const dir of testDirs) {
    walkTestDir(dir, join(workspace, dir))
  }

  for (const file of allFiles) {
    const absPath = join(workspace, file)
    try {
      const content = readFileSync(absPath)
      hash.update(file).update(':').update(content).update('\n')
    } catch {
      // File doesn't exist in this workspace — include its absence in the hash
      // so a model creating it would be detected.
      hash.update(file).update(':absent\n')
    }
  }

  // Hash node_modules integrity: the lockfile metadata and the top-level
  // package directory listing. A model that modifies installed dependencies
  // (e.g. patching vitest internals) would change this hash. Full content
  // hashing of node_modules is impractical; this detects structural tampering.
  const nodeModulesPath = join(workspace, 'node_modules')
  try {
    const nmEntries = readdirSync(nodeModulesPath, { withFileTypes: true })
    nmEntries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of nmEntries) {
      hash.update('node_modules/').update(entry.name).update(':').update(entry.isDirectory() ? 'dir' : 'file').update('\n')
    }
    // Hash the package-lock metadata inside node_modules if present.
    for (const lockFile of ['.package-lock.json', '.modules.yaml', '.pnpm/lock.yaml']) {
      const lockPath = join(nodeModulesPath, lockFile)
      try {
        const content = readFileSync(lockPath)
        hash.update('node_modules/').update(lockFile).update(':').update(content).update('\n')
      } catch {
        hash.update('node_modules/').update(lockFile).update(':absent\n')
      }
    }
  } catch {
    hash.update('node_modules:absent\n')
  }

  return hash.digest('hex')
}

/**
 * Create a holdout verifier for the production RepairRuntime. When a baseline
 * snapshot is available, runs holdout in a clean verifier-owned workspace
 * restored from the baseline, with the model's candidate changes applied.
 * This prevents model tampering with node_modules, dist, or verifier
 * infrastructure from affecting holdout results.
 *
 * The candidate diff is computed by comparing the model workspace against
 * the baseline. Only source files (excluding node_modules/.git/dist) are
 * copied — the clean workspace's immutable layer is preserved.
 */
function createHoldoutVerifier(
  workspace: string,
  manifest: TaskManifest,
  baseline?: BaselineSnapshot,
): repairRuntimePlugin.HoldoutVerifier {
  return () => {
    if (manifest.verification.holdout.length === 0) {
      return { passed: true, reason: 'no holdout configured' }
    }

    // When a baseline is available, run holdout in a clean verifier workspace.
    if (baseline !== undefined) {
      return runHoldoutInCleanWorkspace(workspace, manifest, baseline)
    }

    // Legacy fallback: stage holdout files in the model workspace.
    return runHoldoutInModelWorkspace(workspace, manifest)
  }
}

/** Run holdout in a clean verifier workspace restored from the baseline. */
function runHoldoutInCleanWorkspace(
  workspace: string,
  manifest: TaskManifest,
  baseline: BaselineSnapshot,
): { passed: boolean; reason: string } {
  const verifierWorkspace = `${workspace}.verifier-holdout`
  try {
    // Restore the baseline into a clean verifier workspace.
    const restoreResult = restoreBaseline(verifierWorkspace, baseline)
    if (!restoreResult.success) {
      return { passed: false, reason: 'failed to restore verifier workspace from baseline' }
    }

    // Copy model-modified source files into the verifier workspace.
    // Exclude node_modules, .git, dist — the baseline's immutable layer
    // is already in place and must not be overwritten by model changes.
    try {
      execSync(
        `rsync -a --delete --exclude='node_modules' --exclude='.git' --exclude='dist' --exclude='sessions' "${workspace}/" "${verifierWorkspace}/"`,
        { stdio: 'pipe', timeout: 60000 },
      )
    } catch {
      // rsync may not be available; fall back to cp for source files only.
      try {
        execSync(
          `cp -R "${workspace}/." "${verifierWorkspace}/" 2>/dev/null || true`,
          { stdio: 'pipe', timeout: 60000 },
        )
        // Remove mutable excluded dirs that cp may have overwritten.
        execSync(`rm -rf "${join(verifierWorkspace, 'node_modules')}" "${join(verifierWorkspace, 'sessions')}"`, { stdio: 'pipe', timeout: 30000 })
        // Restore immutable dirs from baseline.
        execSync(`tar -xf "${baseline.archivePath}" -C "${verifierWorkspace}" --include='node_modules' --include='sessions' 2>/dev/null || true`, { stdio: 'pipe', timeout: 60000 })
      } catch {
        return { passed: false, reason: 'failed to copy candidate changes to verifier workspace' }
      }
    }

    // Stage holdout files in the verifier workspace.
    const holdoutDir = join(homedir(), '.dsh-v019-holdouts', manifest.repository.name)
    try {
      const entries = execSync(`ls "${holdoutDir}"`, { encoding: 'utf8' }).trim().split('\n')
      for (const entry of entries) {
        if (entry.endsWith('.holdout.test.ts')) {
          execSync(`cp "${join(holdoutDir, entry)}" "${join(verifierWorkspace, 'tests', entry)}"`)
        }
      }
    } catch {
      return { passed: false, reason: 'failed to stage holdout files' }
    }

    // Run holdout commands in the verifier workspace.
    let passed = true
    let reason = ''
    try {
      for (const cmd of manifest.verification.holdout) {
        try {
          execSync(cmd.command, { cwd: verifierWorkspace, encoding: 'utf8', timeout: 120000, stdio: 'pipe' })
        } catch {
          passed = false
          reason = `holdout command failed: ${cmd.command}`
          break
        }
      }
    } finally {
      try { rmSync(verifierWorkspace, { recursive: true, force: true }) } catch { /* cleanup */ }
    }
    return { passed, reason }
  } catch (e) {
    try { rmSync(verifierWorkspace, { recursive: true, force: true }) } catch { /* cleanup */ }
    return { passed: false, reason: `verifier workspace error: ${(e as Error).message}` }
  }
}

/** Run holdout in the model workspace (legacy fallback without baseline). */
function runHoldoutInModelWorkspace(workspace: string, manifest: TaskManifest): { passed: boolean; reason: string } {
  const holdoutDir = join(homedir(), '.dsh-v019-holdouts', manifest.repository.name)
  try {
    const entries = execSync(`ls "${holdoutDir}"`, { encoding: 'utf8' }).trim().split('\n')
    for (const entry of entries) {
      if (entry.endsWith('.holdout.test.ts')) {
        execSync(`cp "${join(holdoutDir, entry)}" "${join(workspace, 'tests', entry)}"`)
      }
    }
  } catch {
    return { passed: false, reason: 'failed to stage holdout files' }
  }
  let passed = true
  let reason = ''
  try {
    for (const cmd of manifest.verification.holdout) {
      try {
        execSync(cmd.command, { cwd: workspace, encoding: 'utf8', timeout: 120000, stdio: 'pipe' })
      } catch {
        passed = false
        reason = `holdout command failed: ${cmd.command}`
        break
      }
    }
  } finally {
    try {
      const entries = execSync(`ls "${holdoutDir}"`, { encoding: 'utf8' }).trim().split('\n')
      for (const entry of entries) {
        if (entry.endsWith('.holdout.test.ts')) {
          execSync(`rm -f "${join(workspace, 'tests', entry)}"`)
        }
      }
    } catch {
      // Cleanup failure is not fatal.
    }
  }
  return { passed, reason }
}

/**
 * Create a workspace provenance provider that computes the same full-workspace
 * SHA-256 hash used at verification time. This is critical: the completion-time
 * hash must use the same algorithm as the verification-time hash, otherwise
 * completeVerified() will reject every legitimate completion.
 *
 * The changed-files context is accepted but not used for hashing — the
 * full-workspace snapshot is the authoritative binding. Changed-files
 * provenance remains available for repair evidence via a separate field.
 */
function createProvenanceProvider(workspace: string): repairRuntimePlugin.WorkspaceProvenanceProvider {
  return () => computeWorkspaceHash(workspace)
}

/**
 * Create a rollback provider that restores the workspace from a frozen
 * post-setup baseline snapshot. When a `BaselineSnapshot` is available,
 * restores exactly B0 and verifies the content hash matches. Falls back
 * to `git checkout` for legacy worktree-based workspaces without a snapshot.
 */
function createRollbackProvider(
  workspace: string,
  checkout?: RepoCheckout,
  baseline?: BaselineSnapshot,
): repairRuntimePlugin.RollbackProvider {
  return () => {
    try {
      if (baseline !== undefined) {
        const result = restoreBaseline(workspace, baseline)
        return {
          success: result.success,
          rollbackTarget: 'baseline-snapshot',
          targetHash: baseline.hash,
          ...result.resultHash !== undefined ? { resultHash: result.resultHash } : {},
          ...!result.success ? { failureReason: 'baseline hash mismatch after restore' } : {},
        }
      }
      if (checkout !== undefined) {
        // Legacy fallback: re-extract from git archive without a frozen baseline.
        rmSync(workspace, { recursive: true, force: true })
        mkdirSync(workspace, { recursive: true })
        execSync(
          `git --git-dir="${checkout.cloneDir}/.git" archive "${checkout.commit}" | tar -x -C "${workspace}"`,
          { stdio: 'pipe', timeout: 60000 },
        )
        return { success: true, rollbackTarget: 'base-commit' }
      }
      execSync('git checkout -- .', { cwd: workspace, encoding: 'utf8', timeout: 30000, stdio: 'pipe' })
      execSync('git clean -fd', { cwd: workspace, encoding: 'utf8', timeout: 30000, stdio: 'pipe' })
      return { success: true, rollbackTarget: 'base-commit' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, rollbackTarget: baseline !== undefined ? 'baseline-snapshot' : 'base-commit', failureReason: message }
    }
  }
}

/** Build a TaskTrajectory from the session events collected during the repair runtime flow. */
function buildTrajectoryFromEvents(
  allEvents: readonly SessionEvent[],
  manifest: TaskManifest,
  workspace: string,
  experimentId: string,
  benchmarkEligible: boolean,
  repoMetadata: RepoMetadata,
  referenceFixFiles: readonly string[],
  wallClockStart: number,
  checkout?: RepoCheckout,
): TaskTrajectory {
  // Extract repair attempts from repair/evidence and repair/decision events.
  const repairEvents = allEvents.filter(e => e.type === 'repair/evidence' || e.type === 'repair/decision' || e.type === 'repair/completed')
  const completedEvent = repairEvents.find(e => e.type === 'repair/completed') as
    | Extract<SessionEvent, { type: 'repair/completed' }> | undefined

  const flashAttempts = completedEvent?.data.flashAttempts ?? 0
  const proAttempts = completedEvent?.data.proAttempts ?? 0
  const totalCostUsd = completedEvent?.data.totalCostUsd ?? 0
  const finalVerified = completedEvent?.data.verified ?? false
  const outcome = completedEvent?.data.outcome ?? 'unknown'
  const escalatedToPro = proAttempts > 0

  // Determine holdout pass from the outcome.
  const holdoutPass = outcome === 'qualification-failed' ? false : finalVerified

  // Extract per-attempt data from model/usage events, grouped by
  // routingDecisionId. Multiple usage events sharing the same routing
  // decision represent provider retries within one logical attempt —
  // they must be aggregated, not counted as separate attempts.
  const usageEvents = allEvents.filter(e => e.type === 'model/usage')
  type UsageData = { usage: {
    inputTokens?: number
    outputTokens?: number
    reasoningTokens?: number
    totalTokens?: number
    cacheReadTokens?: number
    cacheMissTokens?: number
  } }

  // Group usage events by routingDecisionId, preserving order of first appearance.
  const routingGroups: { routingDecisionId: string; events: typeof usageEvents }[] = []
  for (const usageEvent of usageEvents) {
    const turn = (usageEvent.data as { turn?: number }).turn ?? 0
    // Prefer the usage event's own routingDecisionId when present; fall
    // back to turn-based matching for legacy events that lack it.
    const ownRoutingId = (usageEvent.data as { routingDecisionId?: string }).routingDecisionId
    const routingEvent = allEvents.find(e => e.type === 'model/routing-decision' && (e.data as { turn?: number }).turn === turn) as
      | Extract<SessionEvent, { type: 'model/routing-decision' }> | undefined
    const routingDecisionId = ownRoutingId ?? routingEvent?.data.routingDecisionId ?? `unrouted-turn-${turn}`
    const existing = routingGroups.find(g => g.routingDecisionId === routingDecisionId)
    if (existing !== undefined) {
      existing.events.push(usageEvent)
    } else {
      routingGroups.push({ routingDecisionId, events: [usageEvent] })
    }
  }

  const attempts: AttemptTrajectory[] = []
  let totalOutputTokens = 0
  let totalCacheReadTokens = 0
  let totalCacheMissTokens = 0

  for (let i = 0; i < routingGroups.length; i++) {
    const group = routingGroups[i]
    if (group === undefined) continue
    const firstUsageEvent = group.events[0] as Extract<SessionEvent, { type: 'model/usage' }>

    // Aggregate usage across all provider retries in this logical attempt.
    let inputTokens = 0
    let outputTokens = 0
    let reasoningTokens = 0
    let totalTokens = 0
    let cacheReadTokens = 0
    let cacheMissTokens = 0
    for (const evt of group.events) {
      const usage = (evt.data as unknown as UsageData).usage
      inputTokens += usage.inputTokens ?? 0
      outputTokens += usage.outputTokens ?? 0
      reasoningTokens += usage.reasoningTokens ?? 0
      totalTokens += usage.totalTokens ?? 0
      cacheReadTokens += usage.cacheReadTokens ?? 0
      cacheMissTokens += usage.cacheMissTokens ?? 0
    }
    totalOutputTokens += outputTokens
    totalCacheReadTokens += cacheReadTokens
    totalCacheMissTokens += cacheMissTokens

    const turn = (firstUsageEvent.data as { turn?: number }).turn ?? 0
    const routingDecisionId = group.routingDecisionId
    // Use routingDecisionId as the primary join key for model lookup.
    // Fall back to turn-based matching only for legacy events without
    // a routingDecisionId.
    const routingEvent = allEvents.find(e =>
      e.type === 'model/routing-decision'
      && (e.data as { routingDecisionId?: string }).routingDecisionId === routingDecisionId,
    ) as Extract<SessionEvent, { type: 'model/routing-decision' }> | undefined
      ?? allEvents.find(e =>
        e.type === 'model/routing-decision'
        && (e.data as { turn?: number }).turn === turn,
      ) as Extract<SessionEvent, { type: 'model/routing-decision' }> | undefined
    const model = (routingEvent?.data as { selection?: { model?: string } }).selection?.model
      ?? (firstUsageEvent.data as { model?: string }).model
      ?? 'unknown'

    // Fail loud on unpriced model usage: unknown pricing must not silently
    // become $0, which would make economic metrics look artificially better.
    // Use the event's actual timestamp for historical pricing accuracy.
    const eventTimestamp = new Date(firstUsageEvent.time)
    const pricing = lookupPricingAt(DEFAULT_PRICING_REGISTRY, 'deepseek-official', model, eventTimestamp)
    if (pricing === undefined) {
      throw new Error(`UNPRICED_USAGE: no pricing found for model ${model}`)
    }
    const cost = calculateCost({
      inputTokens, outputTokens, cacheReadTokens, cacheMissTokens,
      reasoningTokens, totalTokens, source: 'provider',
    }, pricing)
    const costUsd = cost.amount

    // Find repair evidence and decision for this attempt. Use
    // routingDecisionId as the primary join key; fall back to attempt
    // ordinal for legacy events that lack routingDecisionId.
    const repairEvidence = allEvents.find(e =>
      e.type === 'repair/evidence'
      && (e.data as { routingDecisionId?: string }).routingDecisionId === routingDecisionId,
    ) as Extract<SessionEvent, { type: 'repair/evidence' }> | undefined
      ?? allEvents.find(e => e.type === 'repair/evidence' && (e.data as { attempt?: number }).attempt === i + 1) as
        | Extract<SessionEvent, { type: 'repair/evidence' }> | undefined
    const repairDecision = allEvents.find(e =>
      e.type === 'repair/decision'
      && (e.data as { routingDecisionId?: string }).routingDecisionId === routingDecisionId,
    ) as Extract<SessionEvent, { type: 'repair/decision' }> | undefined
      ?? allEvents.find(e => e.type === 'repair/decision' && (e.data as { attempt?: number }).attempt === i + 1) as
        | Extract<SessionEvent, { type: 'repair/decision' }> | undefined
    const repairAction = repairDecision?.data.action ?? 'complete'
    const repairReason = repairDecision?.data.reason
    const failureFingerprint = repairEvidence?.data.failureFingerprint as string | undefined
    const progress = repairEvidence?.data.progress as string | undefined
    const failedCriteria = repairEvidence?.data.failedCriteria ?? []
    const failingTests = repairEvidence?.data.failingTests ?? []
    const typeErrors = repairEvidence?.data.typeErrors ?? []
    const buildErrors = repairEvidence?.data.buildErrors ?? []

    // Extract per-attempt session events for repository observation.
    const turnEvents = allEvents.filter((e) => {
      const eventTurn = (e.data as { turn?: number }).turn
      return eventTurn === turn
    })
    const attemptObservation = extractRepositoryObservation(turnEvents, workspace)

    attempts.push({
      attempt: i + 1,
      model,
      routingDecisionId,
      verified: repairAction === 'complete' && finalVerified,
      diagnosticPass: repairAction === 'complete',
      holdoutPass: repairAction === 'complete' ? holdoutPass : undefined,
      failureFingerprint,
      progress,
      failedCriteria,
      failingTests,
      typeErrors,
      buildErrors,
      usage: { inputTokens, outputTokens, reasoningTokens, totalTokens, cacheReadTokens, cacheMissTokens },
      costUsd,
      // Per-attempt model latency: time from turn/start to last usage event.
      latencyMs: (() => {
        const turnStart = allEvents.find(e => e.type === 'turn/start' && (e.data as { turn?: number }).turn === turn)
        if (turnStart === undefined) return 0
        const lastUsage = group.events[group.events.length - 1]
        if (lastUsage === undefined) return 0
        return Math.max(0, lastUsage.time - turnStart.time)
      })(),
      repairAction,
      repairReason,
      changedFiles: attemptObservation.filesModified,
      toolCallCount: turnEvents.filter(e => e.type === 'tool/call').length,
      filesInspected: attemptObservation.filesInspected,
      terminalOutcome: outcome,
    })
  }

  // Fail closed: every paid model routing decision must reconcile with
  // canonical model/usage evidence. A routing decision represents a paid
  // request to the provider. Missing usage for any routing decision means
  // cost and token accounting is incomplete — this is a control-plane
  // failure, not a model capability failure.
  //
  // This is broader than checking only repair/evidence events: one-shot
  // success and the final successful repair attempt also have routing
  // decisions but may not have repair/evidence events. Every paid request
  // must be accounted for.
  const routingDecisionEvents = allEvents.filter(e => e.type === 'model/routing-decision')
  if (routingDecisionEvents.length > 0 && usageEvents.length === 0) {
    throw new Error(`MISSING_USAGE_EVIDENCE: ${routingDecisionEvents.length} model/routing-decision event(s) but 0 model/usage events for task ${manifest.taskId}`)
  }

  // Per-request reconciliation: each routing decision must have at least
  // one matching model/usage event by routingDecisionId. This catches
  // missing usage for one-shot success, final successful repair, and
  // failed attempts alike.
  for (const routingEvent of routingDecisionEvents) {
    const routingData = routingEvent.data as { routingDecisionId?: string; turn?: number }
    const routingRdId = routingData.routingDecisionId
    const routingTurn = routingData.turn
    const hasMatchingUsage = usageEvents.some((usageEvent) => {
      const usageData = usageEvent.data as { routingDecisionId?: string; turn?: number }
      if (routingRdId !== undefined && usageData.routingDecisionId !== undefined) {
        return usageData.routingDecisionId === routingRdId
      }
      return usageData.turn === routingTurn
    })
    if (!hasMatchingUsage) {
      throw new Error(`MISSING_USAGE_EVIDENCE: model/routing-decision (routingDecisionId=${routingRdId ?? 'undefined'}, turn=${routingTurn ?? 'undefined'}) has no matching model/usage event for task ${manifest.taskId}`)
    }
  }

  const changedFiles = getChangedFiles(workspace, checkout)
  const allSessionEvents = allEvents
  const observation = extractRepositoryObservation(allSessionEvents, workspace)
  const referenceFixFilesInspected = intersectPaths(observation.filesInspected, referenceFixFiles)
  const referenceFixFilesModified = intersectPaths(observation.filesModified, referenceFixFiles)

  const terminalOutcome = outcome === 'verified' ? 'verified-complete'
    : outcome === 'qualification-failed' ? 'qualification-failed'
      : outcome === 'attempts-exhausted' ? 'attempts-exhausted'
        : outcome === 'cost-limit' ? 'budget-stop'
          : outcome === 'time-limit' ? 'budget-stop'
            : outcome === 'output-token-limit' ? 'budget-stop'
              : outcome === 'authority-undecidable' ? 'authority-undecidable'
                : outcome === 'model-unavailable' ? 'model-unavailable'
                  : outcome === 'rollback-failed' ? 'rollback-failed'
                    : 'failed-no-rescue'

  // Control plane status measures whether the harness itself behaved
  // correctly: routing, verification, repair, rollback, and event emission
  // all worked as designed. A model capability failure (couldn't solve the
  // task, failed holdout) is NOT a control plane failure. An unknown
  // terminal state is a control-plane failure — the harness could not
  // determine the outcome, which is itself a harness defect.
  const controlPlaneStatus: ControlPlaneStatus =
    outcome === 'authority-undecidable'
      || outcome === 'model-unavailable'
      || outcome === 'rollback-failed'
      || outcome === 'workspace-provenance-failed'
      || outcome === 'unknown'
      ? 'FAIL'
      : 'PASS'
  // Model capability is NOT_EVALUATED when the control plane failed before
  // the model had a fair chance to demonstrate capability. For rollback
  // failures and unknown outcomes, the model's capability cannot be assessed
  // because the harness did not complete the evaluation pipeline.
  const modelCapabilityStatus: 'PASS' | 'FAIL' | 'NOT_EVALUATED' =
    outcome === 'authority-undecidable'
      || outcome === 'model-unavailable'
      || outcome === 'rollback-failed'
      || outcome === 'workspace-provenance-failed'
      || outcome === 'unknown'
      ? 'NOT_EVALUATED'
      : finalVerified ? 'PASS' : 'FAIL'

  return {
    taskId: manifest.taskId,
    taskManifestHash: manifest.manifestHash,
    experimentId,
    benchmarkEligible,
    repository: repoMetadata,
    category: manifest.category,
    taskDescription: manifest.task.description,
    baseCommit: manifest.repository.baseCommit,
    referenceFixCommit: manifest.repository.referenceFixCommit,
    taskState: 'COMPLETED',
    controlPlaneStatus,
    modelCapabilityStatus,
    finalVerified,
    holdoutPass,
    verificationStrength: manifest.verification.strength,
    flashAttempts,
    proAttempts,
    escalatedToPro,
    totalCostUsd,
    totalLatencyMs: Date.now() - wallClockStart,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheMissTokens,
    attempts,
    changedFiles,
    referenceFixFiles,
    referenceFixFilesInspected,
    referenceFixFilesModified,
    rollbackUsed: allEvents.some(e => e.type === 'repair/rollback'),
    aborted: outcome === 'authority-undecidable' || outcome === 'model-unavailable' || outcome === 'rollback-failed',
    abortReason: outcome === 'authority-undecidable' ? 'authority-undecidable'
      : outcome === 'model-unavailable' ? 'model-unavailable'
        : outcome === 'rollback-failed' ? 'rollback-failed'
          : undefined,
    terminalOutcome,
    failureCategory: undefined,
    timestamp: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get files changed in the workspace relative to the base commit.
 * Uses the verifier-only clone for the diff baseline since the model
 * workspace has no `.git` directory.
 */
function getChangedFiles(workspace: string, checkout?: RepoCheckout): string[] {
  try {
    if (checkout !== undefined) {
      // Archive-based workspace: compare against the base commit in the clone.
      // List files in the workspace and diff against the archive at the base commit.
      const baseFiles = execSync(
        `git --git-dir="${checkout.cloneDir}/.git" archive "${checkout.commit}" | tar -t`,
        { encoding: 'utf8', timeout: 30000 },
      ).trim().split('\n').filter(f => f.length > 0)
      const workspaceFiles = execSync(`find "${workspace}" -type f -not -path '*/node_modules/*' -not -path '*/.git/*'`, {
        encoding: 'utf8',
        timeout: 30000,
      }).trim().split('\n').filter(f => f.length > 0)
        .map(f => f.slice(workspace.length + 1))
      const changed = new Set<string>()
      const baseSet = new Set(baseFiles)
      const wsSet = new Set(workspaceFiles)
      for (const f of workspaceFiles) {
        if (!baseSet.has(f)) changed.add(f)
      }
      for (const f of baseFiles) {
        if (!wsSet.has(f)) changed.add(f)
      }
      // Also detect content changes by comparing file contents.
      for (const f of baseFiles) {
        if (wsSet.has(f)) {
          try {
            const baseContent = execSync(
              `git --git-dir="${checkout.cloneDir}/.git" show "${checkout.commit}:${f}"`,
              { encoding: 'utf8', timeout: 10000 },
            )
            const wsContent = readFileSync(join(workspace, f), 'utf8')
            if (baseContent !== wsContent) changed.add(f)
          } catch {
            // Binary file or read error — treat as changed.
            changed.add(f)
          }
        }
      }
      return [...changed].sort()
    }
    // Legacy: workspace has .git (worktree-based checkout).
    const output = execSync('git diff --name-only HEAD', {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 10000,
    })
    return output.trim().split('\n').filter(f => f.length > 0)
  } catch {
    return []
  }
}
