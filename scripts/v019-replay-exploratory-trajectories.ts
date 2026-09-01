/**
 * v0.19 Replay exploratory trajectories with corrected accounting.
 *
 * Reads old v3 exploratory trajectories, re-derives the new accounting
 * fields (flashCostUsd, proCostUsd, costByModel, finalModel, modelsUsed,
 * providerCalls, attemptId) from the existing attempt data, fixes the
 * experiment identity, and regenerates metrics.
 *
 * Usage: npx tsx scripts/v019-replay-exploratory-trajectories.ts
 *
 * @module v019-replay-exploratory-trajectories
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { TaskTrajectory, AttemptTrajectory, ProviderCallTrajectory } from './v019-trajectory-collector.ts'
import { EXPLORATORY_EXPERIMENT_ID } from './v019-experiment-identity.ts'
import { computeMetrics } from './v019-metrics.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const V3_DIR = join(REPO_ROOT, 'artifacts', 'evals', 'v019-synthetic-multirepo-validation-v3')
const OUTPUT_DIR = join(REPO_ROOT, 'artifacts', 'evals', 'v019-exploratory-replay-v1')

/** Re-derive provider call trajectory from an old attempt. */
function deriveProviderCalls(attempt: OldAttempt): ProviderCallTrajectory[] {
  const model = attempt.model
  const usage = attempt.usage
  const costUsd = attempt.costUsd
  const call: ProviderCallTrajectory = {
    requestId: `replay-${attempt.attempt}-1`,
    turn: attempt.attempt,
    step: 1,
    providerAttempt: 1,
    model,
    provider: 'deepseek-official',
    routingDecisionId: attempt.routingDecisionId,
    outcome: 'success',
    usage,
    costUsd,
    latencyMs: attempt.latencyMs,
  }
  return [call]
}

/** Re-derive the new attempt fields from an old attempt. */
function upgradeAttempt(attempt: OldAttempt, index: number): AttemptTrajectory {
  const providerCalls = deriveProviderCalls(attempt)
  const costByModel = new Map<string, number>()
  costByModel.set(attempt.model, attempt.costUsd)
  return {
    attempt: attempt.attempt,
    attemptId: `replay-attempt-${index + 1}`,
    model: attempt.model,
    finalModel: attempt.model,
    modelsUsed: [attempt.model],
    routingDecisionId: attempt.routingDecisionId,
    verified: attempt.verified,
    diagnosticPass: attempt.diagnosticPass,
    holdoutPass: attempt.holdoutPass,
    failureFingerprint: attempt.failureFingerprint,
    progress: attempt.progress,
    failedCriteria: attempt.failedCriteria ?? [],
    failingTests: attempt.failingTests ?? [],
    typeErrors: attempt.typeErrors ?? [],
    buildErrors: attempt.buildErrors ?? [],
    usage: attempt.usage,
    costUsd: attempt.costUsd,
    latencyMs: attempt.latencyMs,
    repairAction: attempt.repairAction,
    repairReason: attempt.repairReason,
    changedFiles: attempt.changedFiles ?? [],
    toolCallCount: attempt.toolCallCount ?? 0,
    filesInspected: attempt.filesInspected ?? [],
    terminalOutcome: attempt.terminalOutcome,
    costByModel,
    providerCalls,
  }
}

interface OldAttempt {
  readonly attempt: number
  readonly model: string
  readonly routingDecisionId: string
  readonly verified: boolean
  readonly diagnosticPass: boolean
  readonly holdoutPass: boolean | undefined
  readonly failureFingerprint: string | undefined
  readonly progress: string | undefined
  readonly failedCriteria?: readonly unknown[]
  readonly failingTests?: readonly unknown[]
  readonly typeErrors?: readonly unknown[]
  readonly buildErrors?: readonly unknown[]
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
  readonly repairAction: string
  readonly repairReason: string | undefined
  readonly changedFiles?: readonly string[]
  readonly toolCallCount?: number
  readonly filesInspected?: readonly string[]
  readonly terminalOutcome: string
}

interface OldTrajectory {
  readonly taskId: string
  readonly taskManifestHash: string
  readonly experimentId: string
  readonly experimentManifestHash: string
  readonly benchmarkEligible: boolean
  readonly repository: {
    readonly name: string
    readonly url: string
    readonly baseCommit: string
    readonly referenceFixCommit: string | undefined
  }
  readonly category: string
  readonly taskDescription: string
  readonly baseCommit: string
  readonly referenceFixCommit: string | undefined
  readonly taskState: string
  readonly controlPlaneStatus: string
  readonly modelCapabilityStatus: string
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
  readonly attempts: readonly OldAttempt[]
  readonly changedFiles: readonly string[]
  readonly referenceFixFiles: readonly string[]
  readonly referenceFixFilesInspected: readonly string[]
  readonly referenceFixFilesModified: readonly string[]
  readonly rollbackUsed: boolean
  readonly aborted: boolean
  readonly terminalOutcome: string
  readonly providerRequestOutcomes: readonly { outcome: string; provider: string; model: string }[]
  readonly timestamp: string
}

/** Upgrade an old trajectory to the new schema with corrected accounting. */
function upgradeTrajectory(old: OldTrajectory): TaskTrajectory {
  const upgradedAttempts = old.attempts.map((a, i) => upgradeAttempt(a, i))
  const flashCostUsd = upgradedAttempts
    .filter(a => a.model === 'deepseek-v4-flash')
    .reduce((s, a) => s + a.costUsd, 0)
  const proCostUsd = upgradedAttempts
    .filter(a => a.model === 'deepseek-v4-pro')
    .reduce((s, a) => s + a.costUsd, 0)
  const costByModel = new Map<string, number>()
  for (const a of upgradedAttempts) {
    for (const [model, cost] of a.costByModel) {
      costByModel.set(model, (costByModel.get(model) ?? 0) + cost)
    }
  }
  return {
    taskId: old.taskId,
    taskManifestHash: old.taskManifestHash,
    experimentId: EXPLORATORY_EXPERIMENT_ID,
    experimentManifestHash: old.experimentManifestHash,
    benchmarkEligible: false,
    runClass: 'exploratory',
    securityGateBypassed: true,
    repository: old.repository,
    category: old.category,
    taskDescription: old.taskDescription,
    baseCommit: old.baseCommit,
    referenceFixCommit: old.referenceFixCommit,
    taskState: old.taskState as TaskTrajectory['taskState'],
    controlPlaneStatus: old.controlPlaneStatus as TaskTrajectory['controlPlaneStatus'],
    modelCapabilityStatus: old.modelCapabilityStatus as TaskTrajectory['modelCapabilityStatus'],
    finalVerified: old.finalVerified,
    holdoutPass: old.holdoutPass,
    verificationStrength: old.verificationStrength as TaskTrajectory['verificationStrength'],
    flashAttempts: old.flashAttempts,
    proAttempts: old.proAttempts,
    escalatedToPro: old.escalatedToPro,
    flashCostUsd,
    proCostUsd,
    costByModel,
    totalCostUsd: old.totalCostUsd,
    totalLatencyMs: old.totalLatencyMs,
    totalOutputTokens: old.totalOutputTokens,
    totalCacheReadTokens: old.totalCacheReadTokens,
    totalCacheMissTokens: old.totalCacheMissTokens,
    attempts: upgradedAttempts,
    changedFiles: old.changedFiles,
    referenceFixFiles: old.referenceFixFiles,
    referenceFixFilesInspected: old.referenceFixFilesInspected,
    referenceFixFilesModified: old.referenceFixFilesModified,
    rollbackUsed: old.rollbackUsed,
    aborted: old.aborted,
    terminalOutcome: old.terminalOutcome as TaskTrajectory['terminalOutcome'],
    providerRequestOutcomes: old.providerRequestOutcomes,
    timestamp: old.timestamp,
  } as TaskTrajectory
}

/** Main replay entry point. */
function main(): void {
  const trajDir = join(V3_DIR, 'trajectories')
  const files = readdirSync(trajDir).filter(f => f.endsWith('.json'))
  const upgraded: TaskTrajectory[] = []
  for (const file of files) {
    const raw = readFileSync(join(trajDir, file), 'utf8')
    const old = JSON.parse(raw) as OldTrajectory
    const upgradedTraj = upgradeTrajectory(old)
    upgraded.push(upgradedTraj)
  }
  upgraded.sort((a, b) => a.taskId.localeCompare(b.taskId))

  // Compute metrics with corrected accounting.
  const metrics = computeMetrics(upgraded)

  // Write upgraded trajectories and metrics.
  mkdirSync(join(OUTPUT_DIR, 'trajectories'), { recursive: true })
  for (const t of upgraded) {
    const outPath = join(OUTPUT_DIR, 'trajectories', `${t.taskId}.json`)
    writeFileSync(outPath, JSON.stringify(t, null, 2) + '\n')
  }
  writeFileSync(join(OUTPUT_DIR, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n')

  // Write a manifest for the replay.
  const manifest = {
    replayedFrom: 'v019-synthetic-multirepo-validation-v3',
    replayedAt: new Date().toISOString(),
    runClass: 'exploratory',
    securityGateBypassed: true,
    benchmarkEligible: false,
    experimentId: EXPLORATORY_EXPERIMENT_ID,
    correction: 'experiment identity fixed from v019-infra-validation-v3 to v019-exploratory-v4; per-model cost breakdown derived from attempt-level model attribution',
  }
  writeFileSync(join(OUTPUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  console.log('Replay complete.')
  console.log(`  Trajectories: ${upgraded.length}`)
  console.log(`  Experiment ID: ${EXPLORATORY_EXPERIMENT_ID}`)
  console.log(`  Verified: ${upgraded.filter(t => t.finalVerified).length}/${upgraded.length}`)
  console.log(`  Flash cost: $${metrics.flashCostShare?.toFixed(4) ?? 'n/a'}`)
  console.log(`  Pro cost: $${metrics.proCostShare?.toFixed(4) ?? 'n/a'}`)
  console.log(`  Output: ${OUTPUT_DIR}`)
}

main()
