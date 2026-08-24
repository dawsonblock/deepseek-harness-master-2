export type CriterionSeverity = 'required' | 'important' | 'advisory'
export type VerificationMode = 'deterministic' | 'artifact' | 'runtime' | 'external-state' | 'benchmark' | 'evidence' | 'model'
export type VerifierCategory = 'acceptance' | 'integrity' | 'quality'
export type CriterionState = 'unknown' | 'pass' | 'fail' | 'stale' | 'blocked'
export type EvidenceSource = 'tool' | 'artifact' | 'runtime' | 'external' | 'model'

export interface EvidenceDependency {
  readonly kind: 'artifact' | 'runtime' | 'external'
  readonly key: string
  readonly version: string
}

export interface RepairHint {
  readonly message: string
  readonly file?: string
  readonly line?: number
  readonly code?: string
}

export type CriterionAuthority = 'system' | 'human' | 'contract-compiler' | 'worker'

export interface AcceptanceCriterion {
  readonly id: string
  readonly description: string
  readonly severity: CriterionSeverity
  readonly verificationMode: VerificationMode
  readonly verifier: string
  readonly verifierVersion?: string
  readonly args?: Readonly<Record<string, unknown>>
  readonly dependsOn?: readonly string[]
  readonly timeoutMs?: number
  readonly authority?: CriterionAuthority
}

export interface EvidencePolicy {
  readonly requireDeterministicForRequired?: boolean
  readonly minimumEvidencePerRequiredCriterion?: number
}

export interface CompletionPolicy {
  readonly importantPassRatio?: number
  readonly advisoryPassRatio?: number
  readonly failOnStaleRequired?: boolean
}

export interface AcceptancePackDescriptor {
  readonly id: 'runtime' | 'coding' | 'research' | 'deployment' | 'data-pipeline' | 'release' | string
  readonly version: string
}

export interface AcceptanceContract {
  readonly contractVersion: 1
  readonly pack?: AcceptancePackDescriptor
  readonly goalId: string
  readonly goalRevision: number
  readonly objective: string
  readonly criteria: readonly AcceptanceCriterion[]
  readonly evidencePolicy?: EvidencePolicy
  readonly completionPolicy?: CompletionPolicy
}

export interface VerificationContext {
  readonly contract: AcceptanceContract
  readonly criterion: AcceptanceCriterion
  readonly now: number
  readonly signal?: AbortSignal
  readonly readArtifact?: (key: string) => Promise<{ readonly value: unknown; readonly version: string } | undefined>
  readonly readRuntime?: (key: string) => Promise<{ readonly value: unknown; readonly version: string } | undefined>
  readonly readExternal?: (key: string) => Promise<{ readonly value: unknown; readonly version: string } | undefined>
}

export interface VerificationResult {
  readonly passed: boolean
  readonly reason: string
  readonly source?: EvidenceSource
  readonly result?: unknown
  readonly sourceEventSeqs?: readonly number[]
  readonly dependencies?: readonly EvidenceDependency[]
  readonly repairHints?: readonly RepairHint[]
}

export interface VerifierDefinition {
  readonly id: string
  readonly version: string
  readonly category: VerifierCategory
  readonly deterministic: boolean
  verify(context: VerificationContext, args: Readonly<Record<string, unknown>>): VerificationResult | Promise<VerificationResult>
}

export interface EvidenceRecord {
  readonly id: string
  readonly criterionId: string
  readonly verifierId: string
  readonly verifierVersion: string
  readonly source: EvidenceSource
  readonly sourceEventSeqs: readonly number[]
  readonly observedAt: number
  readonly result: unknown
  readonly resultHash: string
  readonly dependencies: readonly EvidenceDependency[]
  readonly passed: boolean
  readonly reason: string
  readonly repairHints: readonly RepairHint[]
}

export interface EvidenceInvalidation {
  readonly dependency: EvidenceDependency
  readonly invalidatedAt: number
  readonly reason: string
}

export interface CriterionVerificationStatus {
  readonly criterion: AcceptanceCriterion
  readonly verifierCategory?: VerifierCategory
  readonly state: CriterionState
  readonly evidence?: EvidenceRecord
  readonly reason: string
}

export interface ContractVerificationReport {
  readonly reportVersion: 1
  readonly goalId: string
  readonly goalRevision: number
  readonly contractHash: string
  readonly registryFingerprint: string
  readonly verifiedAt: number
  readonly passed: boolean
  readonly criteria: readonly CriterionVerificationStatus[]
  readonly required: { readonly total: number; readonly passed: number; readonly failed: number; readonly stale: number; readonly blocked: number }
  readonly important: { readonly total: number; readonly passed: number }
  readonly advisory: { readonly total: number; readonly passed: number }
}

export interface ArtifactReceipt {
  readonly key: string
  readonly sessionId?: string
  readonly createdAtSeq?: number
  readonly sha256: string
  readonly size?: number
  readonly version?: string
}

export interface CriterionReceipt {
  readonly criterionId: string
  readonly state: CriterionState
  readonly evidenceId?: string
  readonly evidenceHash?: string
}

export interface OutcomeReceipt {
  readonly receiptVersion: 1
  readonly goalId: string
  readonly goalRevision: number
  readonly contractHash: string
  readonly verifierPolicyHash: string
  readonly verifiedAt: number
  readonly criteria: readonly CriterionReceipt[]
  readonly artifacts: readonly ArtifactReceipt[]
  readonly unresolvedWarnings: readonly string[]
  readonly overallVerdict: 'pass' | 'pass-with-warnings'
  readonly supersedesReceipt?: string
  readonly receiptHash: string
}

export interface RepairPlanItem {
  readonly criterionId: string
  readonly state: Extract<CriterionState, 'fail' | 'stale' | 'blocked' | 'unknown'>
  readonly reason: string
  readonly hints: readonly RepairHint[]
}

export interface RepairPlan {
  readonly goalId: string
  readonly goalRevision: number
  readonly canRetryAutomatically: boolean
  readonly items: readonly RepairPlanItem[]
}

export interface EvidenceEdge {
  readonly from: string
  readonly to: string
  readonly relation: 'supports' | 'contradicts' | 'depends-on' | 'invalidates'
}

export type VerificationEnforcementMode = 'observe' | 'enforce'

export interface VerificationDecision {
  readonly mode: VerificationEnforcementMode
  readonly wouldAccept: boolean
  readonly accepted: boolean
  readonly reason: string
}

export type VerificationGroundTruth = 'valid' | 'invalid'

export interface VerificationBenchmarkCase {
  readonly id: string
  readonly pack: string
  readonly groundTruth: VerificationGroundTruth
  /** Stable adversarial/failure taxonomy label for benchmark analysis. */
  readonly faultClass?: string
  readonly expectedFailure?: string
  /** Mutation operator that produced this adversarial candidate, when applicable. */
  readonly mutationOperator?: string
  /** Stable id of the valid seed candidate that was mutated. */
  readonly mutationOf?: string
}


export interface VerificationBenchmarkObservation {
  readonly caseId: string
  readonly pack: string
  readonly groundTruth: VerificationGroundTruth
  readonly faultClass?: string
  readonly mutationOperator?: string
  readonly mutationOf?: string
  readonly accepted: boolean
  readonly verificationMs: number
  readonly verifierRuns: number
  readonly evidenceRecords: number
  readonly repairRounds: number
}

export interface VerificationBenchmarkSummary {
  readonly cases: number
  readonly validCases: number
  readonly invalidCases: number
  readonly trueAccepts: number
  readonly trueRejects: number
  readonly falseAccepts: number
  readonly falseRejects: number
  readonly falseAcceptanceRate: number
  readonly falseRejectionRate: number
  readonly meanVerificationMs: number
  readonly meanVerifierRuns: number
  readonly meanEvidenceRecords: number
  readonly meanRepairRounds: number
}

/** Promotion policy for moving a versioned acceptance pack from observe to enforce. */
export interface VerificationPackPromotionGate {
  readonly minimumCases?: number
  readonly minimumValidCases: number
  readonly minimumInvalidCases: number
  readonly maximumFalseAcceptanceRate: number
  readonly maximumFalseRejectionRate?: number
  readonly maximumFalseAcceptanceUpperBound95?: number
  readonly maximumFalseRejectionUpperBound95?: number
  /** Invalid/adversarial classes that must be represented for this pack. */
  readonly requiredFaultClasses?: readonly string[]
  /** Mutation-based adversarial candidates required for this pack. */
  readonly minimumMutationCases?: number
  /** Fraction of invalid mutations that must be rejected. */
  readonly minimumMutationKillRate?: number
}

export interface VerificationPromotionPolicy {
  readonly from: 'observe'
  readonly to: 'enforce'
  readonly minimumCases: number
  readonly minimumValidCases: number
  readonly minimumInvalidCases: number
  readonly maximumFalseAcceptanceRate: number
  readonly maximumFalseRejectionRate?: number
  /** Optional 95% Wilson upper-bound gate. More conservative than the observed rate alone. */
  readonly maximumFalseAcceptanceUpperBound95?: number
  readonly maximumFalseRejectionUpperBound95?: number
  /** Backward-compatible aggregate per-observed-pack rate gates. */
  readonly requirePerPackGates?: boolean
  /** v0.13: required packs receive independent sample, confidence, coverage, and mutation gates. */
  readonly requiredPacks?: Readonly<Record<string, VerificationPackPromotionGate>>
}

export interface BinomialRateInterval {
  readonly observed: number
  readonly lower95: number
  readonly upper95: number
  readonly errors: number
  readonly trials: number
}

export interface VerificationPolicyBinding {
  readonly packRegistryFingerprint: string
  readonly verifierRegistryFingerprint: string
  readonly trustedCheckRegistryFingerprint: string
}

export interface VerificationPromotionDecision {
  readonly eligible: boolean
  readonly from: 'observe'
  readonly to: 'enforce'
  readonly benchmarkFingerprint: string
  readonly policyBinding?: VerificationPolicyBinding
  readonly summary: VerificationBenchmarkSummary
  readonly far: BinomialRateInterval
  readonly frr: BinomialRateInterval
  readonly packCalibrations: Readonly<Record<string, VerificationPackCalibrationSummary>>
  readonly reasons: readonly string[]
  readonly evaluatedAt: number
}

export interface AcceptancePackFactory<TOptions = unknown> {
  readonly id: string
  readonly version: string
  create(input: { readonly goalId: string; readonly goalRevision: number; readonly objective: string }, options?: TOptions): AcceptanceContract
}


export interface VerificationFailureTaxonomyEntry {
  readonly faultClass: string
  readonly cases: number
  readonly validCases: number
  readonly invalidCases: number
  readonly falseAccepts: number
  readonly falseRejects: number
  readonly falseAcceptanceRate: number
  readonly falseRejectionRate: number
}

/**
 * Compares an unverified baseline that accepts every candidate-complete outcome
 * against the verifier's accepted set. Precision is the fraction of accepted
 * outcomes that are actually valid.
 */
export interface VerifiedSuccessUpliftSummary {
  readonly cases: number
  readonly baselineAcceptedCount: number
  readonly verifierAcceptedCount: number
  readonly baselineAcceptedPrecision: number
  readonly verifierAcceptedPrecision: number
  readonly acceptedPrecisionUplift: number
  readonly validRetentionRate: number
  readonly falseAcceptsPrevented: number
}

export interface VerificationPromotionReceipt {
  readonly receiptVersion: 1 | 2
  readonly benchmarkFingerprint: string
  readonly benchmarkSummaryHash: string
  /** v0.13 receipts bind the independent per-pack calibration surface. */
  readonly packCalibrationHash?: string
  readonly policyHash: string
  readonly policyBinding: VerificationPolicyBinding
  readonly evaluatedAt: number
  readonly expiresAt?: number
  readonly receiptHash: string
}


export interface MutationCalibrationSummary {
  readonly cases: number
  readonly killed: number
  readonly survived: number
  readonly killRate: number
  readonly operators: readonly string[]
}

export interface VerificationPackCalibrationSummary {
  readonly pack: string
  readonly summary: VerificationBenchmarkSummary
  readonly far: BinomialRateInterval
  readonly frr: BinomialRateInterval
  readonly faultClasses: readonly string[]
  readonly mutation: MutationCalibrationSummary
}

export interface VerificationMutationSeed<TFixture> {
  readonly id: string
  readonly pack: string
  readonly fixture: TFixture
}

export interface VerificationMutationOperator<TFixture> {
  readonly id: string
  readonly faultClass: string
  readonly appliesTo?: (seed: VerificationMutationSeed<TFixture>) => boolean
  mutate(fixture: TFixture, seed: VerificationMutationSeed<TFixture>): TFixture
}

export interface GeneratedVerificationMutation<TFixture> {
  readonly benchmarkCase: VerificationBenchmarkCase
  readonly fixture: TFixture
}
