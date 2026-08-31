/**
 * v0.19 metrics computation pipeline.
 *
 * Computes all pre-registered metrics from the trajectory dataset.
 * Metrics are derived entirely from trajectory records — no hidden counters
 * in the runner. `metrics.json` can be deleted and regenerated deterministically
 * from the trajectory artifacts plus task manifests.
 *
 * `NOT_EVALUATED` tasks (infrastructure failures) are excluded from capability
 * metrics but counted in infrastructure integrity metrics.
 *
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
  readonly evaluatedTaskCount: number
  readonly infraFailureCount: number
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
  readonly replayMismatchRate: number | null
  readonly providerFailureRate: number
  readonly referenceFixFileMissRate: number
  readonly referenceFixFileInspectionRate: number
  readonly referenceFixFileInspectionRecall: number
  readonly flashCostShare: number
  readonly proCostShare: number
  readonly cacheHitPercentage: number
  readonly incrementalRepairCost: number
  /** Latency breakdown by attempt type. */
  readonly latencyByAttemptType: {
    readonly oneShotFlash: number | null
    readonly flashRepair: number | null
    readonly proInitial: number | null
    readonly proRescue: number | null
    readonly failed: number | null
  }
  /** Cost breakdown by terminal outcome. */
  readonly costByOutcome: {
    readonly verifiedOneShot: number | null
    readonly verifiedRescued: number | null
    readonly ultimatelyFailed: number | null
  }
  /** Per-task cache semantics for cross-run comparability. */
  readonly cacheSemantics: {
    readonly totalCacheReadTokens: number
    readonly totalCacheMissTokens: number
    readonly meanCacheReadPerTask: number
    readonly meanCacheMissPerTask: number
  }
  readonly categoryBreakdown: readonly CategoryMetric[]
}

export interface CategoryMetric {
  readonly category: string
  /** Total tasks in the category, including non-benchmark and infrastructure failures. */
  readonly count: number
  /** Benchmark-eligible tasks in the category (excludes B0 smoke, etc.). */
  readonly eligibleCount: number
  /** Eligible tasks that completed model evaluation (excludes NOT_EVALUATED). */
  readonly evaluated: number
  readonly verified: number
  readonly oneShotFlash: number
  readonly flashRepair: number
  readonly proRescue: number
  readonly failed: number
  readonly infraFailed: number
  readonly meanCost: number
  readonly meanLatency: number
}

/**
 * Compute the full metrics report from a set of task trajectories.
 *
 * Only `benchmarkEligible` trajectories with `modelCapabilityStatus !== 'NOT_EVALUATED'`
 * contribute to capability metrics. Infrastructure failures are reported separately.
 */
export function computeMetrics(trajectories: readonly TaskTrajectory[]): MetricsReport {
  const n = trajectories.length
  if (n === 0) return emptyMetrics()

  // Sort by taskId for deterministic floating-point summation order.
  // Without this, metrics computed from execution-order trajectories differ
  // from metrics regenerated from disk-sorted trajectory files because
  // floating-point addition is not associative.
  const sorted = [...trajectories].sort((a, b) => a.taskId.localeCompare(b.taskId))

  const evaluated = sorted.filter(t => t.benchmarkEligible && t.modelCapabilityStatus !== 'NOT_EVALUATED')
  const evalN = evaluated.length
  const infraFailures = sorted.filter(t => t.taskState === 'FAILED_INFRA')

  const verified = evaluated.filter(t => t.finalVerified)
  const verifiedCount = verified.length
  const oneShotFlash = evaluated.filter(t =>
    t.attempts.length === 1 &&
    t.attempts[0]?.model === 'deepseek-v4-flash' &&
    t.finalVerified,
  )
  const initialFailures = evaluated.filter(t =>
    !(t.attempts.length === 1 && t.attempts[0]?.verified),
  )
  const rescued = evaluated.filter(t => t.attempts.length > 1 && t.finalVerified)
  const flashSelfRepaired = evaluated.filter(t =>
    t.attempts.length > 1 &&
    t.finalVerified &&
    t.proAttempts === 0,
  )
  const proEscalations = evaluated.filter(t => t.proAttempts > 0)
  const proRescued = proEscalations.filter(t => t.finalVerified)
  const budgetStops = evaluated.filter(t => t.terminalOutcome === 'budget-stop')
  const rollbacks = evaluated.filter(t => t.rollbackUsed)
  // Provider failure rate: per-request, not per-task. Counted as
  // model/request-outcome events with outcome 'error' or 'aborted' divided
  // by total model/request-outcome events across all benchmark-eligible
  // tasks. This is the true provider/transport failure rate, distinct from
  // control-plane errors (F19) which are harness defects, not provider
  // failures.
  const eligibleTrajectories = sorted.filter(t => t.benchmarkEligible && t.taskState !== 'FAILED_INFRA')
  const allOutcomes = eligibleTrajectories.flatMap(t => t.providerRequestOutcomes)
  const providerFailures = allOutcomes.filter(o => o.outcome === 'error' || o.outcome === 'aborted')
  const sameFailureEscalations = proEscalations.filter((t) => {
    const flashFingerprints = t.attempts
      .filter(a => a.model === 'deepseek-v4-flash')
      .map(a => a.failureFingerprint)
      .filter(f => f !== undefined)
    const unique = new Set(flashFingerprints)
    return flashFingerprints.length > 1 && unique.size === 1
  })

  // Reference-fix file miss: failed task with a reference fix where the
  // agent never inspected any file from the reference fix. This is a raw
  // proxy, not a definitive context-discovery failure — manual forensic
  // review is needed to promote a subset to genuine context failures.
  const failedWithReference = evaluated.filter(t =>
    !t.finalVerified &&
    t.referenceFixCommit !== undefined,
  )
  const referenceFixFileMisses = failedWithReference.filter(t =>
    t.referenceFixFilesInspected.length === 0,
  )

  // Reference-fix file inspection rate: across all tasks with a reference
  // fix, the fraction where the agent inspected at least one reference file.
  const tasksWithReference = evaluated.filter(t =>
    t.referenceFixCommit !== undefined,
  )
  const referenceFixFileInspected = tasksWithReference.filter(t =>
    t.referenceFixFilesInspected.length > 0,
  )

  // Reference-fix file inspection recall: across all tasks with a reference
  // fix, the average fraction of reference-fix files the agent inspected.
  // For example, if the fix touched 4 files and the agent inspected 1,
  // recall for that task is 0.25.
  const recallPerTask = tasksWithReference
    .filter(t => t.referenceFixFiles.length > 0)
    .map(t => t.referenceFixFilesInspected.length / t.referenceFixFiles.length)

  const totalCost = evaluated.reduce((s, t) => s + t.totalCostUsd, 0)
  const verifiedCost = verified.reduce((s, t) => s + t.totalCostUsd, 0)
  const flashCost = evaluated.reduce((s, t) =>
    s + t.attempts.filter(a => a.model === 'deepseek-v4-flash').reduce((a, x) => a + x.costUsd, 0), 0)
  const proCost = evaluated.reduce((s, t) =>
    s + t.attempts.filter(a => a.model === 'deepseek-v4-pro').reduce((a, x) => a + x.costUsd, 0), 0)
  // Incremental repair cost: the sum of costs for all attempts after
  // the first across all evaluated tasks. This measures the actual
  // additional spend on repair, not total cost minus one-shot cost
  // (which conflates repair spend with non-repair task cost).
  const incrementalRepairSpend = evaluated.reduce((s, t) =>
    s + t.attempts.slice(1).reduce((a, x) => a + x.costUsd, 0), 0)

  const latencies = evaluated.map(t => t.totalLatencyMs).sort((a, b) => a - b)
  const costs = evaluated.map(t => t.totalCostUsd).sort((a, b) => a - b)
  const verifiedCosts = verified.map(t => t.totalCostUsd).sort((a, b) => a - b)

  const totalCacheRead = evaluated.reduce((s, t) => s + t.totalCacheReadTokens, 0)
  const totalCacheMiss = evaluated.reduce((s, t) => s + t.totalCacheMissTokens, 0)
  const totalInputTokens = totalCacheRead + totalCacheMiss

  const categories = groupByCategory(sorted)

  return {
    experimentId: sorted[0]?.experimentId ?? '',
    taskCount: n,
    evaluatedTaskCount: evalN,
    infraFailureCount: infraFailures.length,
    verifiedTaskRate: evalN > 0 ? verifiedCount / evalN : 0,
    oneShotFlashRate: evalN > 0 ? oneShotFlash.length / evalN : 0,
    repairRescueRate: initialFailures.length > 0 ? rescued.length / initialFailures.length : 0,
    flashSelfRepairRate: initialFailures.length > 0 ? flashSelfRepaired.length / initialFailures.length : 0,
    proEscalationRate: evalN > 0 ? proEscalations.length / evalN : 0,
    proRescueRate: proEscalations.length > 0 ? proRescued.length / proEscalations.length : 0,
    meanAttemptsPerTask: evalN > 0 ? evaluated.reduce((s, t) => s + t.attempts.length, 0) / evalN : 0,
    meanCostPerTask: evalN > 0 ? totalCost / evalN : 0,
    medianCostPerTask: median(costs),
    meanCostPerVerifiedTask: verifiedCount > 0 ? verifiedCost / verifiedCount : 0,
    medianCostPerVerifiedTask: verifiedCount > 0 ? median(verifiedCosts) : 0,
    latencyP50: percentile(latencies, 0.50),
    latencyP75: percentile(latencies, 0.75),
    latencyP90: percentile(latencies, 0.90),
    latencyP95: percentile(latencies, 0.95),
    latencyMax: latencies.at(-1) ?? 0,
    sameFailureEscalationRate: proEscalations.length > 0 ? sameFailureEscalations.length / proEscalations.length : 0,
    rollbackRate: evalN > 0 ? rollbacks.length / evalN : 0,
    budgetStopRate: evalN > 0 ? budgetStops.length / evalN : 0,
    replayMismatchRate: null,
    providerFailureRate: allOutcomes.length > 0 ? providerFailures.length / allOutcomes.length : 0,
    referenceFixFileMissRate: failedWithReference.length > 0
      ? referenceFixFileMisses.length / failedWithReference.length
      : 0,
    referenceFixFileInspectionRate: tasksWithReference.length > 0
      ? referenceFixFileInspected.length / tasksWithReference.length
      : 0,
    referenceFixFileInspectionRecall: recallPerTask.length > 0
      ? recallPerTask.reduce((s, r) => s + r, 0) / recallPerTask.length
      : 0,
    flashCostShare: totalCost > 0 ? flashCost / totalCost : 0,
    proCostShare: totalCost > 0 ? proCost / totalCost : 0,
    cacheHitPercentage: totalInputTokens > 0 ? totalCacheRead / totalInputTokens : 0,
    incrementalRepairCost: incrementalRepairSpend,
    latencyByAttemptType: computeLatencyByAttemptType(evaluated),
    costByOutcome: computeCostByOutcome(evaluated),
    cacheSemantics: {
      totalCacheReadTokens: totalCacheRead,
      totalCacheMissTokens: totalCacheMiss,
      meanCacheReadPerTask: evalN > 0 ? totalCacheRead / evalN : 0,
      meanCacheMissPerTask: evalN > 0 ? totalCacheMiss / evalN : 0,
    },
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
  return [...categories.entries()].map(([category, tasks]) => {
    // Apply the same benchmarkEligible filter as global metrics so
    // category metrics exclude non-benchmark trajectories (e.g. B0).
    const eligibleTasks = tasks.filter(t => t.benchmarkEligible)
    const evalTasks = eligibleTasks.filter(t => t.modelCapabilityStatus !== 'NOT_EVALUATED')
    return {
      category,
      count: tasks.length,
      eligibleCount: eligibleTasks.length,
      evaluated: evalTasks.length,
      verified: evalTasks.filter(t => t.finalVerified).length,
      oneShotFlash: evalTasks.filter(t =>
        t.attempts.length === 1 &&
        t.attempts[0]?.model === 'deepseek-v4-flash' &&
        t.finalVerified,
      ).length,
      flashRepair: evalTasks.filter(t =>
        t.attempts.length > 1 && t.finalVerified && t.proAttempts === 0,
      ).length,
      proRescue: evalTasks.filter(t => t.proAttempts > 0 && t.finalVerified).length,
      failed: evalTasks.filter(t => !t.finalVerified).length,
      infraFailed: tasks.filter(t => t.taskState === 'FAILED_INFRA').length,
      meanCost: evalTasks.length > 0
        ? evalTasks.reduce((s, t) => s + t.totalCostUsd, 0) / evalTasks.length
        : 0,
      meanLatency: evalTasks.length > 0
        ? evalTasks.reduce((s, t) => s + t.totalLatencyMs, 0) / evalTasks.length
        : 0,
    }
  }).sort((a, b) => a.category.localeCompare(b.category))
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
    experimentId: '', taskCount: 0, evaluatedTaskCount: 0, infraFailureCount: 0,
    verifiedTaskRate: 0, oneShotFlashRate: 0,
    repairRescueRate: 0, flashSelfRepairRate: 0, proEscalationRate: 0, proRescueRate: 0,
    meanAttemptsPerTask: 0, meanCostPerTask: 0, medianCostPerTask: 0,
    meanCostPerVerifiedTask: 0, medianCostPerVerifiedTask: 0,
    latencyP50: 0, latencyP75: 0, latencyP90: 0, latencyP95: 0, latencyMax: 0,
    sameFailureEscalationRate: 0, rollbackRate: 0, budgetStopRate: 0,
    replayMismatchRate: null, providerFailureRate: 0,
    referenceFixFileMissRate: 0, referenceFixFileInspectionRate: 0,
    referenceFixFileInspectionRecall: 0,
    flashCostShare: 0, proCostShare: 0, cacheHitPercentage: 0,
    incrementalRepairCost: 0,
    latencyByAttemptType: {
      oneShotFlash: null, flashRepair: null, proInitial: null, proRescue: null, failed: null,
    },
    costByOutcome: {
      verifiedOneShot: null, verifiedRescued: null, ultimatelyFailed: null,
    },
    cacheSemantics: {
      totalCacheReadTokens: 0, totalCacheMissTokens: 0,
      meanCacheReadPerTask: 0, meanCacheMissPerTask: 0,
    },
    categoryBreakdown: [],
  }
}

function computeLatencyByAttemptType(evaluated: readonly TaskTrajectory[]): {
  readonly oneShotFlash: number | null
  readonly flashRepair: number | null
  readonly proInitial: number | null
  readonly proRescue: number | null
  readonly failed: number | null
} {
  const oneShotFlash = evaluated.filter(t =>
    t.attempts.length === 1 && t.attempts[0]?.model === 'deepseek-v4-flash' && t.finalVerified,
  ).map(t => t.totalLatencyMs)
  const flashRepair = evaluated.filter(t =>
    t.attempts.length > 1 && t.proAttempts === 0 && t.finalVerified,
  ).map(t => t.totalLatencyMs)
  const proInitial = evaluated.filter(t =>
    t.attempts.length === 1 && t.attempts[0]?.model === 'deepseek-v4-pro' && t.finalVerified,
  ).map(t => t.totalLatencyMs)
  const proRescue = evaluated.filter(t =>
    t.proAttempts > 0 && t.attempts.length > 1 && t.finalVerified,
  ).map(t => t.totalLatencyMs)
  const failed = evaluated.filter(t => !t.finalVerified).map(t => t.totalLatencyMs)
  return {
    oneShotFlash: meanOrNull(oneShotFlash),
    flashRepair: meanOrNull(flashRepair),
    proInitial: meanOrNull(proInitial),
    proRescue: meanOrNull(proRescue),
    failed: meanOrNull(failed),
  }
}

function computeCostByOutcome(evaluated: readonly TaskTrajectory[]): {
  readonly verifiedOneShot: number | null
  readonly verifiedRescued: number | null
  readonly ultimatelyFailed: number | null
} {
  const verifiedOneShot = evaluated.filter(t =>
    t.attempts.length === 1 && t.finalVerified,
  ).map(t => t.totalCostUsd)
  const verifiedRescued = evaluated.filter(t =>
    t.attempts.length > 1 && t.finalVerified,
  ).map(t => t.totalCostUsd)
  const ultimatelyFailed = evaluated.filter(t => !t.finalVerified).map(t => t.totalCostUsd)
  return {
    verifiedOneShot: meanOrNull(verifiedOneShot),
    verifiedRescued: meanOrNull(verifiedRescued),
    ultimatelyFailed: meanOrNull(ultimatelyFailed),
  }
}

function meanOrNull(values: readonly number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((s, v) => s + v, 0) / values.length
}
