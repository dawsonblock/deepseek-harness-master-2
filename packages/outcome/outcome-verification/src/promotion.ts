import { hashCanonical } from './canonical.js'
import { summarizeVerificationBenchmark, summarizeVerificationByPack } from './benchmark.js'
import { summarizeMutationCalibration } from './calibration.js'
import type {
  BinomialRateInterval,
  VerificationBenchmarkObservation,
  VerificationPromotionDecision,
  VerificationPromotionPolicy,
  VerificationPolicyBinding,
  VerificationEnforcementMode,
  VerificationPromotionReceipt,
  VerificationPackCalibrationSummary,
  VerificationPackPromotionGate,
} from './types.js'

const Z_95 = 1.959963984540054

/** Wilson score interval; stable for zero-error corpora where Wald intervals are misleading. */
export function wilson95(errors: number, trials: number): BinomialRateInterval {
  if (!Number.isInteger(errors) || !Number.isInteger(trials) || errors < 0 || trials < 0 || errors > trials) {
    throw new Error('invalid binomial counts')
  }
  if (trials === 0) return { observed: 0, lower95: 0, upper95: 1, errors, trials }
  const p = errors / trials
  const z2 = Z_95 * Z_95
  const denominator = 1 + z2 / trials
  const center = (p + z2 / (2 * trials)) / denominator
  const margin = Z_95 * Math.sqrt((p * (1 - p) / trials) + (z2 / (4 * trials * trials))) / denominator
  return {
    observed: p,
    lower95: Math.max(0, center - margin),
    upper95: Math.min(1, center + margin),
    errors,
    trials,
  }
}

export function summarizeVerificationPackCalibrations(
  observations: readonly VerificationBenchmarkObservation[],
): Readonly<Record<string, VerificationPackCalibrationSummary>> {
  const byPack = new Map<string, VerificationBenchmarkObservation[]>()
  for (const row of observations) {
    const rows = byPack.get(row.pack) ?? []
    rows.push(row)
    byPack.set(row.pack, rows)
  }
  return Object.fromEntries([...byPack.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([pack, rows]) => {
    const summary = summarizeVerificationBenchmark(rows)
    const calibration: VerificationPackCalibrationSummary = {
      pack,
      summary,
      far: wilson95(summary.falseAccepts, summary.invalidCases),
      frr: wilson95(summary.falseRejects, summary.validCases),
      faultClasses: [...new Set(rows.filter(row => row.groundTruth === 'invalid' && row.faultClass).map(row => row.faultClass!))].sort(),
      mutation: summarizeMutationCalibration(rows),
    }
    return [pack, calibration]
  }))
}

function applyPackGate(pack: string, calibration: VerificationPackCalibrationSummary | undefined, gate: VerificationPackPromotionGate, reasons: string[]): void {
  if (!calibration) { reasons.push(`${pack}: required pack has no benchmark observations`); return }
  const { summary, far, frr, faultClasses, mutation } = calibration
  const minimumCases = gate.minimumCases ?? (gate.minimumValidCases + gate.minimumInvalidCases)
  if (summary.cases < minimumCases) reasons.push(`${pack}: requires at least ${minimumCases} cases; observed ${summary.cases}`)
  if (summary.validCases < gate.minimumValidCases) reasons.push(`${pack}: requires at least ${gate.minimumValidCases} valid cases; observed ${summary.validCases}`)
  if (summary.invalidCases < gate.minimumInvalidCases) reasons.push(`${pack}: requires at least ${gate.minimumInvalidCases} invalid cases; observed ${summary.invalidCases}`)
  if (summary.falseAcceptanceRate > gate.maximumFalseAcceptanceRate) reasons.push(`${pack}: FAR ${summary.falseAcceptanceRate} exceeds ${gate.maximumFalseAcceptanceRate}`)
  if (gate.maximumFalseRejectionRate !== undefined && summary.falseRejectionRate > gate.maximumFalseRejectionRate) reasons.push(`${pack}: FRR ${summary.falseRejectionRate} exceeds ${gate.maximumFalseRejectionRate}`)
  if (gate.maximumFalseAcceptanceUpperBound95 !== undefined && far.upper95 > gate.maximumFalseAcceptanceUpperBound95) reasons.push(`${pack}: FAR 95% upper bound ${far.upper95} exceeds ${gate.maximumFalseAcceptanceUpperBound95}`)
  if (gate.maximumFalseRejectionUpperBound95 !== undefined && frr.upper95 > gate.maximumFalseRejectionUpperBound95) reasons.push(`${pack}: FRR 95% upper bound ${frr.upper95} exceeds ${gate.maximumFalseRejectionUpperBound95}`)
  for (const required of gate.requiredFaultClasses ?? []) if (!faultClasses.includes(required)) reasons.push(`${pack}: required fault class not covered: ${required}`)
  if (gate.minimumMutationCases !== undefined && mutation.cases < gate.minimumMutationCases) reasons.push(`${pack}: requires at least ${gate.minimumMutationCases} mutation cases; observed ${mutation.cases}`)
  if (gate.minimumMutationKillRate !== undefined && mutation.killRate < gate.minimumMutationKillRate) reasons.push(`${pack}: mutation kill rate ${mutation.killRate} below ${gate.minimumMutationKillRate}`)
}

export function evaluateVerificationPromotion(
  observations: readonly VerificationBenchmarkObservation[],
  policy: VerificationPromotionPolicy,
  options: { readonly policyBinding?: VerificationPolicyBinding; readonly now?: number } = {},
): VerificationPromotionDecision {
  validatePolicy(policy)
  const summary = summarizeVerificationBenchmark(observations)
  const far = wilson95(summary.falseAccepts, summary.invalidCases)
  const frr = wilson95(summary.falseRejects, summary.validCases)
  const packCalibrations = summarizeVerificationPackCalibrations(observations)
  const reasons: string[] = []

  if (summary.cases < policy.minimumCases) reasons.push(`requires at least ${policy.minimumCases} labeled cases; observed ${summary.cases}`)
  if (summary.validCases < policy.minimumValidCases) reasons.push(`requires at least ${policy.minimumValidCases} valid cases; observed ${summary.validCases}`)
  if (summary.invalidCases < policy.minimumInvalidCases) reasons.push(`requires at least ${policy.minimumInvalidCases} invalid cases; observed ${summary.invalidCases}`)
  if (summary.falseAcceptanceRate > policy.maximumFalseAcceptanceRate) reasons.push(`FAR ${summary.falseAcceptanceRate} exceeds ${policy.maximumFalseAcceptanceRate}`)
  if (policy.maximumFalseRejectionRate !== undefined && summary.falseRejectionRate > policy.maximumFalseRejectionRate) reasons.push(`FRR ${summary.falseRejectionRate} exceeds ${policy.maximumFalseRejectionRate}`)
  if (policy.maximumFalseAcceptanceUpperBound95 !== undefined && far.upper95 > policy.maximumFalseAcceptanceUpperBound95) reasons.push(`FAR 95% upper bound ${far.upper95} exceeds ${policy.maximumFalseAcceptanceUpperBound95}`)
  if (policy.maximumFalseRejectionUpperBound95 !== undefined && frr.upper95 > policy.maximumFalseRejectionUpperBound95) reasons.push(`FRR 95% upper bound ${frr.upper95} exceeds ${policy.maximumFalseRejectionUpperBound95}`)

  if (policy.requirePerPackGates) {
    for (const [pack, packSummary] of Object.entries(summarizeVerificationByPack(observations))) {
      if (packSummary.invalidCases > 0 && packSummary.falseAcceptanceRate > policy.maximumFalseAcceptanceRate) reasons.push(`${pack}: FAR ${packSummary.falseAcceptanceRate} exceeds ${policy.maximumFalseAcceptanceRate}`)
      if (policy.maximumFalseRejectionRate !== undefined && packSummary.validCases > 0 && packSummary.falseRejectionRate > policy.maximumFalseRejectionRate) reasons.push(`${pack}: FRR ${packSummary.falseRejectionRate} exceeds ${policy.maximumFalseRejectionRate}`)
    }
  }

  for (const [pack, gate] of Object.entries(policy.requiredPacks ?? {})) applyPackGate(pack, packCalibrations[pack], gate, reasons)

  return {
    eligible: reasons.length === 0,
    from: 'observe',
    to: 'enforce',
    benchmarkFingerprint: hashCanonical(observations.map(row => ({ caseId: row.caseId, pack: row.pack, groundTruth: row.groundTruth, ...(row.faultClass !== undefined ? { faultClass: row.faultClass } : {}), ...(row.mutationOperator !== undefined ? { mutationOperator: row.mutationOperator } : {}), ...(row.mutationOf !== undefined ? { mutationOf: row.mutationOf } : {}), accepted: row.accepted, verificationMs: row.verificationMs, verifierRuns: row.verifierRuns, evidenceRecords: row.evidenceRecords, repairRounds: row.repairRounds })).sort((a, b) => a.caseId.localeCompare(b.caseId))),
    ...(options.policyBinding ? { policyBinding: options.policyBinding } : {}),
    summary,
    far,
    frr,
    packCalibrations,
    reasons,
    evaluatedAt: options.now ?? Date.now(),
  }
}

export function assertVerificationPromotion(decision: VerificationPromotionDecision): void {
  if (!decision.eligible) throw new Error(`verification promotion rejected: ${decision.reasons.join('; ')}`)
}

function validatePolicy(policy: VerificationPromotionPolicy): void {
  for (const [key, value] of Object.entries({
    minimumCases: policy.minimumCases,
    minimumValidCases: policy.minimumValidCases,
    minimumInvalidCases: policy.minimumInvalidCases,
  })) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${key} must be a non-negative integer`)
  }
  for (const [key, value] of Object.entries({
    maximumFalseAcceptanceRate: policy.maximumFalseAcceptanceRate,
    maximumFalseRejectionRate: policy.maximumFalseRejectionRate,
    maximumFalseAcceptanceUpperBound95: policy.maximumFalseAcceptanceUpperBound95,
    maximumFalseRejectionUpperBound95: policy.maximumFalseRejectionUpperBound95,
  })) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) throw new Error(`${key} must be between 0 and 1`)
  }
  for (const [pack, gate] of Object.entries(policy.requiredPacks ?? {})) {
    if (!pack.trim()) throw new Error('required pack id must be non-empty')
    for (const [key, value] of Object.entries({ minimumCases: gate.minimumCases, minimumValidCases: gate.minimumValidCases, minimumInvalidCases: gate.minimumInvalidCases, minimumMutationCases: gate.minimumMutationCases })) {
      if (value !== undefined && (!Number.isInteger(value) || value < 0)) throw new Error(`${pack}.${key} must be a non-negative integer`)
    }
    for (const [key, value] of Object.entries({ maximumFalseAcceptanceRate: gate.maximumFalseAcceptanceRate, maximumFalseRejectionRate: gate.maximumFalseRejectionRate, maximumFalseAcceptanceUpperBound95: gate.maximumFalseAcceptanceUpperBound95, maximumFalseRejectionUpperBound95: gate.maximumFalseRejectionUpperBound95, minimumMutationKillRate: gate.minimumMutationKillRate })) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) throw new Error(`${pack}.${key} must be between 0 and 1`)
    }
    const classes = gate.requiredFaultClasses ?? []
    if (new Set(classes).size !== classes.length || classes.some(value => !value.trim())) throw new Error(`${pack}.requiredFaultClasses must be unique non-empty strings`)
  }
}


/**
 * Promotion is only valid for the exact calibrated policy. Any pack/verifier/
 * trusted-check drift falls back to observe mode until a fresh benchmark is run.
 */
export function resolvePromotedVerificationMode(
  defaultMode: VerificationEnforcementMode,
  decision: VerificationPromotionDecision | undefined,
  currentBinding: VerificationPolicyBinding,
): { readonly mode: VerificationEnforcementMode; readonly reason: string } {
  if (defaultMode === 'enforce') return { mode: 'enforce', reason: 'configuration explicitly enforces verification' }
  if (!decision?.eligible) return { mode: 'observe', reason: 'no eligible promotion decision' }
  if (!decision.policyBinding) return { mode: 'observe', reason: 'promotion decision is not policy-bound' }
  const fields: readonly (keyof VerificationPolicyBinding)[] = ['packRegistryFingerprint', 'verifierRegistryFingerprint', 'trustedCheckRegistryFingerprint']
  for (const field of fields) {
    if (decision.policyBinding[field] !== currentBinding[field]) return { mode: 'observe', reason: `verification policy drift: ${field}` }
  }
  return { mode: 'enforce', reason: 'eligible promotion matches current verification policy fingerprints' }
}


/** Create an immutable promotion receipt for an eligible, policy-bound decision. */
export function createVerificationPromotionReceipt(
  decision: VerificationPromotionDecision,
  policy: VerificationPromotionPolicy,
  options: { readonly expiresAt?: number } = {},
): VerificationPromotionReceipt {
  if (!decision.eligible) throw new Error('cannot create promotion receipt from ineligible decision')
  if (!decision.policyBinding) throw new Error('cannot create promotion receipt without policy binding')
  const base = {
    receiptVersion: 2 as const,
    benchmarkFingerprint: decision.benchmarkFingerprint,
    benchmarkSummaryHash: hashCanonical(decision.summary),
    packCalibrationHash: hashCanonical(decision.packCalibrations),
    policyHash: hashCanonical(policy),
    policyBinding: decision.policyBinding,
    evaluatedAt: decision.evaluatedAt,
    ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
  }
  return { ...base, receiptHash: hashCanonical(base) }
}

export function verifyVerificationPromotionReceipt(
  receipt: VerificationPromotionReceipt,
  policy: VerificationPromotionPolicy,
  currentBinding: VerificationPolicyBinding,
  options: { readonly now?: number } = {},
): { readonly valid: boolean; readonly reason: string } {
  const { receiptHash, ...base } = receipt
  if (hashCanonical(base) !== receiptHash) return { valid: false, reason: 'promotion receipt hash mismatch' }
  if (receipt.policyHash !== hashCanonical(policy)) return { valid: false, reason: 'promotion policy changed' }
  const fields: readonly (keyof VerificationPolicyBinding)[] = ['packRegistryFingerprint', 'verifierRegistryFingerprint', 'trustedCheckRegistryFingerprint']
  for (const field of fields) {
    if (receipt.policyBinding[field] !== currentBinding[field]) return { valid: false, reason: `verification policy drift: ${field}` }
  }
  const now = options.now ?? Date.now()
  if (receipt.expiresAt !== undefined && now > receipt.expiresAt) return { valid: false, reason: 'promotion receipt expired' }
  return { valid: true, reason: 'promotion receipt matches calibrated verification policy' }
}

/**
 * v0.12 enforcement resolver. Unlike v0.11's decision-only helper, enforce mode
 * now requires a durable promotion receipt that still matches the current policy.
 */
export function resolveVerificationModeWithPromotionReceipt(
  requestedMode: VerificationEnforcementMode,
  receipt: VerificationPromotionReceipt | undefined,
  currentBinding: VerificationPolicyBinding,
  policy: VerificationPromotionPolicy,
  options: { readonly now?: number } = {},
): { readonly mode: VerificationEnforcementMode; readonly reason: string } {
  if (requestedMode !== 'enforce') return { mode: 'observe', reason: 'configuration requests observe mode' }
  if (!receipt) return { mode: 'observe', reason: 'enforce requested but no promotion receipt is available' }
  const verified = verifyVerificationPromotionReceipt(receipt, policy, currentBinding, options)
  if (!verified.valid) return { mode: 'observe', reason: verified.reason }
  return { mode: 'enforce', reason: verified.reason }
}
