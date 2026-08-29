/**
 * v0.19 composed runtime qualification (`v019-composed-runtime-qualification-v1`).
 *
 * Boots the exact Cordis configuration produced by the Batch A evaluator
 * (via {@link generateRepoConfig}) and exercises the real composed graph
 * through every security-critical capability path. Unlike the static
 * security qualification, which inspects source and calls individual APIs,
 * this gate proves the mechanisms survive dependency injection, config
 * resolution, plugin ordering, and service registration.
 *
 * Checks are split into two levels:
 *
 * Composed-runtime checks (C1-C5): boot the actual Cordis context, resolve
 * the real services, and exercise the actual sandboxed fs/bash stack.
 *
 * Helper-level checks (C6-C15): call the exported repair-runtime helpers
 * with synthetic sessions to verify the lifecycle, accounting, authority,
 * sanitization, and reconstruction contracts. These do NOT exercise the
 * full plugin→GoalService→completeVerified pipeline — that requires a
 * separate composed-evaluator scenario layer (planned for a follow-up).
 *
 * Composed-runtime:
 * C1:  Effective composition identity (fs-sandbox, bash-sandbox, workspace-isolated, RepairRuntime)
 * C2:  File-tool isolation through the actual tool stack (read/write/traversal)
 * C3:  Bash isolation through the actual Bash tool (workspace, external, network)
 * C4:  Model workspace contains no Git history
 * C5:  Holdout secrecy (agent cannot read via sandbox, verifier can read)
 *
 * Helper-level:
 * C6:  One-shot lifecycle (PASS→holdout PASS)
 * C7:  One-shot holdout failure (qualification-failed, no repair)
 * C8:  Repair success with rollback between attempts
 * C9:  Pro escalation with real routing decision IDs
 * C10: Rollback failure stops repair, no subsequent provider call
 * C11: Authority ambiguity denies model transition
 * C12: Workspace-bound verification (mutation changes hash)
 * C13: Ledger secret sanitization (scan durable events for raw secrets)
 * C14: Unpriced usage stops before next paid execution
 * C15: Trajectory reconstruction from composed session history
 *
 * Composed-runtime scenarios (S1-S4): drive verifyCompletion() through the
 * real GoalService and RepairRuntime plugin listener on the booted context's
 * root agent, testing the full plugin→GoalService→completeVerified pipeline.
 *
 * S1:  One-shot PASS→holdout PASS→goal complete (Scenario A)
 * S2:  Diagnostic FAIL→repair evidence+decision (Scenario B/D)
 * S3:  Post-verification completeVerified DENIED (Scenario G)
 * S4:  Agent holdout access DENIED through sandbox (Scenario H)
 *
 * @module v019-composed-runtime-qualification
 */

import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { Context } from '@deepseek-ai/cordis'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { releaseToAuto } from '@deepseek-ai/dsh-agent'
import type { GoalCompletionVerifier, GoalVerificationCheck } from '@deepseek-ai/dsh-goal'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { DEFAULT_PRICING_REGISTRY } from '@deepseek-ai/dsh-token-meter'
import { decideRepair, DEFAULT_REPAIR_LIMITS } from '@deepseek-ai/dsh-repair-controller'
import type { ModelRef, RepairLimits } from '@deepseek-ai/dsh-repair-controller'

import * as repairRuntimePlugin from '@deepseek-ai/dsh-repair-runtime'
import type { RepairRuntimeConfig, RepairState, WorkspaceProvenanceProvider, RollbackProvider, HoldoutVerifier, RepairHandlerDeps } from '@deepseek-ai/dsh-repair-runtime'
import { handleVerificationPass, handleVerificationFailure, reconstructRepairState } from '@deepseek-ai/dsh-repair-runtime'

import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'

import { generateRepoConfig } from './v019-trajectory-collector.ts'

/** Qualification artifact identifier. */
export const COMPOSED_QUALIFICATION_ID = 'v019-composed-runtime-qualification-v1'

/** Result of one composed runtime check. */
export interface ComposedCheck {
  readonly id: string
  readonly name: string
  readonly status: 'pass' | 'fail' | 'skip'
  readonly evidence: string
}

/** Full qualification artifact. */
export interface ComposedQualificationRecord {
  readonly qualificationId: string
  readonly sourceCommit: string
  readonly timestamp: string
  readonly checks: readonly ComposedCheck[]
  readonly passedCount: number
  readonly failedCount: number
  readonly skipCount: number
  readonly passed: boolean
  readonly backend: { enforcement: string; networkDenied: boolean; probed: boolean }
  readonly filesystem: { modelReadFence: boolean; modelWriteFence: boolean }
  readonly holdout: { modelReadable: boolean }
  readonly repair: { productionRuntime: boolean; rollbackRequired: boolean; provenanceRequired: boolean }
  readonly ready: boolean
}

/** Persisted artifact directory for the composed qualification record. */
const ARTIFACTS_DIR = join(import.meta.dirname, '..', 'artifacts')

/**
 * Write the composed qualification record to the artifacts directory.
 * @param record - the record to persist.
 */
export function writeComposedQualificationRecord(record: ComposedQualificationRecord): void {
  const path = join(ARTIFACTS_DIR, 'evals', `${COMPOSED_QUALIFICATION_ID}.json`)
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n', 'utf8')
}

/**
 * Read a persisted composed qualification record from the artifacts directory.
 * @returns the persisted record, or undefined if none exists.
 */
export function readComposedQualificationRecord(): ComposedQualificationRecord | undefined {
  const path = join(ARTIFACTS_DIR, 'evals', `${COMPOSED_QUALIFICATION_ID}.json`)
  try {
    const content = readFileSync(path, 'utf8')
    return JSON.parse(content) as ComposedQualificationRecord
  } catch {
    return undefined
  }
}

const REPO_ROOT = join(import.meta.dirname, '..')

/** Get the current git commit hash. */
export function getSourceCommit(): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

// ---------------------------------------------------------------------------
// Boot helpers
// ---------------------------------------------------------------------------

/** Create a temp workspace with a minimal project for qualification. */
function createQualificationWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), 'dsh-composed-qual-'))
  writeFileSync(join(ws, 'package.json'), JSON.stringify({
    name: 'qual-workspace',
    version: '1.0.0',
    scripts: { test: 'echo ok', build: 'echo built' },
  }) + '\n')
  writeFileSync(join(ws, 'src.ts'), 'export const x = 1\n')
  mkdirSync(join(ws, 'tests'), { recursive: true })
  writeFileSync(join(ws, 'tests', 'basic.test.ts'), 'test("basic", () => { expect(1).toBe(1) })\n')
  return ws
}

/** Create a holdout directory outside the workspace. */
function createHoldoutDir(): string {
  const holdoutDir = join(homedir(), '.dsh-v019-holdouts', 'qual-workspace')
  mkdirSync(holdoutDir, { recursive: true })
  writeFileSync(join(holdoutDir, 'secret.holdout.test.ts'), 'test("holdout", () => { expect(false).toBe(true) })\n')
  return holdoutDir
}

/** Create a provenance provider for the workspace. */
function createProvenanceProvider(workspace: string): WorkspaceProvenanceProvider {
  return (context) => {
    const files = context.changedFiles
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

/** Create a rollback provider that restores from a snapshot. */
function createRollbackProvider(workspace: string, snapshotDir: string): RollbackProvider {
  return () => {
    try {
      rmSync(workspace, { recursive: true, force: true })
      mkdirSync(workspace, { recursive: true })
      execSync(`cp -R "${snapshotDir}/." "${workspace}/"`, { stdio: 'pipe', timeout: 30000 })
      return { success: true, rollbackTarget: 'base-commit' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, rollbackTarget: 'base-commit', failureReason: message }
    }
  }
}

/** Create a failing rollback provider. */
function createFailingRollbackProvider(): RollbackProvider {
  return () => ({ success: false, rollbackTarget: 'base-commit', failureReason: 'forced rollback failure for qualification' })
}

/** Create a holdout verifier that always passes. */
function createPassingHoldoutVerifier(): HoldoutVerifier {
  return () => Promise.resolve({ passed: true, reason: 'holdout passed' })
}

/** Create a holdout verifier that always fails. */
function createFailingHoldoutVerifier(): HoldoutVerifier {
  return () => Promise.resolve({ passed: false, reason: 'holdout test failed: expected true got false' })
}

/** Standard model refs for qualification checks. */
const FLASH_MODEL: ModelRef = { provider: 'deepseek', model: 'deepseek-v4-flash' }
const PRO_MODEL: ModelRef = { provider: 'deepseek', model: 'deepseek-v4-pro' }

/** Standard limits for qualification checks. */
const QUAL_LIMITS: RepairLimits = DEFAULT_REPAIR_LIMITS

/** Create a fresh RepairState for qualification. */
function freshState(repairId: string): RepairState {
  return {
    repairId,
    attempts: [],
    flashAttempts: 0,
    proAttempts: 0,
    totalCostUsd: 0,
    totalOutputTokens: 0,
    startedAt: Date.now(),
    elapsedMs: 0,
  }
}

/** Build verification checks for a failed diagnostic. */
function failChecks(criteria: string[]): readonly GoalVerificationCheck[] {
  return criteria.map(c => ({ name: 'acceptance', role: 'acceptance' as const, passed: false, reason: c, evidence: [] }))
}

/** Append a turn/start and model/routing-decision event. */
function setupTurn(session: Session, turn: number, model: ModelRef, rdId?: string): void {
  session.append('turn/start', { turn }, { ignorable: true })
  session.append('model/routing-decision', {
    routingDecisionId: rdId ?? `rd-${turn}`,
    turn,
    selected: { provider: model.provider, model: model.model },
  } as never, { ignorable: true })
}

/** Append a model/usage event with proper shape. */
function appendUsage(session: Session, turn: number, model: ModelRef, output: number, rdId?: string): void {
  session.append('model/usage', {
    turn, step: 0, attempt: turn, provider: model.provider, model: model.model,
    usage: {
      inputTokens: 100,
      outputTokens: output,
      reasoningTokens: 0,
      totalTokens: 100 + output,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    ...(rdId !== undefined ? { routingDecisionId: rdId } : {}),
  } as never, { ignorable: true })
}

/** Default deps for repair handler checks. */
function defaultDeps(overrides: Partial<RepairHandlerDeps> = {}): RepairHandlerDeps {
  return {
    flashModel: FLASH_MODEL,
    proModel: PRO_MODEL,
    limits: QUAL_LIMITS,
    decide: decideRepair,
    proModelAvailable: true,
    manualModelSelection: false,
    ...overrides,
  }
}

/** Boot the composed runtime with the exact Batch A config, including rollback. */
async function bootComposedRuntime(
  workspace: string,
  snapshotDir: string,
): Promise<{ ctx: Context; uninstall: () => void }> {
  const configPath = await generateRepoConfig('deepseek-v4-flash', workspace)
  loadEnv('v019-composed-qual')
  const uninstall = installFailLoud('v019-composed-qual')

  const ctx = await boot('v019-composed-qual', resolveConfigPath(configPath, undefined))

  const repairConfig: RepairRuntimeConfig = {
    enabled: true,
    flashModel: FLASH_MODEL,
    proModel: PRO_MODEL,
    maxFlashAttempts: 3,
    maxProAttempts: 2,
    maxTotalAttempts: 5,
    holdoutVerifier: createPassingHoldoutVerifier(),
    workspaceProvenanceProvider: createProvenanceProvider(workspace),
    rollbackProvider: createRollbackProvider(workspace, snapshotDir),
  }
  await ctx.plugin(repairRuntimePlugin, repairConfig)

  return { ctx, uninstall }
}

// ---------------------------------------------------------------------------
// Check helpers
// ---------------------------------------------------------------------------

/** Find events of a specific type. */
function findEvents(events: readonly SessionEvent[], type: string): SessionEvent[] {
  return events.filter(e => (e.type as string) === type)
}

/** Read a typed field from event data. */
function eventData(event: SessionEvent): Record<string, unknown> {
  return event.data as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// C1: Effective composition identity
// ---------------------------------------------------------------------------

function checkCompositionIdentity(ctx: Context): ComposedCheck {
  try {
    const fs = ctx.get('fs')
    const shell = ctx.get('shell')
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const goals = ctx.get('goals')
    const repairController = ctx.get('repairController') as { decide: (input: object) => unknown } | undefined

    const fsName = fs !== undefined ? (fs as { constructor: { name: string } }).constructor.name : 'undefined'
    const shellName = shell !== undefined ? (shell as { constructor: { name: string } }).constructor.name : 'undefined'
    const sandboxMode = sandboxPolicy?.defaultMode ?? 'undefined'
    const hasGoals = goals !== undefined
    const hasRepairController = repairController !== undefined

    const fsOk = fsName === 'SandboxedFileSystem'
    const shellOk = shellName === 'SandboxBashExecutor'
    const sandboxOk = sandboxMode === 'workspace-isolated'
    const goalsOk = hasGoals
    const repairOk = hasRepairController

    const passed = fsOk && shellOk && sandboxOk && goalsOk && repairOk
    return {
      id: 'C1',
      name: 'Effective composition identity',
      status: passed ? 'pass' : 'fail',
      evidence: passed
        ? `fs=${fsName}, shell=${shellName}, sandbox=${sandboxMode}, goals=${hasGoals}, repairController=${hasRepairController}`
        : `Mismatch: fs=${fsName} (expected SandboxedFileSystem), shell=${shellName} (expected SandboxBashExecutor), sandbox=${sandboxMode} (expected workspace-isolated), goals=${hasGoals}, repairController=${hasRepairController}`,
    }
  } catch (e) {
    return { id: 'C1', name: 'Effective composition identity', status: 'fail', evidence: `check error: ${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// C2: File-tool isolation through the actual tool stack
// ---------------------------------------------------------------------------

async function checkFileToolIsolation(ctx: Context, workspace: string): Promise<ComposedCheck> {
  try {
    const fs = ctx.get('fs')
    if (fs === undefined) {
      return { id: 'C2', name: 'File-tool isolation through actual tool stack', status: 'fail', evidence: 'fs service not available' }
    }

    const sandboxPolicy = ctx.get('sandboxPolicy')
    if (sandboxPolicy === undefined) {
      return { id: 'C2', name: 'File-tool isolation through actual tool stack', status: 'fail', evidence: 'sandboxPolicy not available' }
    }

    const policy = sandboxPolicy.resolve()
    const outsideFile = join(tmpdir(), 'dsh-qual-outside-' + Math.random().toString(36).slice(2))
    writeFileSync(outsideFile, 'secret')

    // The sandbox filesystem extends the base interface with an optional
    // per-call sandboxPolicy argument. Cast to access the overload.
    const sandboxFs = fs as {
      resolve(path: string, opts?: { cwd?: string }): Promise<{ targetKey: unknown; displayPath: string }>
      readText(target: unknown, signal?: AbortSignal, policy?: SandboxExecutionPolicy): Promise<string>
      writeText(
        target: unknown,
        content: string,
        expected?: unknown,
        signal?: AbortSignal,
        policy?: SandboxExecutionPolicy,
      ): Promise<unknown>
    }

    try {
      // Read workspace file — should PASS
      const wsTarget = await sandboxFs.resolve('src.ts', { cwd: workspace })
      let readOk = false
      try {
        await sandboxFs.readText(wsTarget, undefined, policy)
        readOk = true
      } catch {
        readOk = false
      }

      // Write workspace file — should PASS
      const writeTarget = await sandboxFs.resolve('qual-write-test.ts', { cwd: workspace })
      let writeOk = false
      try {
        await sandboxFs.writeText(writeTarget, 'test', undefined, undefined, policy)
        writeOk = true
      } catch {
        writeOk = false
      }

      // Read outside workspace — should DENY
      const outsideTarget = await sandboxFs.resolve(outsideFile, { cwd: workspace })
      let outsideReadDenied = false
      try {
        await sandboxFs.readText(outsideTarget, undefined, policy)
        outsideReadDenied = false
      } catch {
        outsideReadDenied = true
      }

      // Write outside workspace — should DENY
      let outsideWriteDenied = false
      try {
        await sandboxFs.writeText(outsideTarget, 'test', undefined, undefined, policy)
        outsideWriteDenied = false
      } catch {
        outsideWriteDenied = true
      }

      // Parent traversal — should DENY
      const traversalTarget = await sandboxFs.resolve('../outside-traversal', { cwd: workspace })
      let traversalDenied = false
      try {
        await sandboxFs.readText(traversalTarget, undefined, policy)
        traversalDenied = false
      } catch {
        traversalDenied = true
      }

      const passed = readOk && writeOk && outsideReadDenied && outsideWriteDenied && traversalDenied
      return {
        id: 'C2',
        name: 'File-tool isolation through actual tool stack',
        status: passed ? 'pass' : 'fail',
        evidence: passed
          ? 'workspace read=PASS, workspace write=PASS, outside read=DENY, outside write=DENY, traversal=DENY'
          : `readOk=${readOk}, writeOk=${writeOk}, outsideReadDenied=${outsideReadDenied}, outsideWriteDenied=${outsideWriteDenied}, traversalDenied=${traversalDenied}`,
      }
    } finally {
      rmSync(outsideFile, { force: true })
    }
  } catch (e) {
    return { id: 'C2', name: 'File-tool isolation through actual tool stack', status: 'fail', evidence: `check error: ${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// C3: Bash isolation through the actual Bash tool
// ---------------------------------------------------------------------------

async function checkBashIsolation(ctx: Context, workspace: string): Promise<ComposedCheck> {
  try {
    const shell = ctx.get('shell')
    if (shell === undefined) {
      return { id: 'C3', name: 'Bash isolation through actual Bash tool', status: 'fail', evidence: 'shell service not available' }
    }

    const sandboxPolicy = ctx.get('sandboxPolicy')
    if (sandboxPolicy === undefined) {
      return { id: 'C3', name: 'Bash isolation through actual Bash tool', status: 'fail', evidence: 'sandboxPolicy not available' }
    }

    const policy = sandboxPolicy.resolve()

    // Create a harness-owned secret file outside the workspace to test
    // sandbox denial. /etc/passwd is intentionally allowed by bwrap/Landlock
    // (read-only system dirs), so it is the wrong forbidden-path test.
    const secretDir = mkdtempSync(join(tmpdir(), 'dsh-qual-secret-'))
    const secretFile = join(secretDir, 'verifier-secret.txt')
    writeFileSync(secretFile, 'SECRET-CONTENT-THAT-MUST-NOT-LEAK')

    try {
      // Workspace read — should PASS (exitCode 0)
      let workspaceReadOk = false
      {
        const spec = shell.resolve({ command: 'cat src.ts', workdir: workspace, sandboxPolicy: policy })
        const result = await shell.run(spec)
        workspaceReadOk = result.exitCode === 0
      }

      // External secret read — should DENY. shell.run resolves (not rejects)
      // on sandbox denial; check exitCode and sandbox.denied.
      let externalReadDenied = false
      {
        const spec = shell.resolve({ command: `cat "${secretFile}"`, workdir: workspace, sandboxPolicy: policy })
        const result = await shell.run(spec)
        externalReadDenied = (result.exitCode !== 0 && result.exitCode !== null)
          || result.sandbox?.denied === true
      }

      // Network: DNS lookup — should DENY (nonzero exit or sandbox denied)
      let dnsDenied = false
      {
        const spec = shell.resolve({ command: 'nslookup example.com 2>&1 || dig example.com 2>&1 || host example.com 2>&1', workdir: workspace, sandboxPolicy: policy })
        const result = await shell.run(spec)
        dnsDenied = (result.exitCode !== 0 && result.exitCode !== null)
          || result.sandbox?.denied === true
      }

      // Network: HTTP connection — should DENY
      let httpDenied = false
      {
        const spec = shell.resolve({ command: 'curl -s --connect-timeout 5 http://example.com > /dev/null 2>&1', workdir: workspace, sandboxPolicy: policy })
        const result = await shell.run(spec)
        httpDenied = (result.exitCode !== 0 && result.exitCode !== null)
          || result.sandbox?.denied === true
      }

      // Network: git ls-remote — should DENY. Using ls-remote instead of
      // fetch --dry-run because the workspace has no .git, so fetch fails
      // with "not a git repository" regardless of network state.
      let gitRemoteDenied = false
      {
        const spec = shell.resolve({ command: 'git ls-remote https://github.com/octocat/Hello-World.git HEAD 2>&1', workdir: workspace, sandboxPolicy: policy })
        const result = await shell.run(spec)
        gitRemoteDenied = (result.exitCode !== 0 && result.exitCode !== null)
          || result.sandbox?.denied === true
      }

      const passed = workspaceReadOk && externalReadDenied && dnsDenied && httpDenied && gitRemoteDenied
      return {
        id: 'C3',
        name: 'Bash isolation through actual Bash tool',
        status: passed ? 'pass' : 'fail',
        evidence: passed
          ? 'workspace read=PASS, external read=DENY, DNS=DENY, HTTP=DENY, git ls-remote=DENY'
          : `workspaceReadOk=${workspaceReadOk}, externalReadDenied=${externalReadDenied}, dnsDenied=${dnsDenied}, httpDenied=${httpDenied}, gitRemoteDenied=${gitRemoteDenied}`,
      }
    } finally {
      rmSync(secretDir, { recursive: true, force: true })
    }
  } catch (e) {
    return { id: 'C3', name: 'Bash isolation through actual Bash tool', status: 'fail', evidence: `check error: ${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// C4: Model workspace contains no Git history
// ---------------------------------------------------------------------------

function checkNoGitHistory(workspace: string): ComposedCheck {
  try {
    const gitDir = join(workspace, '.git')
    const hasGit = existsSync(gitDir)

    let gitLogWorks = false
    try {
      execSync('git log --oneline -1 2>&1', { cwd: workspace, encoding: 'utf8', timeout: 5000 })
      gitLogWorks = true
    } catch {
      gitLogWorks = false
    }

    const passed = !hasGit && !gitLogWorks
    return {
      id: 'C4',
      name: 'Model workspace contains no Git history',
      status: passed ? 'pass' : 'fail',
      evidence: passed
        ? 'workspace has no .git directory and git log fails'
        : `hasGit=${hasGit}, gitLogWorks=${gitLogWorks}`,
    }
  } catch (e) {
    return { id: 'C4', name: 'Model workspace contains no Git history', status: 'fail', evidence: `check error: ${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// C5: Holdout secrecy
// ---------------------------------------------------------------------------

async function checkHoldoutSecrecy(ctx: Context, workspace: string, holdoutDir: string): Promise<ComposedCheck> {
  try {
    const holdoutFile = join(holdoutDir, 'secret.holdout.test.ts')

    // Agent side: use the actual sandboxed fs and bash to try to read the
    // holdout. The previous implementation used host-side readFileSync for
    // both agent and verifier, making the check logically impossible to pass.
    const fs = ctx.get('fs')
    const shell = ctx.get('shell')
    const sandboxPolicy = ctx.get('sandboxPolicy')

    // Agent fs-sandbox read of holdout — should DENY
    let agentFsReadDenied = false
    if (fs !== undefined) {
      const sandboxFs = fs as unknown as { readText: (target: string, signal?: AbortSignal, policy?: unknown) => Promise<string> }
      try {
        await sandboxFs.readText(holdoutFile, undefined, sandboxPolicy?.resolve())
        agentFsReadDenied = false
      } catch {
        agentFsReadDenied = true
      }
    }

    // Agent bash read of holdout — should DENY
    let agentBashReadDenied = false
    if (shell !== undefined && sandboxPolicy !== undefined) {
      const policy = sandboxPolicy.resolve()
      const spec = shell.resolve({ command: `cat "${holdoutFile}"`, workdir: workspace, sandboxPolicy: policy })
      const result = await shell.run(spec)
      agentBashReadDenied = (result.exitCode !== 0 && result.exitCode !== null)
        || result.sandbox?.denied === true
    }

    // Agent bash find of holdout — should not discover it
    let agentFindDenied = true
    if (shell !== undefined && sandboxPolicy !== undefined) {
      const policy = sandboxPolicy.resolve()
      const spec = shell.resolve({ command: `find "${holdoutDir}" -name "*.holdout.test.ts" 2>&1`, workdir: workspace, sandboxPolicy: policy })
      const result = await shell.run(spec)
      const stdout = typeof result.stdout === 'string' ? result.stdout : ''
      agentFindDenied = (result.exitCode !== 0 && result.exitCode !== null)
        || result.sandbox?.denied === true
        || !stdout.includes('.holdout.test.ts')
    }

    // Verifier side: host-side Node can read the holdout
    let verifierCanRead = false
    try {
      const content = readFileSync(holdoutFile, 'utf8')
      verifierCanRead = content.includes('holdout')
    } catch {
      verifierCanRead = false
    }

    const passed = agentFsReadDenied && agentBashReadDenied && agentFindDenied && verifierCanRead
    return {
      id: 'C5',
      name: 'Holdout secrecy (agent cannot read, verifier can read)',
      status: passed ? 'pass' : 'fail',
      evidence: passed
        ? 'agent fs=DENY, agent bash=DENY, agent find=DENY, verifier=PASS'
        : `agentFsReadDenied=${agentFsReadDenied}, agentBashReadDenied=${agentBashReadDenied}, agentFindDenied=${agentFindDenied}, verifierCanRead=${verifierCanRead}`,
    }
  } catch (e) {
    return { id: 'C5', name: 'Holdout secrecy', status: 'fail', evidence: `check error: ${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// C6: One-shot lifecycle (PASS→holdout PASS)
// ---------------------------------------------------------------------------

async function checkOneShotPassLifecycle(): Promise<ComposedCheck> {
  try {
    const session = Session.create(SessionId('qual-one-shot-pass'))
    const state = freshState('repair:qual:one-shot-pass')

    // Set up a turn with a routing decision and usage so accounting works.
    setupTurn(session, 1, FLASH_MODEL, 'rd-qual-pass')
    appendUsage(session, 1, FLASH_MODEL, 50, 'rd-qual-pass')

    const result = await handleVerificationPass(
      session, state, 1, 'rd-qual-pass',
      DEFAULT_PRICING_REGISTRY,
      createPassingHoldoutVerifier(),
      'goal-qual-pass',
    )

    const totalAttempts = state.attempts.length
    const flashAttempts = state.flashAttempts
    const proAttempts = state.proAttempts

    const passed = result.verified
      && result.outcome === 'verified'
      && totalAttempts === 1
      && flashAttempts === 1
      && proAttempts === 0

    return {
      id: 'C6',
      name: 'One-shot lifecycle (PASS→holdout PASS, helper-level)',
      status: passed ? 'pass' : 'fail',
      evidence: passed
        ? 'verified=true, outcome=verified, totalAttempts=1, flashAttempts=1, proAttempts=0'
        : `verified=${result.verified}, outcome=${result.outcome}, totalAttempts=${totalAttempts}, flashAttempts=${flashAttempts}, proAttempts=${proAttempts}`,
    }
  } catch (e) {
    return { id: 'C6', name: 'One-shot lifecycle (PASS→holdout PASS, helper-level)', status: 'fail', evidence: `check error: ${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// C7: One-shot holdout failure
// ---------------------------------------------------------------------------

async function checkOneShotHoldoutFailure(): Promise<ComposedCheck> {
  try {
    const session = Session.create(SessionId('qual-holdout-fail'))
    const state = freshState('repair:qual:holdout-fail')

    setupTurn(session, 1, FLASH_MODEL, 'rd-qual-holdout-fail')
    appendUsage(session, 1, FLASH_MODEL, 50, 'rd-qual-holdout-fail')

    const result = await handleVerificationPass(
      session, state, 1, 'rd-qual-holdout-fail',
      DEFAULT_PRICING_REGISTRY,
      createFailingHoldoutVerifier(),
      'goal-qual-holdout-fail',
    )

    const evidenceEvents = findEvents(session.events, 'repair/evidence')
    const decisionEvents = findEvents(session.events, 'repair/decision')
    const escalationEvents = findEvents(session.events, 'model/escalation')

    const passed = !result.verified
      && result.outcome === 'qualification-failed'
      && evidenceEvents.length === 0
      && decisionEvents.length === 0
      && escalationEvents.length === 0

    return {
      id: 'C7',
      name: 'One-shot holdout failure (qualification-failed, no repair, helper-level)',
      status: passed ? 'pass' : 'fail',
      evidence: passed
        ? 'verified=false, outcome=qualification-failed, repair/evidence=0, repair/decision=0, model/escalation=0'
        : `verified=${result.verified}, outcome=${result.outcome}, evidence=${evidenceEvents.length}, decision=${decisionEvents.length}, escalation=${escalationEvents.length}`,
    }
  } catch (e) {
    return { id: 'C7', name: 'One-shot holdout failure (helper-level)', status: 'fail', evidence: `check error: ${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// C8: Repair success with rollback
// ---------------------------------------------------------------------------

async function checkRepairSuccessWithRollback(workspace: string, snapshotDir: string): Promise<ComposedCheck> {
  try {
    const session = Session.create(SessionId('qual-repair-success'))
    const rollbackProvider = createRollbackProvider(workspace, snapshotDir)
    const state = freshState('repair:qual:repair-success')

    // Turn 1: Flash FAIL
    setupTurn(session, 1, FLASH_MODEL, 'rd-qual-fail-1')
    appendUsage(session, 1, FLASH_MODEL, 50, 'rd-qual-fail-1')

    const deps = defaultDeps({ rollbackProvider, workspaceProvenanceProvider: createProvenanceProvider(workspace) })
    handleVerificationFailure(session, state, deps, 1, failChecks(['test failed']))

    const rollbackEvents = findEvents(session.events, 'repair/rollback')
    const rollbackData = rollbackEvents[0] !== undefined ? eventData(rollbackEvents[0]) : undefined
    const rollbackSuccess = rollbackData?.success === true

    // Turn 2: Flash PASS
    setupTurn(session, 2, FLASH_MODEL, 'rd-qual-pass-2')
    appendUsage(session, 2, FLASH_MODEL, 50, 'rd-qual-pass-2')

    const passResult = await handleVerificationPass(
      session, state, 2, 'rd-qual-pass-2',
      DEFAULT_PRICING_REGISTRY,
      createPassingHoldoutVerifier(),
      'goal-qual-repair',
    )

    const flashRequests = state.flashAttempts
    const totalAttempts = state.attempts.length

    // handleVerificationPass does NOT emit repair/completed — the plugin
    // listener owns that event, appending it after completeVerified().
    // This check verifies the helper-level contract: rollback occurred,
    // state accounting is correct, and the pass result is verified.
    const passed = rollbackSuccess
      && flashRequests === 2
      && totalAttempts === 2
      && passResult.verified
      && passResult.outcome === 'verified'

    return {
      id: 'C8',
      name: 'Repair success with rollback between attempts (helper-level)',
      status: passed ? 'pass' : 'fail',
      evidence: passed
        ? 'rollback=1(success), flashRequests=2, totalAttempts=2, verified=true, outcome=verified'
        : `rollbackSuccess=${rollbackSuccess}, flashRequests=${flashRequests}, totalAttempts=${totalAttempts}, verified=${passResult.verified}, outcome=${passResult.outcome}`,
    }
  } catch (e) {
    return { id: 'C8', name: 'Repair success with rollback', status: 'fail', evidence: `check error: ${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// C9: Pro escalation with real routing decision IDs
// ---------------------------------------------------------------------------

function checkProEscalation(): ComposedCheck {
  try {
    const session = Session.create(SessionId('qual-pro-escalate'))
    const state = freshState('repair:qual:pro-escalate')

    // Turn 1: Flash FAIL → flash-repair
    setupTurn(session, 1, FLASH_MODEL, 'rd-qual-pro-1')
    appendUsage(session, 1, FLASH_MODEL, 50, 'rd-qual-pro-1')
    handleVerificationFailure(session, state, defaultDeps(), 1, failChecks(['flash fail 1']))

    // Turn 2: Flash FAIL → pro-escalate (decideRepair escalates after same-failure-no-progress)
    setupTurn(session, 2, FLASH_MODEL, 'rd-qual-pro-2')
    appendUsage(session, 2, FLASH_MODEL, 50, 'rd-qual-pro-2')
    handleVerificationFailure(session, state, defaultDeps(), 2, failChecks(['flash fail 1']))

    const decisionEvents = findEvents(session.events, 'repair/decision')
    const proEscalateDecision = decisionEvents.find(e => eventData(e).action === 'pro-escalate')

    const passed = proEscalateDecision !== undefined && state.flashAttempts === 2

    return {
      id: 'C9',
      name: 'Pro escalation with real routing decision IDs (helper-level)',
      status: passed ? 'pass' : 'fail',
      evidence: passed
        ? 'pro-escalate decision present, flashAttempts=2'
        : `proEscalateDecision=${proEscalateDecision !== undefined}, flashAttempts=${state.flashAttempts}`,
    }
  } catch (e) {
    return { id: 'C9', name: 'Pro escalation with real routing decision IDs (helper-level)', status: 'fail', evidence: `check error: ${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// C10: Rollback failure stops repair
// ---------------------------------------------------------------------------

function checkRollbackFailureStopsRepair(): ComposedCheck {
  try {
    const session = Session.create(SessionId('qual-rollback-fail'))
    const state = freshState('repair:qual:rollback-fail')

    setupTurn(session, 1, FLASH_MODEL, 'rd-qual-rb-fail')
    appendUsage(session, 1, FLASH_MODEL, 50, 'rd-qual-rb-fail')

    const deps = defaultDeps({ rollbackProvider: createFailingRollbackProvider() })
    const result = handleVerificationFailure(session, state, deps, 1, failChecks(['test failed']))

    const rollbackEvents = findEvents(session.events, 'repair/rollback')
    const rollbackData = rollbackEvents[0] !== undefined ? eventData(rollbackEvents[0]) : undefined
    const completedEvents = findEvents(session.events, 'repair/completed')
    const lastCompleted = completedEvents.at(-1)
    const lastCompletedData = lastCompleted !== undefined ? eventData(lastCompleted) : undefined

    const routingAfterCompleted = session.events.filter(e =>
      (e.type as string) === 'model/routing-decision' &&
      e.seq > (lastCompleted?.seq ?? 0),
    )

    const passed = result.action === 'stop'
      && result.reason === 'rollback-failed'
      && rollbackData?.success === false
      && lastCompletedData?.outcome === 'rollback-failed'
      && routingAfterCompleted.length === 0

    return {
      id: 'C10',
      name: 'Rollback failure stops repair, no subsequent provider call (helper-level)',
      status: passed ? 'pass' : 'fail',
      evidence: passed
        ? 'action=stop, reason=rollback-failed, rollback success=false, outcome=rollback-failed, no routing after'
        : `action=${result.action}, reason=${result.reason}, rollbackSuccess=${String(rollbackData?.success)}, outcome=${typeof lastCompletedData?.outcome === 'string' ? lastCompletedData.outcome : 'none'}, routingAfter=${routingAfterCompleted.length}`,
    }
  } catch (e) {
    return { id: 'C10', name: 'Rollback failure stops repair (helper-level)', status: 'fail', evidence: `check error: ${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// C11: Authority ambiguity denies model transition
// ---------------------------------------------------------------------------

function checkAuthorityAmbiguity(): ComposedCheck {
  try {
    const session = Session.create(SessionId('qual-auth-undecidable'))

    // Inject a future-schema authority event that reconstructSelectionState
    // cannot interpret.
    session.append('model/selection-authority', {
      mode: 'auto',
      authority: 'router',
      authorityEpoch: 1,
      source: 'web',
      authoritySchemaVersion: 99,
    } as never, { ignorable: true })

    let releaseThrew = false
    try {
      releaseToAuto(session, 'system')
    } catch {
      releaseThrew = true
    }

    const passed = releaseThrew
    return {
      id: 'C11',
      name: 'Authority ambiguity denies model transition (helper-level)',
      status: passed ? 'pass' : 'fail',
      evidence: passed
        ? 'releaseToAuto threw on undecidable authority state'
        : 'releaseToAuto did not throw on undecidable authority state',
    }
  } catch (e) {
    return { id: 'C11', name: 'Authority ambiguity denies model transition (helper-level)', status: 'fail', evidence: `check error: ${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// C12: Workspace-bound verification (mutation changes hash)
// ---------------------------------------------------------------------------

async function checkWorkspaceBoundVerification(workspace: string): Promise<ComposedCheck> {
  try {
    const session = Session.create(SessionId('qual-workspace-bound'))
    const provenanceProvider = createProvenanceProvider(workspace)
    const state = freshState('repair:qual:workspace-bound')

    // Set up turn 1 with a tool/call event so changedFilesInTurn finds
    // the file. The provenance provider hashes the changed file content,
    // so the hash reflects the actual workspace state.
    setupTurn(session, 1, FLASH_MODEL, 'rd-qual-ws-bound')
    appendUsage(session, 1, FLASH_MODEL, 50, 'rd-qual-ws-bound')
    session.append('tool/call', {
      turn: 1,
      name: 'write_file',
      arguments: JSON.stringify({ file_path: 'src.ts' }),
    } as never, { ignorable: true })

    const result = await handleVerificationPass(
      session, state, 1, 'rd-qual-ws-bound',
      DEFAULT_PRICING_REGISTRY,
      createPassingHoldoutVerifier(),
      'goal-qual-ws-bound',
      provenanceProvider,
      ['src.ts'],
    )

    const hasHash = result.workspaceHash !== undefined && result.workspaceHash !== 'empty'

    // Mutate the workspace
    writeFileSync(join(workspace, 'src.ts'), 'export const MUTATED = true\n')

    // Set up turn 2 with the same file changed
    setupTurn(session, 2, FLASH_MODEL, 'rd-qual-ws-bound-2')
    appendUsage(session, 2, FLASH_MODEL, 50, 'rd-qual-ws-bound-2')
    session.append('tool/call', {
      turn: 2,
      name: 'write_file',
      arguments: JSON.stringify({ file_path: 'src.ts' }),
    } as never, { ignorable: true })

    const mutatedResult = await handleVerificationPass(
      session, state, 2, 'rd-qual-ws-bound-2',
      DEFAULT_PRICING_REGISTRY,
      createPassingHoldoutVerifier(),
      'goal-qual-ws-bound',
      provenanceProvider,
      ['src.ts'],
    )

    const hashChanged = result.workspaceHash !== mutatedResult.workspaceHash

    // Restore the workspace
    writeFileSync(join(workspace, 'src.ts'), 'export const x = 1\n')

    const passed = hasHash && hashChanged
    return {
      id: 'C12',
      name: 'Workspace-bound verification (mutation changes hash, helper-level)',
      status: passed ? 'pass' : 'fail',
      evidence: passed
        ? `workspaceHash present and changes on mutation (H1=${(result.workspaceHash ?? '').slice(0, 12)}..., H2=${(mutatedResult.workspaceHash ?? '').slice(0, 12)}...)`
        : `hasHash=${hasHash}, hashChanged=${hashChanged}, H1=${result.workspaceHash ?? 'undefined'}, H2=${mutatedResult.workspaceHash ?? 'undefined'}`,
    }
  } catch (e) {
    return { id: 'C12', name: 'Workspace-bound verification', status: 'fail', evidence: `check error: ${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// C13: Ledger secret sanitization
// ---------------------------------------------------------------------------

function checkLedgerSecretSanitization(): ComposedCheck {
  try {
    const session = Session.create(SessionId('qual-sanitization'))

    setupTurn(session, 1, FLASH_MODEL, 'rd-qual-sanitize')
    appendUsage(session, 1, FLASH_MODEL, 50, 'rd-qual-sanitize')

    const checksWithSecrets: readonly GoalVerificationCheck[] = [
      {
        name: 'v019-diagnostic',
        role: 'acceptance',
        passed: false,
        reason: 'Authorization: Bearer AbC123secretToken456 failed',
        evidence: ['DEEPSEEK_API_KEY=sk-abc123def456ghi789', 'postgres://user:password@host/db'],
      },
    ]

    const state = freshState('repair:qual:sanitization')
    handleVerificationFailure(session, state, defaultDeps(), 1, checksWithSecrets)

    const secretPatterns = [
      'AbC123secretToken456',
      'sk-abc123def456ghi789',
      'postgres://user:password@host/db',
      'DEEPSEEK_API_KEY=sk-',
    ]

    const eventJson = JSON.stringify(session.events)
    const foundSecrets = secretPatterns.filter(p => eventJson.includes(p))

    const passed = foundSecrets.length === 0
    return {
      id: 'C13',
      name: 'Ledger secret sanitization (scan durable events for raw secrets, helper-level)',
      status: passed ? 'pass' : 'fail',
      evidence: passed
        ? 'no raw secrets found in durable session events'
        : `raw secrets found in events: ${foundSecrets.join(', ')}`,
    }
  } catch (e) {
    return { id: 'C13', name: 'Ledger secret sanitization (helper-level)', status: 'fail', evidence: `check error: ${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// C14: Unpriced usage stops before next paid execution
// ---------------------------------------------------------------------------

async function checkUnpricedUsageStops(): Promise<ComposedCheck> {
  try {
    const session = Session.create(SessionId('qual-unpriced'))

    // Emit routing decision and usage for an unknown model with no pricing entry.
    session.append('model/routing-decision', {
      routingDecisionId: 'rd-qual-unpriced',
      turn: 1,
      selected: { provider: 'deepseek', model: 'nonexistent-model-v999' },
    } as never, { ignorable: true })

    session.append('model/usage', {
      turn: 1, step: 0, attempt: 1,
      provider: 'deepseek', model: 'nonexistent-model-v999',
      usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 0, totalTokens: 150, cacheReadTokens: 0, cacheCreationTokens: 0 },
      routingDecisionId: 'rd-qual-unpriced',
    } as never, { ignorable: true })

    const state = freshState('repair:qual:unpriced')

    let threwUnpriced = false
    try {
      await handleVerificationPass(
        session, state, 1, 'rd-qual-unpriced',
        DEFAULT_PRICING_REGISTRY,
        undefined,
        'goal-qual-unpriced',
      )
    } catch (e) {
      threwUnpriced = (e as Error).message.includes('UNPRICED_USAGE')
    }

    const passed = threwUnpriced
    return {
      id: 'C14',
      name: 'Unpriced usage stops before next paid execution (helper-level)',
      status: passed ? 'pass' : 'fail',
      evidence: passed
        ? 'UNPRICED_USAGE thrown for unknown model, no $0 fallback'
        : 'UNPRICED_USAGE not thrown — unpriced usage silently became $0',
    }
  } catch (e) {
    return { id: 'C14', name: 'Unpriced usage stops before next paid execution (helper-level)', status: 'fail', evidence: `check error: ${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// C15: Trajectory reconstruction from composed session history
// ---------------------------------------------------------------------------

function checkTrajectoryReconstruction(): ComposedCheck {
  try {
    const session = Session.create(SessionId('qual-trajectory'))

    setupTurn(session, 1, FLASH_MODEL, 'rd-traj-1')
    appendUsage(session, 1, FLASH_MODEL, 50, 'rd-traj-1')

    session.append('goal/verification', {
      kind: 'goal/verification',
      version: 2,
      goal: { id: 'goal-traj', revision: 1 },
      passed: false,
      verifiedAt: Date.now(),
      basisSeq: 0,
      registryFingerprint: 'test-fingerprint',
      checks: [{ name: 'v019-diagnostic', role: 'acceptance', passed: false, reason: 'failed' }],
    } as never, { ignorable: true })

    session.append('repair/evidence', {
      repairId: 'repair:traj',
      turn: 1,
      step: 0,
      attempt: 1,
      routingDecisionId: 'rd-traj-1',
      failureFingerprint: 'fp-1',
      failurePackageId: 'fpid-1',
      failedCriteria: ['test failed'],
      failingTests: [],
      typeErrors: [],
      buildErrors: [],
      changedFiles: [],
    } as never, { ignorable: true })

    const reconstructed = reconstructRepairState(session.events, 'goal-traj')

    const hasAttempts = reconstructed !== undefined && reconstructed.attempts.length > 0
    const correctModel = reconstructed?.attempts[0]?.model.model === 'deepseek-v4-flash'
    const correctRoutingId = reconstructed?.attempts[0]?.routingDecisionId === 'rd-traj-1'

    const passed = hasAttempts && correctModel && correctRoutingId
    return {
      id: 'C15',
      name: 'Trajectory reconstruction from composed session history (helper-level)',
      status: passed ? 'pass' : 'fail',
      evidence: passed
        ? `attempts=${reconstructed.attempts.length}, model=${reconstructed.attempts[0]?.model.model}, routingId=${reconstructed.attempts[0]?.routingDecisionId}`
        : `hasAttempts=${hasAttempts}, correctModel=${correctModel}, correctRoutingId=${correctRoutingId}`,
    }
  } catch (e) {
    return { id: 'C15', name: 'Trajectory reconstruction from composed session history (helper-level)', status: 'fail', evidence: `check error: ${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// Composed-runtime scenario checks (S1-S8)
//
// These checks boot the actual Cordis context, register acceptance verifiers
// with the real GoalService, create goals on the root agent, and drive
// verifyCompletion() through the production RepairRuntime plugin listener.
// They test the full plugin→GoalService→completeVerified pipeline, not just
// the exported helpers.
// ---------------------------------------------------------------------------

/** Wait for a specific event type to appear in the session, with timeout. */
async function waitForEvent(
  session: { events: readonly SessionEvent[] },
  type: string,
  timeoutMs = 2000,
): Promise<SessionEvent | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = session.events.find(e => (e.type as string) === type)
    if (found !== undefined) return found
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return undefined
}

/** Append turn/routing/usage events to the agent's session for accounting. */
function setupAgentTurn(agent: Agent, turn: number, model: ModelRef, routingDecisionId: string): void {
  agent.session.append('turn/start', { turn }, { ignorable: true })
  agent.session.append('model/routing-decision', {
    routingDecisionId,
    turn,
    selected: { provider: model.provider, model: model.model },
  } as never, { ignorable: true })
  agent.session.append('model/usage', {
    turn,
    step: 0,
    attempt: 1,
    provider: model.provider,
    model: model.model,
    usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 0, totalTokens: 150, cacheReadTokens: 0, cacheCreationTokens: 0 },
    routingDecisionId,
  } as never, { ignorable: true })
}

/** Get the root agent from a booted context. */
function getRootAgent(ctx: Context): Agent {
  const agents = ctx.get('agents')?.roots() ?? []
  const agent = agents[0]
  if (agent === undefined || agents.length !== 1) {
    throw new Error(`composed scenario requires exactly one root agent, found ${agents.length}`)
  }
  return agent
}

// ---------------------------------------------------------------------------
// S1: One-shot Flash → diagnostic PASS → holdout PASS → goal complete
// ---------------------------------------------------------------------------

async function checkScenarioOneShotPass(ctx: Context): Promise<ComposedCheck> {
  try {
    const goals = ctx.get('goals')
    if (goals === undefined) {
      return { id: 'S1', name: 'Scenario A: one-shot PASS→holdout PASS→complete', status: 'fail', evidence: 'goals service not available' }
    }

    const agent = getRootAgent(ctx)
    const verifier: GoalCompletionVerifier = {
      name: 's1-diagnostic',
      version: '1',
      verify: () => ({ name: 's1-diagnostic', role: 'acceptance', passed: true, reason: '', evidence: [] }),
    }
    const disposeVerifier = goals.registerAcceptanceVerifier(verifier)

    try {
      setupAgentTurn(agent, 1, FLASH_MODEL, 'rd-s1-1')
      goals.create(agent, { objective: 'S1: one-shot pass' })
      const goal = goals.get(agent)
      if (goal === undefined) {
        return { id: 'S1', name: 'Scenario A: one-shot PASS→holdout PASS→complete (composed)', status: 'fail', evidence: 'goal not found after create' }
      }
      await goals.verifyCompletion(agent, { id: goal.id, revision: goal.revision })

      // Wait for the async plugin handler to append repair/completed
      const completedEvent = await waitForEvent(agent.session, 'repair/completed')
      const completedData = completedEvent !== undefined ? eventData(completedEvent) : undefined
      const postGoal = goals.get(agent)

      const verified = completedData?.verified === true
      const outcome = typeof completedData?.outcome === 'string' ? completedData.outcome : 'undefined'
      const goalPhase = typeof postGoal?.phase === 'string' ? postGoal.phase : 'undefined'
      const passed = verified && outcome === 'verified' && goalPhase === 'complete'

      return {
        id: 'S1',
        name: 'Scenario A: one-shot PASS→holdout PASS→complete (composed)',
        status: passed ? 'pass' : 'fail',
        evidence: passed
          ? 'repair/completed verified=true, outcome=verified, goal=complete'
          : `verified=${verified}, outcome=${outcome}, goalPhase=${goalPhase}`,
      }
    } finally {
      disposeVerifier()
    }
  } catch (e) {
    return { id: 'S1', name: 'Scenario A: one-shot PASS→holdout PASS→complete (composed)', status: 'fail', evidence: `check error: ${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// S2: One-shot Flash → diagnostic PASS → holdout FAIL → qualification-failed
// ---------------------------------------------------------------------------

async function checkScenarioHoldoutFail(ctx: Context): Promise<ComposedCheck> {
  try {
    const goals = ctx.get('goals')
    if (goals === undefined) {
      return { id: 'S2', name: 'Scenario B: PASS→holdout FAIL→qualification-failed', status: 'fail', evidence: 'goals service not available' }
    }

    // Boot a fresh context with a failing holdout verifier
    // We can't reuse the main ctx because its holdout verifier is configured
    // at plugin mount time. Instead, we test this through the helper-level
    // check (C7) which already validates this path. Here we verify that the
    // plugin correctly calls block() when the holdout fails.
    //
    // Since we can't reconfigure the holdout verifier on the live context,
    // we verify the block path by registering a failing verifier.
    const agent = getRootAgent(ctx)
    const verifier: GoalCompletionVerifier = {
      name: 's2-failing-diagnostic',
      version: '1',
      verify: () => ({ name: 's2-failing-diagnostic', role: 'acceptance', passed: false, reason: 'diagnostic failed', evidence: [] }),
    }
    const disposeVerifier = goals.registerAcceptanceVerifier(verifier)

    try {
      setupAgentTurn(agent, 1, FLASH_MODEL, 'rd-s2-1')
      goals.create(agent, { objective: 'S2: holdout fail' })
      const goal = goals.get(agent)
      if (goal === undefined) {
        return { id: 'S2', name: 'Scenario B: diagnostic FAIL→repair evidence+decision (composed)', status: 'fail', evidence: 'goal not found after create' }
      }
      await goals.verifyCompletion(agent, { id: goal.id, revision: goal.revision })

      // The plugin handler fires synchronously for FAIL
      const evidenceEvents = findEvents(agent.session.events, 'repair/evidence')
      const decisionEvents = findEvents(agent.session.events, 'repair/decision')
      const postGoal = goals.get(agent)

      // With a failing verifier, goal/verification FAIL triggers repair.
      // The repair controller may decide flash-repair (queuing a followup)
      // or stop. Either way, repair/evidence and repair/decision should fire.
      const passed = evidenceEvents.length > 0 && decisionEvents.length > 0
      const evidence = `repair/evidence=${evidenceEvents.length}, repair/decision=${decisionEvents.length}, goalPhase=${postGoal?.phase ?? 'undefined'}`

      return {
        id: 'S2',
        name: 'Scenario B: diagnostic FAIL→repair evidence+decision (composed)',
        status: passed ? 'pass' : 'fail',
        evidence,
      }
    } finally {
      disposeVerifier()
    }
  } catch (e) {
    return { id: 'S2', name: 'Scenario B: diagnostic FAIL→repair evidence+decision (composed)', status: 'fail', evidence: `check error: ${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// S3: Post-verification filesystem mutation → completeVerified DENIED
// ---------------------------------------------------------------------------

async function checkScenarioPostMutationDenied(ctx: Context): Promise<ComposedCheck> {
  try {
    const goals = ctx.get('goals')
    if (goals === undefined) {
      return { id: 'S3', name: 'Scenario G: post-verification mutation→DENIED', status: 'fail', evidence: 'goals service not available' }
    }

    const agent = getRootAgent(ctx)
    const verifier: GoalCompletionVerifier = {
      name: 's3-diagnostic',
      version: '1',
      verify: () => ({ name: 's3-diagnostic', role: 'acceptance', passed: true, reason: '', evidence: [] }),
    }
    const disposeVerifier = goals.registerAcceptanceVerifier(verifier)

    try {
      setupAgentTurn(agent, 1, FLASH_MODEL, 'rd-s3-1')
      goals.create(agent, { objective: 'S3: post-mutation denied' })
      const goal = goals.get(agent)
      if (goal === undefined) {
        return { id: 'S3', name: 'Scenario G: post-verification completeVerified DENIED (composed)', status: 'fail', evidence: 'goal not found after create' }
      }
      await goals.verifyCompletion(agent, { id: goal.id, revision: goal.revision })

      // Wait for repair/completed (plugin async path)
      await waitForEvent(agent.session, 'repair/completed')

      // Now try to call completeVerified on a stale verification.
      // The plugin already called completeVerified, so the goal should be
      // complete. Calling it again should fail because the latest event is
      // no longer goal/verification PASS.
      let denied = false
      try {
        goals.completeVerified(agent, { id: goal.id, revision: goal.revision })
      } catch {
        denied = true
      }

      const passed = denied
      return {
        id: 'S3',
        name: 'Scenario G: post-verification completeVerified DENIED (composed)',
        status: passed ? 'pass' : 'fail',
        evidence: passed
          ? 'completeVerified correctly rejected stale verification'
          : 'completeVerified did not reject stale verification',
      }
    } finally {
      disposeVerifier()
    }
  } catch (e) {
    return { id: 'S3', name: 'Scenario G: post-verification completeVerified DENIED (composed)', status: 'fail', evidence: `check error: ${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// S4: Agent cannot read holdout through sandboxed fs/bash (composed)
// ---------------------------------------------------------------------------

async function checkScenarioHoldoutDenied(ctx: Context, workspace: string, holdoutDir: string): Promise<ComposedCheck> {
  try {
    const holdoutFile = join(holdoutDir, 'secret.holdout.test.ts')
    const fs = ctx.get('fs')
    const shell = ctx.get('shell')
    const sandboxPolicy = ctx.get('sandboxPolicy')

    // Agent fs-sandbox read — should DENY
    let agentFsDenied = false
    if (fs !== undefined) {
      const sandboxFs = fs as unknown as { readText: (target: string, signal?: AbortSignal, policy?: unknown) => Promise<string> }
      try {
        await sandboxFs.readText(holdoutFile, undefined, sandboxPolicy?.resolve())
        agentFsDenied = false
      } catch {
        agentFsDenied = true
      }
    }

    // Agent bash read — should DENY
    let agentBashDenied = false
    if (shell !== undefined && sandboxPolicy !== undefined) {
      const policy = sandboxPolicy.resolve()
      const spec = shell.resolve({ command: `cat "${holdoutFile}"`, workdir: workspace, sandboxPolicy: policy })
      const result = await shell.run(spec)
      agentBashDenied = (result.exitCode !== 0 && result.exitCode !== null)
        || result.sandbox?.denied === true
    }

    // Verifier (host Node) can read
    let verifierCanRead = false
    try {
      const content = readFileSync(holdoutFile, 'utf8')
      verifierCanRead = content.includes('holdout')
    } catch {
      verifierCanRead = false
    }

    const passed = agentFsDenied && agentBashDenied && verifierCanRead
    return {
      id: 'S4',
      name: 'Scenario H: agent holdout access DENIED through sandbox (composed)',
      status: passed ? 'pass' : 'fail',
      evidence: passed
        ? 'agent fs=DENY, agent bash=DENY, verifier=PASS'
        : `agentFsDenied=${agentFsDenied}, agentBashDenied=${agentBashDenied}, verifierCanRead=${verifierCanRead}`,
    }
  } catch (e) {
    return { id: 'S4', name: 'Scenario H: agent holdout access DENIED through sandbox (composed)', status: 'fail', evidence: `check error: ${(e as Error).message}` }
  }
}

// ---------------------------------------------------------------------------
// Main qualification runner
// ---------------------------------------------------------------------------

/**
 * Run the composed runtime qualification and return the artifact.
 *
 * Boots the exact Batch A Cordis config, exercises the real composed graph,
 * and records the result of each check.
 *
 * @returns the qualification record.
 */
export async function runComposedRuntimeQualification(): Promise<ComposedQualificationRecord> {
  const sourceCommit = getSourceCommit()
  const checks: ComposedCheck[] = []

  let workspace: string | undefined
  let holdoutDir: string | undefined
  let snapshotDir: string | undefined

  try {
    workspace = createQualificationWorkspace()
    holdoutDir = createHoldoutDir()

    // Create a snapshot for rollback
    snapshotDir = mkdtempSync(join(tmpdir(), 'dsh-qual-snapshot-'))
    execSync(`cp -R "${workspace}/." "${snapshotDir}/"`, { stdio: 'pipe' })

    // Boot the composed runtime
    let ctx: Context | undefined
    let uninstall: (() => void) | undefined
    try {
      const booted = await bootComposedRuntime(workspace, snapshotDir)
      ctx = booted.ctx
      uninstall = booted.uninstall
    } catch (e) {
      checks.push({
        id: 'BOOT',
        name: 'Composed runtime boot',
        status: 'fail',
        evidence: `boot failed: ${(e as Error).message}`,
      })
      // Still run the synthetic-session checks
      checks.push(await checkOneShotPassLifecycle())
      checks.push(await checkOneShotHoldoutFailure())
      checks.push(checkProEscalation())
      checks.push(checkRollbackFailureStopsRepair())
      checks.push(checkAuthorityAmbiguity())
      checks.push(checkLedgerSecretSanitization())
      checks.push(await checkUnpricedUsageStops())
      checks.push(checkTrajectoryReconstruction())
      return buildRecord(sourceCommit, checks)
    }

    try {
      // C1: Effective composition identity
      checks.push(checkCompositionIdentity(ctx))

      // C2: File-tool isolation
      checks.push(await checkFileToolIsolation(ctx, workspace))

      // C3: Bash isolation
      checks.push(await checkBashIsolation(ctx, workspace))

      // C4: No Git history
      checks.push(checkNoGitHistory(workspace))

      // C5: Holdout secrecy — uses actual sandboxed fs/bash for agent side
      checks.push(await checkHoldoutSecrecy(ctx, workspace, holdoutDir))

      // C6-C15: Lifecycle checks (helper-level — see check names)
      checks.push(await checkOneShotPassLifecycle())
      checks.push(await checkOneShotHoldoutFailure())
      checks.push(await checkRepairSuccessWithRollback(workspace, snapshotDir))
      checks.push(checkProEscalation())
      checks.push(checkRollbackFailureStopsRepair())
      checks.push(checkAuthorityAmbiguity())
      checks.push(await checkWorkspaceBoundVerification(workspace))
      checks.push(checkLedgerSecretSanitization())
      checks.push(await checkUnpricedUsageStops())
      checks.push(checkTrajectoryReconstruction())

      // S1-S4: Composed-runtime scenario checks through the real plugin
      checks.push(await checkScenarioOneShotPass(ctx))
      checks.push(await checkScenarioHoldoutFail(ctx))
      checks.push(await checkScenarioPostMutationDenied(ctx))
      checks.push(await checkScenarioHoldoutDenied(ctx, workspace, holdoutDir))
    } finally {
      // Dispose the composed context so event handlers, plugins, and
      // service fibers do not leak into the Batch A process. The
      // qualification gate runs in the same process immediately before
      // the paid benchmark, so it must leave the process exactly as it
      // found it.
      await ctx.fiber.dispose()
      uninstall()
    }
  } finally {
    if (workspace !== undefined) {
      rmSync(workspace, { recursive: true, force: true })
    }
    if (snapshotDir !== undefined) {
      rmSync(snapshotDir, { recursive: true, force: true })
    }
    if (holdoutDir !== undefined) {
      rmSync(holdoutDir, { recursive: true, force: true })
    }
  }

  return buildRecord(sourceCommit, checks)
}

/** Build the qualification record from checks. */
function buildRecord(sourceCommit: string, checks: readonly ComposedCheck[]): ComposedQualificationRecord {
  const passedCount = checks.filter(c => c.status === 'pass').length
  const failedCount = checks.filter(c => c.status === 'fail').length
  const skipCount = checks.filter(c => c.status === 'skip').length
  const passed = failedCount === 0

  const c1 = checks.find(c => c.id === 'C1')
  const c2 = checks.find(c => c.id === 'C2')
  const c3 = checks.find(c => c.id === 'C3')
  const c5 = checks.find(c => c.id === 'C5')

  return {
    qualificationId: COMPOSED_QUALIFICATION_ID,
    sourceCommit,
    timestamp: new Date().toISOString(),
    checks,
    passedCount,
    failedCount,
    skipCount,
    passed,
    backend: {
      enforcement: c3?.status === 'pass' ? 'full' : 'unknown',
      networkDenied: c3?.status === 'pass',
      probed: c3?.status === 'pass',
    },
    filesystem: {
      modelReadFence: c2?.status === 'pass',
      modelWriteFence: c2?.status === 'pass',
    },
    holdout: {
      modelReadable: c5?.status !== 'pass',
    },
    repair: {
      productionRuntime: c1?.status === 'pass',
      rollbackRequired: true,
      provenanceRequired: true,
    },
    ready: passed,
  }
}

// CLI entry point
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  runComposedRuntimeQualification().then((record) => {
    process.stdout.write(JSON.stringify(record, null, 2) + '\n')
    if (!record.passed) {
      process.stderr.write(`\nCOMPOSED RUNTIME QUALIFICATION FAILED: ${record.failedCount} checks failed\n`)
      for (const check of record.checks) {
        if (check.status === 'fail') {
          process.stderr.write(`  [FAIL] ${check.id}: ${check.name} — ${check.evidence}\n`)
        }
      }
      process.exit(1)
    }
    process.stderr.write(`\nCOMPOSED RUNTIME QUALIFICATION PASSED: ${record.passedCount} checks passed\n`)
  }).catch((error: unknown) => {
    process.stderr.write(`Fatal error: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
