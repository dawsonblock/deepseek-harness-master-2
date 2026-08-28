/**
 * v0.19 trajectory collector.
 *
 * Wraps the v018 repair loop to run real-repository tasks. Captures full
 * trajectory data including repository context, tool calls, changed files,
 * and verification results for each attempt.
 *
 * The repair loop itself (RepairController.decide) is unchanged from v0.18.0.
 * Only the turn runner and verifier are adapted for real repositories.
 *
 * @module v019-trajectory-collector
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

import type { Context } from '@deepseek-ai/cordis'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { calculateCost, DEFAULT_PRICING_REGISTRY, lookupPricingAt } from '@deepseek-ai/dsh-token-meter'

import {
  type ModelRef,
  type RepairDecision,
  DEFAULT_REPAIR_LIMITS,
} from '@deepseek-ai/dsh-repair-controller'

import {
  type TurnResult,
  type VerifyResult,
  runRepairLoop,
} from './v018-repair-loop.ts'

import type { TaskManifest, VerificationCommand } from './v019-task-manifest.ts'
import type { RepoMetadata } from './v019-repo-checkout.ts'

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
  /** Files from the reference fix commit that the agent inspected. Empty if no reference fix exists. */
  readonly referenceFixFilesInspected: readonly string[]
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
 * Run one real-repository task through the v0.18 repair loop.
 *
 * The repair controller policy is frozen from v0.18.0. Only the turn runner
 * and verifier are adapted for real repository workspaces.
 */
export async function runTaskTrajectory(
  manifest: TaskManifest,
  workspace: string,
  experimentId: string,
  benchmarkEligible: boolean,
  repoMetadata: RepoMetadata,
  referenceFixFiles: readonly string[],
): Promise<TaskTrajectory> {
  const flashModel: ModelRef = { provider: 'deepseek', model: 'deepseek-v4-flash' }
  const proModel: ModelRef = { provider: 'deepseek', model: 'deepseek-v4-pro' }

  const loopResult = await runRepairLoop({
    taskId: manifest.taskId,
    workspace,
    initialTask: manifest.task.description,
    flashModel,
    proModel,
    runTurn: (task, model) => realTurnRunner(task, model, workspace, manifest),
    verify: (_ws, _model) => realVerifier(workspace, manifest),
    limits: {
      ...DEFAULT_REPAIR_LIMITS,
      maxFlashAttempts: manifest.limits.maxFlashAttempts,
      maxProAttempts: manifest.limits.maxProAttempts,
      maxTotalAttempts: manifest.limits.maxTotalAttempts,
    },
  })

  const changedFiles = getChangedFiles(workspace)
  const lastAttempt = loopResult.attempts.at(-1)
  const terminalOutcome = computeTerminalOutcome(
    loopResult.finalVerified,
    loopResult.holdoutPass,
    lastAttempt?.repairAction,
    lastAttempt?.repairReason,
  )
  const controlPlaneStatus: ControlPlaneStatus = loopResult.aborted ? 'FAIL' : 'PASS'
  const modelCapabilityStatus: 'PASS' | 'FAIL' | 'NOT_EVALUATED' =
    loopResult.aborted ? 'NOT_EVALUATED' : loopResult.finalVerified ? 'PASS' : 'FAIL'

  const allFilesInspected = collectFilesInspected(workspace)
  const referenceFixFilesInspected = referenceFixFiles.filter(f => allFilesInspected.includes(f))

  const attempts: AttemptTrajectory[] = loopResult.attempts.map(a => ({
    attempt: a.attempt,
    model: a.model,
    routingDecisionId: a.routingDecisionId,
    verified: a.verified,
    diagnosticPass: a.diagnosticPass,
    holdoutPass: a.holdoutPass,
    failureFingerprint: a.failureFingerprint,
    progress: a.progress,
    usage: {
      inputTokens: a.inputTokens,
      outputTokens: a.outputTokens,
      reasoningTokens: a.reasoningTokens,
      totalTokens: a.totalTokens,
      cacheReadTokens: a.cacheReadTokens,
      cacheMissTokens: a.cacheMissTokens,
    },
    costUsd: a.costUsd,
    latencyMs: a.latencyMs,
    repairAction: a.repairAction,
    repairReason: a.repairReason,
    changedFiles: getChangedFiles(workspace),
    toolCallCount: 0,
    filesInspected: [],
    terminalOutcome: a.repairAction === 'complete' && a.repairReason === 'qualification-failed'
      ? 'qualification-failed'
      : a.repairAction === 'complete' && a.verified
        ? 'verified-complete'
        : a.repairAction,
  }))

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
    finalVerified: loopResult.finalVerified,
    holdoutPass: loopResult.holdoutPass,
    verificationStrength: manifest.verification.strength,
    flashAttempts: loopResult.flashAttempts,
    proAttempts: loopResult.proAttempts,
    escalatedToPro: loopResult.escalatedToPro,
    totalCostUsd: loopResult.totalCostUsd,
    totalLatencyMs: loopResult.totalLatencyMs,
    totalOutputTokens: attempts.reduce((s, a) => s + a.usage.outputTokens, 0),
    totalCacheReadTokens: attempts.reduce((s, a) => s + a.usage.cacheReadTokens, 0),
    totalCacheMissTokens: attempts.reduce((s, a) => s + a.usage.cacheMissTokens, 0),
    attempts,
    changedFiles,
    referenceFixFilesInspected,
    rollbackUsed: false,
    aborted: loopResult.aborted,
    abortReason: loopResult.abortReason?.kind,
    terminalOutcome,
    failureCategory: undefined,
    timestamp: new Date().toISOString(),
  }
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
    referenceFixFilesInspected: [],
    rollbackUsed: false,
    aborted: true,
    abortReason: failureReason,
    terminalOutcome: 'infra-failure',
    failureCategory: 'F6-build-environment',
    timestamp: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Turn runner: boots the harness against a real repository workspace
// ---------------------------------------------------------------------------

async function realTurnRunner(
  task: string,
  model: ModelRef,
  workspace: string,
  _manifest: TaskManifest,
): Promise<TurnResult> {
  const configPath = await generateRepoConfig(model.model, workspace)
  const events: SessionEvent[] = []
  let uninstallFailLoud: (() => void) | undefined
  let ctx: Context | undefined

  try {
    await mkdir(join(workspace, 'sessions'), { recursive: true })
    loadEnv('v019-evaluation')
    uninstallFailLoud = installFailLoud('v019-evaluation')
    ctx = await boot('v019-evaluation', resolveConfigPath(configPath, undefined))
    const started = Date.now()
    const turnResult = await runFixtureTurn(ctx, { task, onEvent: (_sid, event) => events.push(event) })
    const latencyMs = Date.now() - started

    let inputTokens = 0
    let outputTokens = 0
    let reasoningTokens = 0
    let totalTokens = 0
    let cacheReadTokens = 0
    let cacheMissTokens = 0
    for (const event of events) {
      if (event.type === 'model/usage') {
        type UsageData = { usage: {
          inputTokens?: number
          outputTokens?: number
          reasoningTokens?: number
          totalTokens?: number
          cacheReadTokens?: number
          cacheMissTokens?: number
        } }
        const u = (event.data as unknown as UsageData).usage
        inputTokens += u.inputTokens ?? 0
        outputTokens += u.outputTokens ?? 0
        reasoningTokens += u.reasoningTokens ?? 0
        totalTokens += u.totalTokens ?? 0
        cacheReadTokens += u.cacheReadTokens ?? 0
        cacheMissTokens += u.cacheMissTokens ?? 0
      }
    }
    const output = turnResult.output
    if (output === '' && totalTokens === 0) {
      throw new Error('Provider returned no assistant output or usage')
    }
    const pricing = lookupPricingAt(DEFAULT_PRICING_REGISTRY, 'deepseek-official', model.model, new Date(started))
    const costUsd = pricing === undefined
      ? 0
      : calculateCost({
        inputTokens, outputTokens, cacheReadTokens, cacheMissTokens,
        reasoningTokens, totalTokens, source: 'provider',
      }, pricing).amount
    const routingDecision = events.find(e => e.type === 'model/routing-decision')
    const routingDecisionId = (routingDecision?.data as { routingDecisionId?: string })?.routingDecisionId ?? 'unknown'
    return {
      output, costUsd, latencyMs, inputTokens, outputTokens, reasoningTokens,
      totalTokens, cacheReadTokens, cacheMissTokens, routingDecisionId,
    }
  } finally {
    if (uninstallFailLoud !== undefined) uninstallFailLoud()
    if (ctx !== undefined) await ctx.fiber.dispose()
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
  const configPath = join(workspace, '.v019-cordis.yml')
  await writeFile(configPath, base, 'utf8')
  return configPath
}

// ---------------------------------------------------------------------------
// Verifier: runs the repository's own build and test commands
// ---------------------------------------------------------------------------

async function realVerifier(workspace: string, manifest: TaskManifest): Promise<VerifyResult> {
  const diagnosticPass = await runVerificationCommands(workspace, manifest.verification.diagnostic)
  let holdoutPass: boolean | undefined
  if (diagnosticPass) {
    if (manifest.verification.holdout.length > 0) {
      holdoutPass = await runVerificationCommands(workspace, manifest.verification.holdout)
    } else {
      holdoutPass = true
    }
  }
  const passed = diagnosticPass && (holdoutPass ?? true)
  return {
    passed,
    diagnosticPass,
    holdoutPass,
    evidence: {
      failedCriteria: passed ? [] : ['Verification commands did not pass'],
      failingTests: [],
      typeErrors: [],
      buildErrors: [],
      changedFiles: [],
    },
  }
}

async function runVerificationCommands(workspace: string, commands: readonly VerificationCommand[]): Promise<boolean> {
  for (const cmd of commands) {
    try {
      execSync(cmd.command, {
        cwd: workspace,
        encoding: 'utf8',
        timeout: 120000,
        stdio: 'pipe',
      })
    } catch {
      return false
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getChangedFiles(workspace: string): string[] {
  try {
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

function collectFilesInspected(_workspace: string): string[] {
  // The harness session log records file reads/inspections. For the initial
  // infrastructure, this returns an empty list; the full implementation will
  // extract file-read tool calls from the session event stream.
  return []
}

function computeTerminalOutcome(
  verified: boolean,
  _holdoutPass: boolean,
  repairAction: RepairDecision['action'] | undefined,
  repairReason: string | undefined,
): string {
  if (repairAction === 'complete' && repairReason === 'qualification-failed') return 'qualification-failed'
  if (repairAction === 'complete' && verified) return 'verified-complete'
  if (repairAction === 'stop') return 'budget-stop'
  if (repairAction === 'complete' && !verified) return 'failed-no-rescue'
  return 'unknown'
}
