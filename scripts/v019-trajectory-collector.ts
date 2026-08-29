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
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
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
import { type RepoMetadata, type RepoCheckout } from './v019-repo-checkout.ts'

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
      holdoutVerifier: createHoldoutVerifier(workspace, manifest),
      workspaceProvenanceProvider: createProvenanceProvider(workspace),
      rollbackProvider: createRollbackProvider(workspace, checkout),
    }
    await ctx.plugin(repairRuntimePlugin, repairConfig)

    // Register a goal completion verifier that runs the task's diagnostic
    // commands. The repair-runtime plugin watches goal/verification events
    // emitted by verifyCompletion() and handles repair decisions.
    const diagnosticVerifier: GoalCompletionVerifier = {
      name: 'v019-diagnostic',
      version: '1',
      verify: () => {
        const passed = runDiagnosticSync(workspace, manifest)
        return {
          name: 'v019-diagnostic',
          role: 'acceptance',
          passed,
          reason: passed ? '' : 'diagnostic verification commands failed',
          evidence: [],
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

        await goalsService.verifyCompletion(agent, { id: currentGoal.id, revision: currentGoal.revision })
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

async function generateRepoConfig(model: string, workspace: string): Promise<string> {
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

// ---------------------------------------------------------------------------
// Production RepairRuntime helpers: holdout, provenance, rollback, trajectory
// ---------------------------------------------------------------------------

/** Run diagnostic verification commands synchronously for the goal completion verifier. */
function runDiagnosticSync(workspace: string, manifest: TaskManifest): boolean {
  for (const cmd of manifest.verification.diagnostic) {
    try {
      execSync(cmd.command, { cwd: workspace, encoding: 'utf8', timeout: 120000, stdio: 'pipe' })
    } catch {
      return false
    }
  }
  return true
}

/** Create a holdout verifier for the production RepairRuntime. Stages holdout tests, runs them, and cleans up. */
function createHoldoutVerifier(workspace: string, manifest: TaskManifest): repairRuntimePlugin.HoldoutVerifier {
  return () => {
    if (manifest.verification.holdout.length === 0) {
      return { passed: true, reason: 'no holdout configured' }
    }
    // Stage holdout files synchronously.
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
    // Run holdout commands.
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
      // Clean up holdout files.
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
}

/** Create a workspace provenance provider that computes a SHA-256 hash of changed files. */
function createProvenanceProvider(workspace: string): repairRuntimePlugin.WorkspaceProvenanceProvider {
  return (context) => {
    const files = context.changedFiles as readonly string[]
    if (files.length === 0) return 'empty'
    const hash = createHash('sha256')
    for (const file of files) {
      try {
        const content = readFileSync(join(workspace, file))
        hash.update(file).update(':').update(content).update('\n')
      } catch {
        hash.update(file).update(':missing\n')
      }
    }
    return hash.digest('hex')
  }
}

/**
 * Create a rollback provider that restores the workspace to the base commit.
 * When a `RepoCheckout` is available (no `.git` in the workspace), uses
 * `git archive` re-extraction from the cached clone. Falls back to
 * `git checkout` for legacy worktree-based workspaces.
 */
function createRollbackProvider(workspace: string, checkout?: RepoCheckout): repairRuntimePlugin.RollbackProvider {
  return () => {
    try {
      if (checkout !== undefined) {
        // Synchronous restore: clear workspace and re-extract from clone.
        rmSync(checkout.workspace, { recursive: true, force: true })
        mkdirSync(checkout.workspace, { recursive: true })
        execSync(
          `git --git-dir="${checkout.cloneDir}/.git" archive "${checkout.commit}" | tar -x -C "${checkout.workspace}"`,
          { stdio: 'pipe', timeout: 60000 },
        )
      } else {
        execSync('git checkout -- .', { cwd: workspace, encoding: 'utf8', timeout: 30000, stdio: 'pipe' })
        execSync('git clean -fd', { cwd: workspace, encoding: 'utf8', timeout: 30000, stdio: 'pipe' })
      }
      return { success: true, rollbackTarget: 'base-commit' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, rollbackTarget: 'base-commit', failureReason: message }
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

  // Extract per-attempt data from model/usage events.
  const usageEvents = allEvents.filter(e => e.type === 'model/usage')
  const attempts: AttemptTrajectory[] = []
  let totalOutputTokens = 0
  let totalCacheReadTokens = 0
  let totalCacheMissTokens = 0

  for (let i = 0; i < usageEvents.length; i++) {
    const usageEvent = usageEvents[i] as Extract<SessionEvent, { type: 'model/usage' }>
    type UsageData = { usage: {
      inputTokens?: number
      outputTokens?: number
      reasoningTokens?: number
      totalTokens?: number
      cacheReadTokens?: number
      cacheMissTokens?: number
    } }
    const usage = (usageEvent.data as unknown as UsageData).usage
    const inputTokens = usage.inputTokens ?? 0
    const outputTokens = usage.outputTokens ?? 0
    const reasoningTokens = usage.reasoningTokens ?? 0
    const totalTokens = usage.totalTokens ?? 0
    const cacheReadTokens = usage.cacheReadTokens ?? 0
    const cacheMissTokens = usage.cacheMissTokens ?? 0
    totalOutputTokens += outputTokens
    totalCacheReadTokens += cacheReadTokens
    totalCacheMissTokens += cacheMissTokens

    // Compute cost for this attempt using the pricing registry.
    const turn = (usageEvent.data as { turn?: number }).turn ?? 0
    const routingEvent = allEvents.find(e => e.type === 'model/routing-decision' && (e.data as { turn?: number }).turn === turn) as
      | Extract<SessionEvent, { type: 'model/routing-decision' }> | undefined
    const routingDecisionId = routingEvent?.data.routingDecisionId ?? 'unrouted'
    const model = (routingEvent?.data as { selection?: { model?: string } }).selection?.model ?? 'unknown'

    // Fail loud on unpriced model usage: unknown pricing must not silently
    // become $0, which would make economic metrics look artificially better.
    // Use the event's actual timestamp for historical pricing accuracy.
    const eventTimestamp = new Date(usageEvent.time)
    const pricing = lookupPricingAt(DEFAULT_PRICING_REGISTRY, 'deepseek-official', model, eventTimestamp)
    if (pricing === undefined) {
      throw new Error(`UNPRICED_USAGE: no pricing found for model ${model}`)
    }
    const cost = calculateCost({
      inputTokens, outputTokens, cacheReadTokens, cacheMissTokens,
      reasoningTokens, totalTokens, source: 'provider',
    }, pricing)
    const costUsd = cost.amount

    // Find repair evidence and decision for this attempt.
    const repairEvidence = allEvents.find(e => e.type === 'repair/evidence' && (e.data as { attempt?: number }).attempt === i + 1) as
      | Extract<SessionEvent, { type: 'repair/evidence' }> | undefined
    const repairDecision = allEvents.find(e => e.type === 'repair/decision' && (e.data as { attempt?: number }).attempt === i + 1) as
      | Extract<SessionEvent, { type: 'repair/decision' }> | undefined
    const repairAction = repairDecision?.data.action ?? 'complete'
    const repairReason = repairDecision?.data.reason
    const failureFingerprint = repairEvidence?.data.failureFingerprint as string | undefined
    const progress = repairEvidence?.data.progress as string | undefined

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
      usage: { inputTokens, outputTokens, reasoningTokens, totalTokens, cacheReadTokens, cacheMissTokens },
      costUsd,
      // Per-attempt model latency: time from turn/start to model/usage event.
      latencyMs: (() => {
        const turnStart = allEvents.find(e => e.type === 'turn/start' && (e.data as { turn?: number }).turn === turn)
        if (turnStart === undefined) return 0
        return Math.max(0, usageEvent.time - turnStart.time)
      })(),
      repairAction,
      repairReason,
      changedFiles: attemptObservation.filesModified,
      toolCallCount: turnEvents.filter(e => e.type === 'tool/call').length,
      filesInspected: attemptObservation.filesInspected,
      terminalOutcome: outcome,
    })
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
  // task, failed holdout) is NOT a control plane failure.
  const controlPlaneStatus: ControlPlaneStatus =
    outcome === 'authority-undecidable' || outcome === 'model-unavailable' || outcome === 'rollback-failed'
      ? 'FAIL'
      : 'PASS'
  const modelCapabilityStatus: 'PASS' | 'FAIL' | 'NOT_EVALUATED' =
    outcome === 'authority-undecidable' || outcome === 'model-unavailable' ? 'NOT_EVALUATED' : finalVerified ? 'PASS' : 'FAIL'

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
