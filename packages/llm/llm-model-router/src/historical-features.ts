/** Leakage-safe Bayesian history features computed from completed earlier tasks. */

/** One paired outcome available after both model runs complete. */
export interface HistoricalOutcomeObservation {
  bucket: string
  flashVerified: boolean
  proVerified: boolean
  flashRepairs: number
  flashCost: number
  proCost: number
}

/** Global priors and shrinkage strength fitted outside the current example. */
export interface BayesianHistoryPrior {
  flashPassRate: number
  proPassRate: number
  proRescueRate: number
  flashRepairRate: number
  meanCostDelta: number
  strength: number
}

/** Smoothed same-bucket measurements available before routing. */
export interface BayesianHistoricalFeatures {
  flashPassRate: number
  proPassRate: number
  proRescueRate: number
  flashRepairRate: number
  meanCostDelta: number
  sampleCount: number
  priorStrength: number
}

function smoothedRate(successes: number, samples: number, prior: number, strength: number): number {
  return (successes + strength * prior) / (samples + strength)
}

function finiteRate(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`deriveBayesianHistoricalFeatures: ${field} must be between 0 and 1`)
  }
}

/**
 * Derive same-bucket history from completed observations supplied by the caller.
 * @param priorObservations - outcomes that precede the task being featurized.
 * @param bucket - deterministic category or feature bucket for the current task.
 * @param prior - global rates and shrinkage strength learned outside the current example.
 * @returns smoothed historical rates, cost difference, and supporting sample count.
 */
export function deriveBayesianHistoricalFeatures(
  priorObservations: readonly HistoricalOutcomeObservation[],
  bucket: string,
  prior: BayesianHistoryPrior,
): BayesianHistoricalFeatures {
  finiteRate(prior.flashPassRate, 'prior.flashPassRate')
  finiteRate(prior.proPassRate, 'prior.proPassRate')
  finiteRate(prior.proRescueRate, 'prior.proRescueRate')
  finiteRate(prior.flashRepairRate, 'prior.flashRepairRate')
  if (!Number.isFinite(prior.meanCostDelta)) {
    throw new Error('deriveBayesianHistoricalFeatures: prior.meanCostDelta must be finite')
  }
  if (!Number.isFinite(prior.strength) || prior.strength <= 0) {
    throw new Error('deriveBayesianHistoricalFeatures: prior.strength must be positive')
  }

  const matching = priorObservations.filter(observation => observation.bucket === bucket)
  const samples = matching.length
  const flashPasses = matching.filter(observation => observation.flashVerified).length
  const proPasses = matching.filter(observation => observation.proVerified).length
  const rescues = matching.filter(observation => !observation.flashVerified && observation.proVerified).length
  const flashRepairTasks = matching.filter(observation => observation.flashRepairs > 0).length
  const totalCostDelta = matching.reduce(
    (sum, observation) => sum + observation.proCost - observation.flashCost,
    0,
  )
  return {
    flashPassRate: smoothedRate(flashPasses, samples, prior.flashPassRate, prior.strength),
    proPassRate: smoothedRate(proPasses, samples, prior.proPassRate, prior.strength),
    proRescueRate: smoothedRate(rescues, samples, prior.proRescueRate, prior.strength),
    flashRepairRate: smoothedRate(flashRepairTasks, samples, prior.flashRepairRate, prior.strength),
    meanCostDelta: (totalCostDelta + prior.strength * prior.meanCostDelta) / (samples + prior.strength),
    sampleCount: samples,
    priorStrength: prior.strength,
  }
}
