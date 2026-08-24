import type { ContractVerificationReport } from './types.js'

export interface OutcomeTelemetrySnapshot {
  readonly verificationRuns: number
  readonly passes: number
  readonly failures: number
  readonly completionRejections: number
  readonly criteriaEvaluated: number
  readonly criteriaPassed: number
  readonly criteriaFailed: number
  readonly criteriaStale: number
  readonly criteriaBlocked: number
  readonly deterministicVerifierRate: number | null
}

export class OutcomeTelemetry {
  private runs = 0
  private passes = 0
  private failures = 0
  private rejections = 0
  private criteria = 0
  private criterionPasses = 0
  private criterionFailures = 0
  private criterionStale = 0
  private criterionBlocked = 0
  private deterministic = 0

  record(report: ContractVerificationReport, deterministicCriteria: number): void {
    this.runs += 1
    if (report.passed) this.passes += 1
    else { this.failures += 1; this.rejections += 1 }
    this.criteria += report.criteria.length
    this.criterionPasses += report.criteria.filter(row => row.state === 'pass').length
    this.criterionFailures += report.criteria.filter(row => row.state === 'fail').length
    this.criterionStale += report.criteria.filter(row => row.state === 'stale').length
    this.criterionBlocked += report.criteria.filter(row => row.state === 'blocked').length
    this.deterministic += deterministicCriteria
  }

  snapshot(): OutcomeTelemetrySnapshot {
    return {
      verificationRuns: this.runs, passes: this.passes, failures: this.failures, completionRejections: this.rejections,
      criteriaEvaluated: this.criteria, criteriaPassed: this.criterionPasses, criteriaFailed: this.criterionFailures,
      criteriaStale: this.criterionStale, criteriaBlocked: this.criterionBlocked,
      deterministicVerifierRate: this.criteria === 0 ? null : this.deterministic / this.criteria,
    }
  }
}
