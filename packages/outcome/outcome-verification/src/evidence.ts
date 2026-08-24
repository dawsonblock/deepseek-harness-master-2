import { hashCanonical } from './canonical.js'
import type { AcceptanceCriterion, CriterionState, EvidenceDependency, EvidenceInvalidation, EvidenceRecord, VerificationResult } from './types.js'

function dependencyKey(dependency: EvidenceDependency): string {
  return `${dependency.kind}:${dependency.key}`
}

export class EvidenceStore {
  private readonly records: EvidenceRecord[] = []
  private readonly invalidations: EvidenceInvalidation[] = []
  private serial = 0

  append(criterion: AcceptanceCriterion, verifierId: string, verifierVersion: string, now: number, result: VerificationResult): EvidenceRecord {
    const normalizedResult = result.result ?? null
    const record: EvidenceRecord = Object.freeze({
      id: `evidence-${++this.serial}`,
      criterionId: criterion.id,
      verifierId,
      verifierVersion,
      source: result.source ?? 'runtime',
      sourceEventSeqs: Object.freeze([...(result.sourceEventSeqs ?? [])]),
      observedAt: now,
      result: normalizedResult,
      resultHash: hashCanonical(normalizedResult),
      dependencies: Object.freeze([...(result.dependencies ?? [])]),
      passed: result.passed === true,
      reason: result.reason.trim() || (result.passed ? 'passed' : 'failed without a reason'),
      repairHints: Object.freeze([...(result.repairHints ?? [])]),
    })
    this.records.push(record)
    return record
  }

  invalidate(dependency: EvidenceDependency, reason: string, now: number): EvidenceInvalidation {
    const item: EvidenceInvalidation = Object.freeze({ dependency: Object.freeze({ ...dependency }), reason, invalidatedAt: now })
    this.invalidations.push(item)
    return item
  }

  all(): readonly EvidenceRecord[] { return [...this.records] }
  recordsFor(criterionId: string): readonly EvidenceRecord[] { return this.records.filter(record => record.criterionId === criterionId) }
  invalidationLog(): readonly EvidenceInvalidation[] { return [...this.invalidations] }

  latest(criterionId: string): EvidenceRecord | undefined {
    for (let i = this.records.length - 1; i >= 0; i -= 1) if (this.records[i]?.criterionId === criterionId) return this.records[i]
    return undefined
  }

  state(criterionId: string): { readonly state: CriterionState; readonly evidence?: EvidenceRecord } {
    const evidence = this.latest(criterionId)
    if (!evidence) return { state: 'unknown' }
    const stale = evidence.dependencies.some(dependency => {
      const key = dependencyKey(dependency)
      return this.invalidations.some(invalidation => dependencyKey(invalidation.dependency) === key && invalidation.invalidatedAt >= evidence.observedAt)
    })
    if (stale) return { state: 'stale', evidence }
    return { state: evidence.passed ? 'pass' : 'fail', evidence }
  }
}
