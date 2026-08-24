import type {
  VerifiedSuccessUpliftSummary,
  VerificationBenchmarkObservation,
  VerificationFailureTaxonomyEntry,
} from './types.js'

/** Summarize false accepts/rejects by stable adversarial fault class. */
export function summarizeFailureTaxonomy(
  observations: readonly VerificationBenchmarkObservation[],
): readonly VerificationFailureTaxonomyEntry[] {
  const groups = new Map<string, VerificationBenchmarkObservation[]>()
  for (const observation of observations) {
    const key = observation.faultClass ?? (observation.groundTruth === 'valid' ? 'valid-control' : 'unclassified-invalid')
    const rows = groups.get(key) ?? []
    rows.push(observation)
    groups.set(key, rows)
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([faultClass, rows]) => {
    const valid = rows.filter(row => row.groundTruth === 'valid')
    const invalid = rows.filter(row => row.groundTruth === 'invalid')
    const falseAccepts = invalid.filter(row => row.accepted).length
    const falseRejects = valid.filter(row => !row.accepted).length
    return {
      faultClass,
      cases: rows.length,
      validCases: valid.length,
      invalidCases: invalid.length,
      falseAccepts,
      falseRejects,
      falseAcceptanceRate: invalid.length === 0 ? 0 : falseAccepts / invalid.length,
      falseRejectionRate: valid.length === 0 ? 0 : falseRejects / valid.length,
    }
  })
}

/**
 * Baseline assumes every candidate that says "complete" is accepted. The
 * verifier then filters that same candidate set. This measures how much the
 * verification layer improves the precision of accepted outcomes without
 * hiding the valid-work retention tradeoff.
 */
export function summarizeVerifiedSuccessUplift(
  observations: readonly VerificationBenchmarkObservation[],
): VerifiedSuccessUpliftSummary {
  const valid = observations.filter(row => row.groundTruth === 'valid')
  const invalid = observations.filter(row => row.groundTruth === 'invalid')
  const accepted = observations.filter(row => row.accepted)
  const trueAccepts = accepted.filter(row => row.groundTruth === 'valid').length
  const falseAccepts = accepted.length - trueAccepts
  const baselinePrecision = observations.length === 0 ? 0 : valid.length / observations.length
  const verifierPrecision = accepted.length === 0 ? 1 : trueAccepts / accepted.length
  return {
    cases: observations.length,
    baselineAcceptedCount: observations.length,
    verifierAcceptedCount: accepted.length,
    baselineAcceptedPrecision: baselinePrecision,
    verifierAcceptedPrecision: verifierPrecision,
    acceptedPrecisionUplift: verifierPrecision - baselinePrecision,
    validRetentionRate: valid.length === 0 ? 1 : trueAccepts / valid.length,
    falseAcceptsPrevented: invalid.length - falseAccepts,
  }
}

/** Mutation score: invalid mutations are "killed" when verification rejects them. */
export function summarizeMutationCalibration(
  observations: readonly VerificationBenchmarkObservation[],
): import('./types.js').MutationCalibrationSummary {
  const mutations = observations.filter(row => row.groundTruth === 'invalid' && row.mutationOperator !== undefined)
  const killed = mutations.filter(row => !row.accepted).length
  const operators = [...new Set(mutations.map(row => row.mutationOperator!))].sort()
  return {
    cases: mutations.length,
    killed,
    survived: mutations.length - killed,
    killRate: mutations.length === 0 ? 0 : killed / mutations.length,
    operators,
  }
}
