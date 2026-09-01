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

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
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

import type { DiagnosticKind, TaskManifest } from './v019-task-manifest.ts'
import { type RepoMetadata, type RepoCheckout, type BaselineSnapshot, restoreBaseline, hashWorkspaceContents, diffWorkspaceAgainstBaseline } from './v019-repo-checkout.ts'

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
  /** Hash of the experiment manifest that produced this task. Binds the trajectory to exact runtime configuration. */
  readonly experimentManifestHash: string
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
  /** Per-request provider outcomes for economic and reliability accounting. */
  readonly providerRequestOutcomes: readonly {
    readonly outcome: 'success' | 'error' | 'aborted' | 'max-tokens'
    readonly provider: string
    readonly model: string
  }[]
  readonly timestamp: string
}

/** Full trajectory record for one attempt within a task. */
export interface AttemptTrajectory {
  readonly attempt: number
  /** Durable attempt ID from the repair controller: `${repairId}#attempt-${attempt}`. */
  readonly attemptId: string | undefined
  readonly model: string
  readonly routingDecisionId: string
  readonly verified: boolean
  readonly diagnosticPass: boolean
  readonly holdoutPass: boolean | undefined
  readonly failureFingerprint: string | undefined
  readonly progress: string | undefined
  readonly failedKind?: DiagnosticKind
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
  experimentManifestHash: string,
  benchmarkEligible: boolean,
  repoMetadata: RepoMetadata,
  referenceFixFiles: readonly string[],
  checkout?: RepoCheckout,
  baseline?: BaselineSnapshot,
  repairStrategy: 'transactional' | 'iterative' = 'transactional',
): Promise<TaskTrajectory> {
  // Forensic-only invariant: reference fix files must never reach the model.
  // They are extracted from the verifier-only clone and used solely for
  // post-hoc intersection analysis (referenceFixFilesInspected/Modified).
  // The model sees only manifest.task.description and repair evidence.
  const flashModel: ModelRef = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

  const wallClockStart = Date.now()
  const allEvents: SessionEvent[] = []
  let uninstallFailLoud: (() => void) | undefined
  let ctx: Context | undefined

  let configHarnessDir: string | undefined
  let sessionsDir: string | undefined
  try {
    sessionsDir = join(tmpdir(), `dsh-v019-sessions-${manifest.taskId}-${randomUUID()}`)
    await mkdir(sessionsDir, { recursive: true })
    const { configPath, harnessDir: configDir } = await generateRepoConfig(flashModel.model, workspace, sessionsDir)
    configHarnessDir = configDir
    loadEnv('v019-evaluation')
    uninstallFailLoud = installFailLoud('v019-evaluation')
    ctx = await boot('v019-evaluation', resolveConfigPath(configPath, undefined))

    // Mount the repair-runtime plugin using the shared factory so the
    // live evaluator and composed qualification use the same configuration.
    const repairConfig = createRepairRuntimeConfig(workspace, manifest, checkout, baseline, repairStrategy)
    await ctx.plugin(repairRuntimePlugin, repairConfig)

    // Register a goal completion verifier that runs the task's diagnostic
    // commands. The repair-runtime plugin watches goal/verification events
    // emitted by verifyCompletion() and handles repair decisions.
    // Freeze verifier-controlled path set at baseline. The diagnostic
    // verifier checks exactly these paths — no dynamic rediscovery — so
    // a model creating a new test file does not cause a false mismatch.
    const verifierSnapshot = freezeVerifierSnapshot(workspace)

    const diagnosticVerifier: GoalCompletionVerifier = {
      name: 'v019-diagnostic',
      version: '1',
      verify: () => {
        // Check verifier-controlled files against the frozen snapshot.
        if (!verifyAgainstSnapshot(workspace, verifierSnapshot)) {
          return {
            name: 'v019-diagnostic',
            role: 'acceptance',
            passed: false,
            reason: 'verifier-controlled files were modified by the model — task rejected',
            evidence: [`expected hash: ${verifierSnapshot.controlledHash}`, `controlled paths: ${verifierSnapshot.controlledPaths.join(', ')}`],
          }
        }
        const result = runDiagnosticSync(workspace, manifest)
        const evidence: string[] = []
        if (!result.passed) {
          if (result.failedKind !== undefined) {
            evidence.push(`Kind: ${result.failedKind}`)
          }
          if (result.failedCommand !== undefined) {
            evidence.push(`Command: ${result.failedCommand}`)
          }
          if (result.exitCode !== undefined) {
            evidence.push(`ExitCode: ${result.exitCode}`)
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
          reason: result.passed ? '' : `${result.failedKind ?? 'diagnostic'} verification failed: ${result.failedCommand ?? 'unknown command'}`,
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

      // Detect turn-end errors that the agent-loop driver boundary
      // silently contains. The agent goes idle even when the model call
      // failed (e.g., authentication error, empty response). The turn/end
      // event records the failure reason — check it here so the trajectory
      // reflects the actual error rather than masking it as a repair failure.
      const turnEnds = allEvents.filter(e => e.type === 'turn/end')
      const errorTurnEnd = turnEnds.find((e) => {
        const reason = (e.data as { reason?: { kind?: string } }).reason
        return reason?.kind === 'error'
      })
      if (errorTurnEnd !== undefined) {
        const reason = (errorTurnEnd.data as { reason: { kind: string; error?: { message?: string; code?: string } } }).reason
        const message = reason.error?.message ?? 'unknown model error'
        const code = reason.error?.code ?? 'UNKNOWN'
        throw new Error(`MODEL_ERROR: ${code}: ${message}`)
      }

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
    // Clean up harness and session directories from os.tmpdir().
    if (configHarnessDir !== undefined) {
      await rm(configHarnessDir, { recursive: true, force: true })
    }
    if (sessionsDir !== undefined) {
      await rm(sessionsDir, { recursive: true, force: true })
    }
  }

  // Extract trajectory from session events.
  return buildTrajectoryFromEvents(
    allEvents, manifest, workspace, experimentId, experimentManifestHash, benchmarkEligible,
    repoMetadata, referenceFixFiles, wallClockStart, checkout, baseline,
  )
}

/** Build a FAILED_INFRA trajectory for tasks that failed before reaching the repair loop. */
export function buildInfraFailureTrajectory(
  manifest: TaskManifest,
  experimentId: string,
  experimentManifestHash: string,
  benchmarkEligible: boolean,
  repoMetadata: RepoMetadata | undefined,
  failureReason: string,
): TaskTrajectory {
  return {
    taskId: manifest.taskId,
    taskManifestHash: manifest.manifestHash,
    experimentId,
    experimentManifestHash,
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
    providerRequestOutcomes: [],
    timestamp: new Date().toISOString(),
  }
}

export async function generateRepoConfig(
  model: string,
  workspace: string,
  sessionRoot: string,
): Promise<{ configPath: string; harnessDir: string }> {
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
  // Add the model router before the agent-spine so it joins the
  // agent/request waterfall. The router emits model/routing-decision and
  // model/usage events that the repair runtime requires for attempt
  // accounting and routing authority resolution.
  base = base.replace(
    /- id: agent-spine/,
    `- id: model-router
  name: '@deepseek-ai/dsh-llm-model-router'
  config:
    fastRoute:
      provider: deepseek-official
      model: deepseek-v4-flash
    heavyRoute:
      provider: deepseek-official
      model: deepseek-v4-pro
      reasoningEffort: max
    escalationThreshold: 4
    recordAllDecisions: true
- id: agent-spine`,
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
  // Write the config outside the model workspace so it does not
  // contaminate the B0 baseline or appear in changed-file diffs.
  // The sessions directory is also kept outside the workspace.
  // The caller is responsible for cleaning up the returned harnessDir.
  base = base.replace(/root: '\.\/\.sessions'/, `root: '${sessionRoot}'`)
  if (base.includes("root: './.sessions'")) {
    throw new Error('Session root replacement failed — base cordis.yml still contains the default .sessions root')
  }
  const harnessDir = join(tmpdir(), `dsh-v019-harness-${Date.now()}`)
  await mkdir(harnessDir, { recursive: true })
  const configPath = join(harnessDir, 'cordis.yml')
  await writeFile(configPath, base, 'utf8')
  return { configPath, harnessDir }
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
  readonly failedKind?: DiagnosticKind
  readonly exitCode?: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Infer a diagnostic kind from a command string when the manifest does not
 * declare one. Matches common test runners, type checkers, build tools, and
 * linters.
 */
function inferDiagnosticKind(command: string): DiagnosticKind {
  const cmd = command.toLowerCase()
  if (/\b(vitest|jest|mocha|pytest|cargo test|go test|npm test|npm run test|pnpm test|pnpm run test|yarn test|\.test\.|test_)/.test(cmd)) return 'test'
  if (/\b(tsc|typecheck|type-check|pyright|mypy|cargo check)/.test(cmd)) return 'typecheck'
  if (/\b(eslint|oxlint|biome|ruff|flake8|clippy|golangci)/.test(cmd)) return 'lint'
  return 'build'
}

/**
 * Run diagnostic verification commands synchronously for the goal completion
 * verifier. Captures stdout/stderr from failed commands so the repair model
 * receives real test failure output instead of a generic message. Each
 * failure is tagged with a diagnostic kind (test/typecheck/build/lint) so
 * the repair model and failure taxonomy can classify the failure category.
 */
function runDiagnosticSync(workspace: string, manifest: TaskManifest): DiagnosticResult {
  for (const cmd of manifest.verification.diagnostic) {
    try {
      execSync(cmd.command, { cwd: workspace, encoding: 'utf8', timeout: 120000, stdio: 'pipe' })
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string; status?: number }
      const stdout = typeof err.stdout === 'string' ? err.stdout : ''
      const stderr = typeof err.stderr === 'string' ? err.stderr : ''
      // Truncate to avoid overwhelming the model prompt; keep the tail
      // where stack traces and assertion failures typically appear.
      const maxLen = 4000
      const truncate = (s: string): string => s.length > maxLen ? `...(${s.length - maxLen} chars truncated)...\n${s.slice(-maxLen)}` : s
      return {
        passed: false,
        failedCommand: cmd.command,
        failedKind: cmd.kind ?? inferDiagnosticKind(cmd.command),
        ...typeof err.status === 'number' ? { exitCode: err.status } : {},
        stdout: truncate(stdout),
        stderr: truncate(stderr),
      }
    }
  }
  return { passed: true, stdout: '', stderr: '' }
}

/**
 * Frozen snapshot of verifier-controlled state at task initialization.
 *
 * The controlled path set is discovered once at baseline and never
 * rediscovered. This prevents the multi-file verifier bug where a model
 * creating a new test file causes the second discovery to include it,
 * producing a hash mismatch even though the model was supposed to create
 * that file.
 */
interface VerifierSnapshot {
  readonly version: 'v1'
  /** Paths whose contents must not change between baseline and verification. */
  readonly controlledPaths: readonly string[]
  /** SHA-256 over the controlled paths' contents at baseline. */
  readonly controlledHash: string
  /** Paths that must not exist at verification time. */
  readonly mustRemainAbsent: readonly string[]
}

/** Config files that are always verifier-controlled, whether present or absent. */
const VERIFIER_CONFIG_FILES = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'tsconfig.json',
  'vitest.config.ts',
  'vitest.config.mts',
  'vitest.config.js',
  'vite.config.ts',
] as const

/** Test setup files that are always verifier-controlled. */
const VERIFIER_TEST_SETUP_FILES = [
  'tests/setup.ts', 'tests/setup.js', 'test/setup.ts', 'test/setup.js',
  'tests/setup.mts', '__tests__/setup.ts', 'tests/setup.py', 'conftest.py',
] as const

/** Test file patterns for discovering baseline test files. */
const TEST_FILE_PATTERNS = [
  /\.test\.ts$/, /\.test\.tsx$/, /\.test\.js$/, /\.test\.jsx$/,
  /\.spec\.ts$/, /\.spec\.tsx$/, /\.spec\.js$/, /\.spec\.jsx$/,
  /\.test\.py$/, /\.test\.rs$/,
  /^test_.*\.py$/, /_test\.py$/, /^test_.*\.rs$/, /_test\.rs$/,
  /\.test\.go$/, /_test\.go$/,
  /\.test\.java$/, /Test\.java$/,
] as const

/** Directories to walk for test files. */
const TEST_DIRS = ['tests', 'test', '__tests__', 'src/__tests__'] as const

/**
 * Freeze the verifier-controlled path set at task initialization.
 *
 * Discovers all verifier-controlled files (config files, test setup, and
 * existing test files) and computes a hash over their current contents.
 * The returned snapshot is used at verification time to check exactly
 * these paths — no dynamic rediscovery occurs.
 *
 * @param workspace - the model workspace at baseline state.
 * @returns a frozen verifier snapshot.
 */
export function freezeVerifierSnapshot(workspace: string): VerifierSnapshot {
  const controlledPaths: string[] = [...VERIFIER_CONFIG_FILES, ...VERIFIER_TEST_SETUP_FILES]

  // Walk test directories for existing test files.
  const walkTestDir = (dirRel: string, dirAbs: string): void => {
    try {
      const entries = readdirSync(dirAbs, { withFileTypes: true })
      for (const entry of entries) {
        const entryAbs = join(dirAbs, entry.name)
        const entryRel = join(dirRel, entry.name)
        if (entry.isDirectory()) {
          walkTestDir(entryRel, entryAbs)
        } else if (entry.isFile() && TEST_FILE_PATTERNS.some(p => p.test(entry.name))) {
          controlledPaths.push(entryRel)
        }
      }
    } catch {
      // Test directory doesn't exist — skip.
    }
  }
  for (const dir of TEST_DIRS) {
    walkTestDir(dir, join(workspace, dir))
  }

  // Deduplicate and sort before hashing so verification uses the same order.
  const sortedPaths = [...new Set(controlledPaths)].sort()

  // Compute hash over exactly the discovered paths.
  const hash = createHash('sha256')
  for (const file of sortedPaths) {
    const absPath = join(workspace, file)
    try {
      const content = readFileSync(absPath)
      hash.update(file).update(':').update(content).update('\n')
    } catch {
      // Config and setup files are always included, even when absent.
      // Test files that don't exist are not in the path set (they were
      // only added if they existed during the walk).
      const isConfigOrSetup =
        (VERIFIER_CONFIG_FILES as readonly string[]).includes(file) ||
        (VERIFIER_TEST_SETUP_FILES as readonly string[]).includes(file)
      if (isConfigOrSetup) {
        hash.update(file).update(':absent\n')
      }
    }
  }

  // Hash node_modules structural integrity.
  const nodeModulesPath = join(workspace, 'node_modules')
  try {
    const nmEntries = readdirSync(nodeModulesPath, { withFileTypes: true })
    nmEntries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of nmEntries) {
      hash.update('node_modules/').update(entry.name).update(':').update(entry.isDirectory() ? 'dir' : 'file').update('\n')
    }
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

  return {
    version: 'v1',
    controlledPaths: sortedPaths,
    controlledHash: hash.digest('hex'),
    mustRemainAbsent: [],
  }
}

/**
 * Verify the workspace against a frozen verifier snapshot.
 *
 * Hashes exactly the paths in the snapshot's `controlledPaths` — no
 * dynamic rediscovery. A model creating a new test file that was not in
 * the baseline path set does not cause a mismatch. A model modifying an
 * existing controlled file does.
 *
 * @param workspace - the model workspace after model execution.
 * @param snapshot - the frozen verifier snapshot from baseline.
 * @returns true if the workspace matches the snapshot, false otherwise.
 */
export function verifyAgainstSnapshot(workspace: string, snapshot: VerifierSnapshot): boolean {
  const hash = createHash('sha256')
  for (const file of snapshot.controlledPaths) {
    const absPath = join(workspace, file)
    try {
      const content = readFileSync(absPath)
      hash.update(file).update(':').update(content).update('\n')
    } catch {
      const isConfigOrSetup =
        (VERIFIER_CONFIG_FILES as readonly string[]).includes(file) ||
        (VERIFIER_TEST_SETUP_FILES as readonly string[]).includes(file)
      if (isConfigOrSetup) {
        hash.update(file).update(':absent\n')
      }
      // A test file that was present at baseline but is now absent means
      // the model deleted it — this is a modification and must be detected.
      if (!isConfigOrSetup) {
        hash.update(file).update(':deleted\n')
      }
    }
  }

  // Hash node_modules structural integrity.
  const nodeModulesPath = join(workspace, 'node_modules')
  try {
    const nmEntries = readdirSync(nodeModulesPath, { withFileTypes: true })
    nmEntries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of nmEntries) {
      hash.update('node_modules/').update(entry.name).update(':').update(entry.isDirectory() ? 'dir' : 'file').update('\n')
    }
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

  if (hash.digest('hex') !== snapshot.controlledHash) {
    return false
  }

  // Check mustRemainAbsent paths.
  for (const absentPath of snapshot.mustRemainAbsent) {
    if (existsSync(join(workspace, absentPath))) {
      return false
    }
  }

  return true
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
    // rsync --delete ensures candidate deletions are reflected: a
    // correct candidate that deletes a baseline source file must be
    // tested as though that file no longer exists. The weaker cp -R
    // fallback was removed because it does not apply deletions.
    try {
      execSync(
        `rsync -a --delete --exclude='node_modules' --exclude='.git' --exclude='dist' --exclude='sessions' "${workspace}/" "${verifierWorkspace}/"`,
        { stdio: 'pipe', timeout: 60000 },
      )
    } catch {
      return { passed: false, reason: 'rsync is required for holdout verification but failed or is unavailable' }
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
 * Create a changed-files provider that diffs the current workspace against
 * the frozen baseline snapshot. Returns workspace-relative paths for files
 * that are new, modified, or deleted relative to B0. When no baseline is
 * available, returns an empty array (the runtime falls back to tool-observation
 * inference in that case, but the production path always has a baseline).
 */
function createChangedFilesProvider(
  workspace: string,
  baseline?: BaselineSnapshot,
): repairRuntimePlugin.ChangedFilesProvider {
  if (baseline === undefined) return () => []
  return () => diffWorkspaceAgainstBaseline(workspace, baseline)
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

/**
 * Create the production `RepairRuntimeConfig` for a v019 evaluation task.
 * Both the live Batch A evaluator and the composed runtime qualification
 * call this factory to prevent configuration drift between the qualified
 * and live compositions.
 *
 * @param workspace - the model workspace root.
 * @param manifest - the task manifest with limits and verification config.
 * @param checkout - the repository checkout (for legacy rollback fallback).
 * @param baseline - the frozen post-setup baseline snapshot.
 * @returns the `RepairRuntimeConfig` for `ctx.plugin(repairRuntimePlugin, config)`.
 */
export function createRepairRuntimeConfig(
  workspace: string,
  manifest: TaskManifest,
  checkout?: RepoCheckout,
  baseline?: BaselineSnapshot,
  repairStrategy: 'transactional' | 'iterative' = 'transactional',
): RepairRuntimeConfig {
  const flashModel: ModelRef = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  const proModel: ModelRef = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
  return {
    enabled: true,
    flashModel: { provider: flashModel.provider, model: flashModel.model },
    proModel: { provider: proModel.provider, model: proModel.model },
    maxFlashAttempts: manifest.limits.maxFlashAttempts,
    maxProAttempts: manifest.limits.maxProAttempts,
    maxTotalAttempts: manifest.limits.maxTotalAttempts,
    holdoutVerifier: createHoldoutVerifier(workspace, manifest, baseline),
    workspaceProvenanceProvider: createProvenanceProvider(workspace),
    // Transactional repair rolls back to baseline before each attempt.
    // Iterative repair preserves workspace state, letting the model build
    // on its prior changes. The strategy is an experiment variable.
    ...repairStrategy === 'transactional'
      ? { rollbackProvider: createRollbackProvider(workspace, checkout, baseline) }
      : {},
    changedFilesProvider: createChangedFilesProvider(workspace, baseline),
    failOnMissingUsage: true,
  }
}

/** Build a TaskTrajectory from the session events collected during the repair runtime flow. */
function buildTrajectoryFromEvents(
  allEvents: readonly SessionEvent[],
  manifest: TaskManifest,
  workspace: string,
  experimentId: string,
  experimentManifestHash: string,
  benchmarkEligible: boolean,
  repoMetadata: RepoMetadata,
  referenceFixFiles: readonly string[],
  wallClockStart: number,
  checkout?: RepoCheckout,
  baseline?: BaselineSnapshot,
): TaskTrajectory {
  // Extract repair attempts from repair/evidence and repair/decision events.
  const repairEvents = allEvents.filter(e => e.type === 'repair/evidence' || e.type === 'repair/decision' || e.type === 'repair/completed')
  const completedEvent = repairEvents.find((e): e is Extract<SessionEvent, { type: 'repair/completed' }> => e.type === 'repair/completed')

  // Derive flash/pro attempt counts from the attempts array after it is
  // built, not from the repair/completed event. The repair runtime's
  // counters can diverge from the actual attempt models when a mid-turn
  // routing escalation occurs (Flash starts the turn, Pro finishes it).
  // The attempts array is built from model/usage events grouped by turn,
  // with the model extracted from the first routing decision for the turn,
  // so it correctly attributes the attempt to the starting model.
  const totalCostUsd = completedEvent?.data.totalCostUsd ?? 0
  const finalVerified = completedEvent?.data.verified ?? false
  const outcome = completedEvent?.data.outcome ?? 'unknown'

  // Determine holdout pass from the outcome.
  const holdoutPass = outcome === 'qualification-failed' ? false : finalVerified

  // Extract per-attempt data from model/usage events, grouped by turn.
  // A turn is one logical attempt: the model makes multiple steps (tool
  // calls) within a turn, each with its own routing decision and usage
  // event, but they all belong to one attempt at the task. Grouping by
  // turn prevents inflating the attempt count when the model makes many
  // tool calls in a single turn.
  const usageEvents = allEvents.filter(e => e.type === 'model/usage')
  type UsageData = { usage: {
    inputTokens?: number
    outputTokens?: number
    reasoningTokens?: number
    totalTokens?: number
    cacheReadTokens?: number
    cacheMissTokens?: number
  } }

  // Group usage events by turn, preserving order of first appearance.
  const turnGroups: { turn: number; events: typeof usageEvents }[] = []
  for (const usageEvent of usageEvents) {
    const turn = (usageEvent.data as { turn?: number }).turn ?? 0
    const existing = turnGroups.find(g => g.turn === turn)
    if (existing !== undefined) {
      existing.events.push(usageEvent)
    } else {
      turnGroups.push({ turn, events: [usageEvent] })
    }
  }

  const attempts: AttemptTrajectory[] = []
  let totalOutputTokens = 0
  let totalCacheReadTokens = 0
  let totalCacheMissTokens = 0

  for (let i = 0; i < turnGroups.length; i++) {
    const group = turnGroups[i]
    if (group === undefined) continue
    const firstUsageEvent = group.events[0] as Extract<SessionEvent, { type: 'model/usage' }>

    // Aggregate usage across all steps in this turn.
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

    const turn = group.turn
    // Use the first routing decision for this turn as the representative
    // routing decision for the attempt. All steps in the turn share the
    // same turn number, and the first routing decision establishes the
    // model that was selected.
    const routingEvent = allEvents.find(e =>
      e.type === 'model/routing-decision'
      && (e.data as { turn?: number }).turn === turn,
    ) as Extract<SessionEvent, { type: 'model/routing-decision' }> | undefined
    const routingDecisionId = routingEvent?.data.routingDecisionId ?? `unrouted-turn-${turn}`
    const model = (routingEvent?.data as { selected?: { model?: string } }).selected?.model
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

    // Find repair evidence and decision for this attempt. Join by turn
    // first (all steps in a turn share the same repair cycle), then fall
    // back to routingDecisionId and attempt ordinal for legacy events.
    const repairEvidence = allEvents.find(e =>
      e.type === 'repair/evidence'
      && (e.data as { turn?: number }).turn === turn,
    ) as Extract<SessionEvent, { type: 'repair/evidence' }> | undefined
      ?? allEvents.find(e =>
        e.type === 'repair/evidence'
        && (e.data as { routingDecisionId?: string }).routingDecisionId === routingDecisionId,
      ) as Extract<SessionEvent, { type: 'repair/evidence' }> | undefined
      ?? allEvents.find(e => e.type === 'repair/evidence' && (e.data as { attempt?: number }).attempt === i + 1) as
        | Extract<SessionEvent, { type: 'repair/evidence' }> | undefined
    const repairDecision = allEvents.find(e =>
      e.type === 'repair/decision'
      && (e.data as { turn?: number }).turn === turn,
    ) as Extract<SessionEvent, { type: 'repair/decision' }> | undefined
      ?? allEvents.find(e =>
        e.type === 'repair/decision'
        && (e.data as { routingDecisionId?: string }).routingDecisionId === routingDecisionId,
      ) as Extract<SessionEvent, { type: 'repair/decision' }> | undefined
      ?? allEvents.find(e => e.type === 'repair/decision' && (e.data as { attempt?: number }).attempt === i + 1) as
        | Extract<SessionEvent, { type: 'repair/decision' }> | undefined
    const repairAction = repairDecision?.data.action ?? 'complete'
    const repairReason = repairDecision?.data.reason
    const failureFingerprint = repairEvidence?.data.failureFingerprint
    const progress = repairEvidence?.data.progress
    const rawFailedKind = repairEvidence?.data.failedKind
    const failedKind = rawFailedKind === 'test' || rawFailedKind === 'typecheck' || rawFailedKind === 'build' || rawFailedKind === 'lint'
      ? rawFailedKind
      : undefined
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

    // Extract the durable attemptId from repair events. Falls back to
    // undefined for one-shot success (no repair/evidence event).
    const attemptId = repairEvidence?.data.attemptId ?? repairDecision?.data.attemptId

    attempts.push({
      attempt: i + 1,
      attemptId,
      model,
      routingDecisionId,
      verified: repairAction === 'complete' && finalVerified,
      diagnosticPass: repairAction === 'complete',
      holdoutPass: repairAction === 'complete' ? holdoutPass : undefined,
      failureFingerprint,
      progress,
      ...failedKind !== undefined ? { failedKind } : {},
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

  // Fail closed: every model/request (actual provider invocation) must
  // reconcile with either a model/usage event or a model/request-outcome
  // event. A model/request represents a paid call to the provider. A
  // model/routing-decision that is rejected by post-routing context
  // preflight does NOT produce a model/request and is not billed — so
  // reconciliation against model/request, not model/routing-decision, is
  // the correct accounting boundary.
  //
  // Reconciliation is one-to-one by (turn, step, attempt): routingDecisionId
  // identifies route selection for a step, not an individual provider call,
  // so retries of the same step share it. A failed attempt with a
  // model/request-outcome carrying a failure is valid evidence; only a
  // model/request with neither usage nor outcome is a lost request.
  const requestEvents = allEvents.filter(e => e.type === 'model/request')
  const outcomeEvents = allEvents.filter(e => e.type === 'model/request-outcome')
  if (requestEvents.length > 0 && usageEvents.length === 0 && outcomeEvents.length === 0) {
    throw new Error(`MISSING_USAGE_EVIDENCE: ${requestEvents.length} model/request event(s) but 0 model/usage and 0 model/request-outcome events for task ${manifest.taskId}`)
  }

  for (const requestEvent of requestEvents) {
    const requestData = requestEvent.data as { turn: number; step: number; attempt: number; routingDecisionId?: string }
    const key = `${requestData.turn}:${requestData.step}:${requestData.attempt}`
    const hasUsage = usageEvents.some((usageEvent) => {
      const usageData = usageEvent.data as { turn: number; step: number; attempt: number }
      return `${usageData.turn}:${usageData.step}:${usageData.attempt}` === key
    })
    const hasOutcome = outcomeEvents.some((outcomeEvent) => {
      const outcomeData = outcomeEvent.data as { turn: number; step: number; attempt: number }
      return `${outcomeData.turn}:${outcomeData.step}:${outcomeData.attempt}` === key
    })
    if (!hasUsage && !hasOutcome) {
      throw new Error(`MISSING_USAGE_EVIDENCE: model/request (turn=${requestData.turn}, step=${requestData.step}, attempt=${requestData.attempt}) has no matching model/usage or model/request-outcome event for task ${manifest.taskId}`)
    }
  }

  // Use the same diffWorkspaceAgainstBaseline function as the repair runtime's
  // ChangedFilesProvider so the trajectory record and the repair evidence
  // agree on what changed. Fall back to the git-based getChangedFiles only
  // when no baseline snapshot is available (legacy worktree-based checkout).
  const changedFiles = baseline !== undefined
    ? diffWorkspaceAgainstBaseline(workspace, baseline)
    : getChangedFiles(workspace, checkout)
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
                    : outcome === 'repair-handler-error' ? 'repair-handler-error'
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
      || outcome === 'repair-handler-error'
      || outcome === 'unknown'
      ? 'FAIL'
      : 'PASS'
  // Derive flash/pro counts from the attempts array. Each attempt's model
  // is extracted from the first routing decision for its turn, so mid-turn
  // routing escalations do not inflate the Pro counter.
  const flashAttempts = attempts.filter(a => a.model === 'deepseek-v4-flash').length
  const proAttempts = attempts.filter(a => a.model === 'deepseek-v4-pro').length
  const escalatedToPro = proAttempts > 0
  // Model capability is NOT_EVALUATED when the control plane failed before
  // the model had a fair chance to demonstrate capability. For rollback
  // failures and unknown outcomes, the model's capability cannot be assessed
  // because the harness did not complete the evaluation pipeline.
  const modelCapabilityStatus: 'PASS' | 'FAIL' | 'NOT_EVALUATED' =
    outcome === 'authority-undecidable'
      || outcome === 'model-unavailable'
      || outcome === 'rollback-failed'
      || outcome === 'workspace-provenance-failed'
      || outcome === 'repair-handler-error'
      || outcome === 'unknown'
      ? 'NOT_EVALUATED'
      : finalVerified ? 'PASS' : 'FAIL'

  return {
    taskId: manifest.taskId,
    taskManifestHash: manifest.manifestHash,
    experimentId,
    experimentManifestHash,
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
    aborted: outcome === 'authority-undecidable' || outcome === 'model-unavailable' || outcome === 'rollback-failed' || outcome === 'repair-handler-error',
    abortReason: outcome === 'authority-undecidable' ? 'authority-undecidable'
      : outcome === 'model-unavailable' ? 'model-unavailable'
        : outcome === 'rollback-failed' ? 'rollback-failed'
          : outcome === 'repair-handler-error' ? 'repair-handler-error'
            : undefined,
    terminalOutcome,
    failureCategory: undefined,
    providerRequestOutcomes: allEvents
      .filter(e => e.type === 'model/request-outcome')
      .map((e) => {
        const d = e.data as { outcome: 'success' | 'error' | 'aborted' | 'max-tokens'; provider: string; model: string }
        return { outcome: d.outcome, provider: d.provider, model: d.model }
      }),
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
      ).trim().split('\n').filter(f => f.length > 0 && !f.endsWith('/'))
      const workspaceFiles = execSync(`find "${workspace}" -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/.tmp/*'`, {
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
