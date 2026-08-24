import { acceptanceContractHash, topologicalCriteria, validateAcceptanceContract } from './contract.js'
import { hashCanonical } from './canonical.js'
import { EvidenceStore } from './evidence.js'
import { VerifierRegistry } from './registry.js'
import type { AcceptanceContract, AcceptanceCriterion, ArtifactReceipt, ContractVerificationReport, CriterionReceipt, CriterionVerificationStatus, OutcomeReceipt, RepairPlan, RepairPlanItem, VerificationContext, VerificationResult } from './types.js'

export interface VerificationEnvironment {
  readonly now?: () => number
  readonly readArtifact?: VerificationContext['readArtifact']
  readonly readRuntime?: VerificationContext['readRuntime']
  readonly readExternal?: VerificationContext['readExternal']
}

export class OutcomeVerificationEngine {
  readonly registry: VerifierRegistry
  readonly evidence: EvidenceStore

  constructor(registry: VerifierRegistry = new VerifierRegistry(), evidence: EvidenceStore = new EvidenceStore()) {
    this.registry = registry
    this.evidence = evidence
  }

  async verify(contract: AcceptanceContract, environment: VerificationEnvironment = {}, options: { readonly reuseFreshEvidence?: boolean } = {}): Promise<ContractVerificationReport> {
    validateAcceptanceContract(contract)
    const now = environment.now ?? Date.now
    const statuses = new Map<string, CriterionVerificationStatus>()
    for (const criterion of topologicalCriteria(contract.criteria)) {
      if (options.reuseFreshEvidence === true) {
        const current = this.evidence.state(criterion.id)
        if (current.state === 'pass' && current.evidence) {
          let verifierCategory: 'acceptance' | 'integrity' | 'quality' | undefined
          try { verifierCategory = this.registry.resolve(criterion.verifier, criterion.verifierVersion).category } catch {}
          statuses.set(criterion.id, { criterion, ...(verifierCategory ? { verifierCategory } : {}), state: 'pass', evidence: current.evidence, reason: current.evidence.reason })
          continue
        }
      }
      const dependencyFailure = (criterion.dependsOn ?? []).map(id => statuses.get(id)).find(status => status?.state !== 'pass')
      if (dependencyFailure) {
        statuses.set(criterion.id, { criterion, state: 'blocked', reason: `dependency ${dependencyFailure.criterion.id} is ${dependencyFailure.state}` })
        continue
      }
      let result: VerificationResult
      let verifierId = criterion.verifier
      let verifierVersion = criterion.verifierVersion ?? ''
      let verifierCategory: 'acceptance' | 'integrity' | 'quality' | undefined
      try {
        const verifier = this.registry.resolve(criterion.verifier, criterion.verifierVersion)
        verifierId = verifier.id
        verifierVersion = verifier.version
        verifierCategory = verifier.category
        if (contract.evidencePolicy?.requireDeterministicForRequired === true && criterion.severity === 'required' && !verifier.deterministic) {
          result = { passed: false, reason: `required criterion ${criterion.id} requires a deterministic verifier`, source: 'runtime' }
        } else {
          result = await withTimeout(verifier.verify({ contract, criterion, now: now(), ...(environment.readArtifact ? { readArtifact: environment.readArtifact } : {}), ...(environment.readRuntime ? { readRuntime: environment.readRuntime } : {}), ...(environment.readExternal ? { readExternal: environment.readExternal } : {}) }, criterion.args ?? {}), criterion.timeoutMs)
        }
      } catch (error: unknown) {
        result = { passed: false, reason: `verifier failed: ${error instanceof Error ? error.message : String(error)}`, source: 'runtime' }
      }
      const evidence = this.evidence.append(criterion, verifierId, verifierVersion, now(), result)
      const state = this.evidence.state(criterion.id).state
      statuses.set(criterion.id, { criterion, ...(verifierCategory ? { verifierCategory } : {}), state, evidence, reason: evidence.reason })
    }
    const criteria = contract.criteria.map(criterion => statuses.get(criterion.id) ?? { criterion, state: 'unknown' as const, reason: 'criterion was not evaluated' })
    const requiredRows = criteria.filter(row => row.criterion.severity === 'required')
    const importantRows = criteria.filter(row => row.criterion.severity === 'important')
    const advisoryRows = criteria.filter(row => row.criterion.severity === 'advisory')
    const count = (rows: readonly CriterionVerificationStatus[], state: CriterionVerificationStatus['state']) => rows.filter(row => row.state === state).length
    const importantRatio = importantRows.length === 0 ? 1 : count(importantRows, 'pass') / importantRows.length
    const advisoryRatio = advisoryRows.length === 0 ? 1 : count(advisoryRows, 'pass') / advisoryRows.length
    const minimumEvidence = contract.evidencePolicy?.minimumEvidencePerRequiredCriterion ?? 1
    const evidenceCountPass = requiredRows.every(row => this.evidence.recordsFor(row.criterion.id).filter(record => record.passed).length >= minimumEvidence)
    const requiredPass = requiredRows.length > 0 && requiredRows.every(row => row.state === 'pass') && evidenceCountPass
    const integrityPass = criteria.filter(row => row.verifierCategory === 'integrity').every(row => row.state === 'pass')
    const failOnStale = contract.completionPolicy?.failOnStaleRequired ?? true
    const passed = requiredPass
      && integrityPass
      && (!failOnStale || count(requiredRows, 'stale') === 0)
      && importantRatio >= (contract.completionPolicy?.importantPassRatio ?? 1)
      && advisoryRatio >= (contract.completionPolicy?.advisoryPassRatio ?? 0)
    return {
      reportVersion: 1, goalId: contract.goalId, goalRevision: contract.goalRevision,
      contractHash: acceptanceContractHash(contract), registryFingerprint: this.registry.fingerprint(), verifiedAt: now(), passed, criteria,
      required: { total: requiredRows.length, passed: count(requiredRows, 'pass'), failed: count(requiredRows, 'fail'), stale: count(requiredRows, 'stale'), blocked: count(requiredRows, 'blocked') },
      important: { total: importantRows.length, passed: count(importantRows, 'pass') },
      advisory: { total: advisoryRows.length, passed: count(advisoryRows, 'pass') },
    }
  }

  async verifyStale(contract: AcceptanceContract, environment: VerificationEnvironment = {}): Promise<ContractVerificationReport> {
    return this.verify(contract, environment, { reuseFreshEvidence: true })
  }

  status(contract: AcceptanceContract): readonly CriterionVerificationStatus[] {
    validateAcceptanceContract(contract)
    return contract.criteria.map(criterion => {
      const current = this.evidence.state(criterion.id)
      return { criterion, state: current.state, ...(current.evidence ? { evidence: current.evidence } : {}), reason: current.evidence?.reason ?? 'no evidence' }
    })
  }

  repairPlan(report: ContractVerificationReport): RepairPlan {
    const items: RepairPlanItem[] = report.criteria
      .filter(row => row.state !== 'pass')
      .map(row => ({ criterionId: row.criterion.id, state: row.state as RepairPlanItem['state'], reason: row.reason, hints: row.evidence?.repairHints ?? [] }))
    return { goalId: report.goalId, goalRevision: report.goalRevision, canRetryAutomatically: items.every(item => item.state !== 'blocked'), items }
  }

  createReceipt(report: ContractVerificationReport, artifacts: readonly ArtifactReceipt[] = [], unresolvedWarnings: readonly string[] = [], supersedesReceipt?: string): OutcomeReceipt {
    if (!report.passed) throw new Error('cannot create outcome receipt from a failing verification report')
    const criteria: CriterionReceipt[] = report.criteria.map(row => ({
      criterionId: row.criterion.id, state: row.state,
      ...(row.evidence ? { evidenceId: row.evidence.id, evidenceHash: hashCanonical(row.evidence) } : {}),
    }))
    const base = {
      receiptVersion: 1 as const, goalId: report.goalId, goalRevision: report.goalRevision,
      contractHash: report.contractHash, verifierPolicyHash: report.registryFingerprint, verifiedAt: report.verifiedAt,
      criteria, artifacts: [...artifacts].sort((a, b) => a.key.localeCompare(b.key)), unresolvedWarnings: [...unresolvedWarnings],
      overallVerdict: unresolvedWarnings.length === 0 ? 'pass' as const : 'pass-with-warnings' as const,
      ...(supersedesReceipt ? { supersedesReceipt } : {}),
    }
    return { ...base, receiptHash: hashCanonical(base) }
  }

  verifyReceipt(receipt: OutcomeReceipt, currentArtifacts?: readonly ArtifactReceipt[]): boolean {
    const { receiptHash, ...base } = receipt
    if (hashCanonical(base) !== receiptHash) return false
    if (currentArtifacts !== undefined) {
      const expected = [...receipt.artifacts].sort((a, b) => a.key.localeCompare(b.key))
      const current = [...currentArtifacts].sort((a, b) => a.key.localeCompare(b.key))
      if (expected.length !== current.length) return false
      for (let i = 0; i < expected.length; i += 1) {
        if (expected[i]?.key !== current[i]?.key || expected[i]?.sha256 !== current[i]?.sha256) return false
      }
    }
    return true
  }
}

async function withTimeout<T>(value: T | Promise<T>, timeoutMs?: number): Promise<T> {
  if (timeoutMs === undefined) return value
  const promise = Promise.resolve(value)
  let handle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => { handle = setTimeout(() => reject(new Error(`verification timed out after ${timeoutMs}ms`)), timeoutMs) })
  try { return await Promise.race([promise, timeout]) } finally { if (handle !== undefined) clearTimeout(handle) }
}
