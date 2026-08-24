import type {
  ContractVerificationReport,
  VerificationBenchmarkCase,
  VerificationBenchmarkObservation,
  VerificationBenchmarkSummary,
  VerificationDecision,
  VerificationEnforcementMode,
} from './types.js'

export interface BenchmarkExecutionResult {
  readonly report: ContractVerificationReport
  readonly verificationMs: number
  readonly verifierRuns?: number
  readonly evidenceRecords?: number
  readonly repairRounds?: number
}

export type VerificationBenchmarkEvaluator = (benchmarkCase: VerificationBenchmarkCase) => BenchmarkExecutionResult | Promise<BenchmarkExecutionResult>

export function decideVerification(report: ContractVerificationReport, mode: VerificationEnforcementMode): VerificationDecision {
  const wouldAccept = report.passed
  if (mode === 'observe') {
    return {
      mode,
      wouldAccept,
      accepted: true,
      reason: wouldAccept ? 'observe mode: verifier would accept' : 'observe mode: verifier would reject but completion is not blocked',
    }
  }
  return {
    mode,
    wouldAccept,
    accepted: wouldAccept,
    reason: wouldAccept ? 'enforce mode: verification passed' : 'enforce mode: verification rejected completion',
  }
}

export async function runVerificationBenchmark(
  cases: readonly VerificationBenchmarkCase[],
  evaluator: VerificationBenchmarkEvaluator,
): Promise<{ readonly observations: readonly VerificationBenchmarkObservation[]; readonly summary: VerificationBenchmarkSummary }> {
  const observations: VerificationBenchmarkObservation[] = []
  const ids = new Set<string>()
  for (const benchmarkCase of cases) {
    if (ids.has(benchmarkCase.id)) throw new Error(`duplicate verification benchmark case id: ${benchmarkCase.id}`)
    ids.add(benchmarkCase.id)
    const result = await evaluator(benchmarkCase)
    observations.push({
      caseId: benchmarkCase.id,
      pack: benchmarkCase.pack,
      groundTruth: benchmarkCase.groundTruth,
      ...(benchmarkCase.faultClass ? { faultClass: benchmarkCase.faultClass } : {}),
      ...(benchmarkCase.mutationOperator ? { mutationOperator: benchmarkCase.mutationOperator } : {}),
      ...(benchmarkCase.mutationOf ? { mutationOf: benchmarkCase.mutationOf } : {}),
      accepted: result.report.passed,
      verificationMs: result.verificationMs,
      verifierRuns: result.verifierRuns ?? result.report.criteria.length,
      evidenceRecords: result.evidenceRecords ?? result.report.criteria.filter(row => row.evidence !== undefined).length,
      repairRounds: result.repairRounds ?? 0,
    })
  }
  return { observations, summary: summarizeVerificationBenchmark(observations) }
}

export function summarizeVerificationBenchmark(observations: readonly VerificationBenchmarkObservation[]): VerificationBenchmarkSummary {
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

export function assertVerificationBenchmarkGate(
  summary: VerificationBenchmarkSummary,
  gate: { readonly maximumFalseAcceptanceRate: number; readonly maximumFalseRejectionRate?: number },
): void {
  if (summary.falseAcceptanceRate > gate.maximumFalseAcceptanceRate) {
    throw new Error(`verification FAR ${summary.falseAcceptanceRate} exceeds ${gate.maximumFalseAcceptanceRate}`)
  }
  if (gate.maximumFalseRejectionRate !== undefined && summary.falseRejectionRate > gate.maximumFalseRejectionRate) {
    throw new Error(`verification FRR ${summary.falseRejectionRate} exceeds ${gate.maximumFalseRejectionRate}`)
  }
}

export function summarizeVerificationByPack(observations: readonly VerificationBenchmarkObservation[]): Readonly<Record<string, VerificationBenchmarkSummary>> {
  const packs = new Map<string, VerificationBenchmarkObservation[]>()
  for (const observation of observations) {
    const rows = packs.get(observation.pack) ?? []
    rows.push(observation)
    packs.set(observation.pack, rows)
  }
  return Object.fromEntries([...packs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, rows]) => [id, summarizeVerificationBenchmark(rows)]))
}
