import type { PairedVariantComparison, TaskObservation, VariantSummary } from './types.js'
import { percentile } from './util.js'

function sumOptional(values: readonly (number | undefined)[]): number | null {
  const present = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0)
}

function sum(values: readonly (number | undefined)[]): number {
  return values.reduce<number>((total, value) => total + (typeof value === 'number' && Number.isFinite(value) ? value : 0), 0)
}

export function summarizeVariant(name: string, observations: readonly TaskObservation[]): VariantSummary {
  const successes = observations.filter(observation => observation.success).length
  const totalCost = sumOptional(observations.map(observation => observation.cost))
  return {
    name,
    tasks: observations.length,
    successes,
    successRate: observations.length === 0 ? 0 : successes / observations.length,
    medianWallTimeMs: percentile(observations.map(observation => observation.wallTimeMs), 0.5),
    p95WallTimeMs: percentile(observations.map(observation => observation.wallTimeMs), 0.95),
    totalCost,
    costPerSuccess: totalCost === null || successes === 0 ? null : totalCost / successes,
    totalInputTokens: sum(observations.map(observation => observation.inputTokens)),
    totalOutputTokens: sum(observations.map(observation => observation.outputTokens)),
    totalCachedInputTokens: sum(observations.map(observation => observation.cachedInputTokens)),
    totalModelCalls: sum(observations.map(observation => observation.modelCalls)),
    totalToolCalls: sum(observations.map(observation => observation.toolCalls)),
  }
}

export function comparePairedVariants(
  baselineName: string, baselineObservations: readonly TaskObservation[],
  candidateName: string, candidateObservations: readonly TaskObservation[],
): PairedVariantComparison {
  const baselineByTask = new Map(baselineObservations.map(observation => [observation.taskId, observation]))
  const candidateByTask = new Map(candidateObservations.map(observation => [observation.taskId, observation]))
  let pairedTasks = 0
  let bothPassed = 0
  let bothFailed = 0
  let candidateOnlyPassed = 0
  let baselineOnlyPassed = 0
  for (const [taskId, baseline] of baselineByTask) {
    const candidate = candidateByTask.get(taskId)
    if (candidate === undefined) continue
    pairedTasks += 1
    if (baseline.success && candidate.success) bothPassed += 1
    else if (!baseline.success && !candidate.success) bothFailed += 1
    else if (candidate.success) candidateOnlyPassed += 1
    else baselineOnlyPassed += 1
  }
  return {
    baseline: summarizeVariant(baselineName, baselineObservations),
    candidate: summarizeVariant(candidateName, candidateObservations),
    pairedTasks, bothPassed, bothFailed, candidateOnlyPassed, baselineOnlyPassed,
    pairedSuccessDelta: pairedTasks === 0 ? 0 : (candidateOnlyPassed - baselineOnlyPassed) / pairedTasks,
  }
}

import type { VerificationBenchmarkSummary, VerificationObservation } from './types.js'

/** Verification quality summary. False acceptance is the safety-critical rate. */
export function summarizeVerificationObservations(observations: readonly VerificationObservation[]): VerificationBenchmarkSummary {
  const valid = observations.filter(row => row.groundTruth === 'valid')
  const invalid = observations.filter(row => row.groundTruth === 'invalid')
  const trueAccepts = valid.filter(row => row.accepted).length
  const falseRejects = valid.length - trueAccepts
  const falseAccepts = invalid.filter(row => row.accepted).length
  const trueRejects = invalid.length - falseAccepts
  const mean = (values: readonly number[]): number => values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
  return {
    cases: observations.length,
    validCases: valid.length,
    invalidCases: invalid.length,
    trueAccepts,
    trueRejects,
    falseAccepts,
    falseRejects,
    falseAcceptanceRate: invalid.length === 0 ? 0 : falseAccepts / invalid.length,
    falseRejectionRate: valid.length === 0 ? 0 : falseRejects / valid.length,
    meanVerificationMs: mean(observations.map(row => row.verificationMs)),
    meanVerifierRuns: mean(observations.map(row => row.verifierRuns)),
    meanEvidenceRecords: mean(observations.map(row => row.evidenceRecords)),
    meanRepairRounds: mean(observations.map(row => row.repairRounds)),
  }
}

export function compareVerificationPacks(
  baselineName: string,
  baseline: readonly VerificationObservation[],
  candidateName: string,
  candidate: readonly VerificationObservation[],
): {
  readonly baselineName: string
  readonly candidateName: string
  readonly baseline: VerificationBenchmarkSummary
  readonly candidate: VerificationBenchmarkSummary
  readonly falseAcceptanceDelta: number
  readonly falseRejectionDelta: number
} {
  const baselineSummary = summarizeVerificationObservations(baseline)
  const candidateSummary = summarizeVerificationObservations(candidate)
  return {
    baselineName,
    candidateName,
    baseline: baselineSummary,
    candidate: candidateSummary,
    falseAcceptanceDelta: candidateSummary.falseAcceptanceRate - baselineSummary.falseAcceptanceRate,
    falseRejectionDelta: candidateSummary.falseRejectionRate - baselineSummary.falseRejectionRate,
  }
}
