/**
 * v0.19 metrics computation pipeline.
 *
 * Computes all pre-registered metrics from the trajectory dataset.
 * Metrics are computed only after the cohort is complete — no incremental
 * tuning during collection.
 *
 * @module v019-metrics
 */

import type { TaskTrajectory } from './v019-trajectory-collector.ts'

/** Complete metrics report for the evaluation cohort. */
export interface MetricsReport {
  readonly experimentId: string
  readonly taskCount: number
  readonly verifiedTaskRate: number
  readonly oneShotFlashRate: number
  readonly repairRescueRate: number
  readonly flashSelfRepairRate: number
  readonly proEscalationRate: number
  readonly proRescueRate: number
  readonly meanAttemptsPerTask: number
  readonly meanCostPerTask: number
  readonly medianCostPerTask: number
  readonly meanCostPerVerifiedTask: number
  readonly medianCostPerVerifiedTask: number
  readonly latencyP50: number
  readonly latencyP75: number
  readonly latencyP90: number
  readonly latencyP95: number
  readonly latencyMax: number
  readonly sameFailureEscalationRate: number
  readonly rollbackRate: number
  readonly budgetStopRate: number
  readonly replayMismatchRate: number
  readonly providerFailureRate: number
  readonly flashCostShare: number
  readonly proCostShare: number
  readonly cacheHitPercentage: number
  readonly incrementalRepairCost: number
  readonly categoryBreakdown: readonly CategoryMetric[]
}

export interface CategoryMetric {
  readonly category: string
  readonly count: number
  readonly verified: number
  readonly oneShotFlash: number
  readonly flashRepair: number
  readonly proRescue: number
  readonly failed: number
  readonly meanCost: number
  readonly meanLatency: number
}

/** Compute the full metrics report from a set of task trajectories. */
export function computeMetrics(trajectories: readonly TaskTrajectory[]): MetricsReport {
  const n = trajectories.length
  if (n === 0) return emptyMetrics()

  const verified = trajectories.filter(t => t.finalVerified)
  const verifiedCount = verified.length
  const oneShotFlash = trajectories.filter(t => t.attempts.length === 1 && t.attempts[0]?.model === 'deepseek-v4-flash' && t.finalVerified)
  const initialFailures = trajectories.filter(t => !(t.attempts.length === 1 && t.attempts[0]?.verified))
  const rescued = trajectories.filter(t => t.attempts.length > 1 && t.finalVerified)
  const flashSelfRepaired = trajectories.filter(t =>
    t.attempts.length > 1 &&
    t.finalVerified &&
    t.proAttempts === 0,
  )
  const proEscalations = trajectories.filter(t => t.proAttempts > 0)
  const proRescued = proEscalations.filter(t => t.finalVerified)
  const budgetStops = trajectories.filter(t => t.terminalOutcome === 'budget-stop')
  const rollbacks = trajectories.filter(t => t.rollbackUsed)
  const providerFailures = trajectories.filter(t => t.aborted && t.abortReason !== undefined)
  const sameFailureEscalations = proEscalations.filter((t) => {
    const flashFingerprints = t.attempts.filter(a => a.model === 'deepseek-v4-flash').map(a => a.failureFingerprint).filter(f => f !== undefined)
    const unique = new Set(flashFingerprints)
    return flashFingerprints.length > 1 && unique.size === 1
  })

  const totalCost = trajectories.reduce((s, t) => s + t.totalCostUsd, 0)
  const verifiedCost = verified.reduce((s, t) => s + t.totalCostUsd, 0)
  const flashCost = trajectories.reduce((s, t) =>
    s + t.attempts.filter(a => a.model === 'deepseek-v4-flash').reduce((a, x) => a + x.costUsd, 0), 0)
  const proCost = trajectories.reduce((s, t) =>
    s + t.attempts.filter(a => a.model === 'deepseek-v4-pro').reduce((a, x) => a + x.costUsd, 0), 0)
  const oneShotFlashCost = oneShotFlash.reduce((s, t) => s + t.totalCostUsd, 0)

  const latencies = trajectories.map(t => t.totalLatencyMs).sort((a, b) => a - b)
  const costs = trajectories.map(t => t.totalCostUsd).sort((a, b) => a - b)
  const verifiedCosts = verified.map(t => t.totalCostUsd).sort((a, b) => a - b)

  const totalCacheRead = trajectories.reduce((s, t) => s + t.totalCacheReadTokens, 0)
  const totalCacheMiss = trajectories.reduce((s, t) => s + t.totalCacheMissTokens, 0)
  const totalInputTokens = totalCacheRead + totalCacheMiss

  const categories = groupByCategory(trajectories)

  return {
    experimentId: trajectories[0]?.experimentId ?? '',
    taskCount: n,
    verifiedTaskRate: verifiedCount / n,
    oneShotFlashRate: oneShotFlash.length / n,
    repairRescueRate: initialFailures.length > 0 ? rescued.length / initialFailures.length : 0,
    flashSelfRepairRate: initialFailures.length > 0 ? flashSelfRepaired.length / initialFailures.length : 0,
    proEscalationRate: proEscalations.length / n,
    proRescueRate: proEscalations.length > 0 ? proRescued.length / proEscalations.length : 0,
    meanAttemptsPerTask: trajectories.reduce((s, t) => s + t.attempts.length, 0) / n,
    meanCostPerTask: totalCost / n,
    medianCostPerTask: median(costs),
    meanCostPerVerifiedTask: verifiedCount > 0 ? verifiedCost / verifiedCount : 0,
    medianCostPerVerifiedTask: verifiedCount > 0 ? median(verifiedCosts) : 0,
    latencyP50: percentile(latencies, 0.50),
    latencyP75: percentile(latencies, 0.75),
    latencyP90: percentile(latencies, 0.90),
    latencyP95: percentile(latencies, 0.95),
    latencyMax: latencies.at(-1) ?? 0,
    sameFailureEscalationRate: proEscalations.length > 0 ? sameFailureEscalations.length / proEscalations.length : 0,
    rollbackRate: rollbacks.length / n,
    budgetStopRate: budgetStops.length / n,
    replayMismatchRate: 0,
    providerFailureRate: providerFailures.length / n,
    flashCostShare: totalCost > 0 ? flashCost / totalCost : 0,
    proCostShare: totalCost > 0 ? proCost / totalCost : 0,
    cacheHitPercentage: totalInputTokens > 0 ? totalCacheRead / totalInputTokens : 0,
    incrementalRepairCost: totalCost - oneShotFlashCost,
    categoryBreakdown: categories,
  }
}

function groupByCategory(trajectories: readonly TaskTrajectory[]): CategoryMetric[] {
  const categories = new Map<string, TaskTrajectory[]>()
  for (const t of trajectories) {
    const list = categories.get(t.category) ?? []
    list.push(t)
    categories.set(t.category, list)
  }
  return [...categories.entries()].map(([category, tasks]) => ({
    category,
    count: tasks.length,
    verified: tasks.filter(t => t.finalVerified).length,
    oneShotFlash: tasks.filter(t => t.attempts.length === 1 && t.attempts[0]?.model === 'deepseek-v4-flash' && t.finalVerified).length,
    flashRepair: tasks.filter(t => t.attempts.length > 1 && t.finalVerified && t.proAttempts === 0).length,
    proRescue: tasks.filter(t => t.proAttempts > 0 && t.finalVerified).length,
    failed: tasks.filter(t => !t.finalVerified).length,
    meanCost: tasks.reduce((s, t) => s + t.totalCostUsd, 0) / tasks.length,
    meanLatency: tasks.reduce((s, t) => s + t.totalLatencyMs, 0) / tasks.length,
  })).sort((a, b) => a.category.localeCompare(b.category))
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    const a = sorted[mid - 1] ?? 0
    const b = sorted[mid] ?? 0
    return (a + b) / 2
  }
  return sorted[mid] ?? 0
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.ceil(p * sorted.length) - 1
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))] ?? 0
}

function emptyMetrics(): MetricsReport {
  return {
    experimentId: '', taskCount: 0, verifiedTaskRate: 0, oneShotFlashRate: 0,
    repairRescueRate: 0, flashSelfRepairRate: 0, proEscalationRate: 0, proRescueRate: 0,
    meanAttemptsPerTask: 0, meanCostPerTask: 0, medianCostPerTask: 0,
    meanCostPerVerifiedTask: 0, medianCostPerVerifiedTask: 0,
    latencyP50: 0, latencyP75: 0, latencyP90: 0, latencyP95: 0, latencyMax: 0,
    sameFailureEscalationRate: 0, rollbackRate: 0, budgetStopRate: 0,
    replayMismatchRate: 0, providerFailureRate: 0,
    flashCostShare: 0, proCostShare: 0, cacheHitPercentage: 0,
    incrementalRepairCost: 0, categoryBreakdown: [],
  }
}
