import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import {
  AcceptancePackRegistry,
  OutcomeVerificationEngine,
  STANDARD_ACCEPTANCE_PACK_FACTORIES,
  TrustedCheckRegistry,
  VerifierRegistry,
  createTrustedCheckVerifier,
  createVerificationPromotionReceipt,
  evaluateVerificationPromotion,
  releaseAcceptancePack,
  codingAcceptancePack,
  resolveVerificationModeWithPromotionReceipt,
  standardVerifiers,
  summarizeFailureTaxonomy,
  summarizeVerifiedSuccessUplift,
  runVerificationBenchmark,
  verifyVerificationPromotionReceipt,
} from '../packages/outcome/outcome-verification/lib/index.js'

const config = JSON.parse(await readFile(new URL('../config/acceptance/release-v3.json', import.meta.url), 'utf8'))
const ALL_CHECKS = config.trustedChecks
const VERSION = config.trustedCheckVersion
const scenarios = new Map()
const add = (id, scenario) => scenarios.set(id, scenario)

// 250 valid coding controls.
for (let i = 0; i < 250; i += 1) add(`coding-valid-${i}`, {
  pack: 'coding', valid: true, faultClass: 'valid-control',
  checks: { 'tests-pass': true, 'typecheck-pass': true }, runtime: { 'unresolved-side-effects': 0 },
})
// 550 coding adversarial cases, distributed across five fault classes.
const codingFaults = ['tests-fail','typecheck-fail','unresolved-side-effect','dual-check-fail','false-completion-claim']
for (let i = 0; i < 550; i += 1) {
  const faultClass = codingFaults[i % codingFaults.length]
  const checks = { 'tests-pass': true, 'typecheck-pass': true }
  const runtime = { 'unresolved-side-effects': 0 }
  if (faultClass === 'tests-fail' || faultClass === 'false-completion-claim') checks['tests-pass'] = false
  if (faultClass === 'typecheck-fail') checks['typecheck-pass'] = false
  if (faultClass === 'dual-check-fail') { checks['tests-pass'] = false; checks['typecheck-pass'] = false }
  if (faultClass === 'unresolved-side-effect') runtime['unresolved-side-effects'] = 1
  add(`coding-invalid-${i}`, { pack: 'coding', valid: false, faultClass, checks, runtime })
}

const releaseChecks = config.releaseTrustedChecks
// 250 valid release controls.
for (let i = 0; i < 250; i += 1) add(`release-valid-${i}`, {
  pack: 'release', valid: true, faultClass: 'valid-control',
  checks: Object.fromEntries(releaseChecks.map(id => [id, true])),
  runtime: { 'unresolved-side-effects': 0, 'recovery-status': i % 2 === 0 ? 'clean' : { canAutoResume: true, blocked: false } },
})
// 550 release adversarial cases: eight trusted-check failures + runtime/recovery faults.
const releaseFaults = [...releaseChecks.map(id => `trusted-check:${id}`), 'unresolved-side-effect', 'recovery-blocked', 'multi-fault']
for (let i = 0; i < 550; i += 1) {
  const faultClass = releaseFaults[i % releaseFaults.length]
  const checks = Object.fromEntries(releaseChecks.map(id => [id, true]))
  const runtime = { 'unresolved-side-effects': 0, 'recovery-status': 'clean' }
  if (faultClass.startsWith('trusted-check:')) checks[faultClass.slice('trusted-check:'.length)] = false
  if (faultClass === 'unresolved-side-effect') runtime['unresolved-side-effects'] = 2
  if (faultClass === 'recovery-blocked') runtime['recovery-status'] = { canAutoResume: false, blocked: true }
  if (faultClass === 'multi-fault') { checks['failure-injection-tests'] = false; checks['archive-manifest-valid'] = false; runtime['unresolved-side-effects'] = 1 }
  add(`release-invalid-${i}`, { pack: 'release', valid: false, faultClass, checks, runtime })
}

const cases = [...scenarios.entries()].map(([id, value]) => ({
  id, pack: value.pack, groundTruth: value.valid ? 'valid' : 'invalid', faultClass: value.faultClass,
}))
assert.equal(cases.length, 1600)

const packRegistry = new AcceptancePackRegistry()
for (const factory of STANDARD_ACCEPTANCE_PACK_FACTORIES) packRegistry.register(factory)
const baseVerifierRegistry = new VerifierRegistry()
for (const verifier of standardVerifiers()) baseVerifierRegistry.register(verifier)
const trustedTemplate = new TrustedCheckRegistry()
for (const id of ALL_CHECKS) trustedTemplate.register({ id, version: VERSION, run: () => ({ passed: true, reason: 'reviewed v0.12 template' }) })
const binding = {
  packRegistryFingerprint: packRegistry.fingerprint(),
  verifierRegistryFingerprint: baseVerifierRegistry.fingerprint(),
  trustedCheckRegistryFingerprint: trustedTemplate.fingerprint(),
}

const { observations, summary } = await runVerificationBenchmark(cases, async benchmarkCase => {
  const scenario = scenarios.get(benchmarkCase.id)
  assert.ok(scenario)
  const trusted = new TrustedCheckRegistry()
  for (const id of ALL_CHECKS) trusted.register({
    id, version: VERSION,
    run: () => {
      const passed = scenario.checks[id] ?? true
      return { passed, reason: passed ? 'fixture passed' : `fixture failed: ${scenario.faultClass}` }
    },
  })
  assert.equal(trusted.fingerprint(), binding.trustedCheckRegistryFingerprint)
  const registry = new VerifierRegistry()
  for (const verifier of standardVerifiers()) registry.register(verifier)
  registry.register(createTrustedCheckVerifier(trusted))
  const engine = new OutcomeVerificationEngine(registry)
  const contract = scenario.pack === 'release'
    ? releaseAcceptancePack({ goalId: benchmarkCase.id, goalRevision: 1, objective: benchmarkCase.id })
    : codingAcceptancePack({ goalId: benchmarkCase.id, goalRevision: 1, objective: benchmarkCase.id })
  const started = performance.now()
  const report = await engine.verify(contract, {
    readRuntime: async key => Object.hasOwn(scenario.runtime, key) ? { value: scenario.runtime[key], version: `${benchmarkCase.id}:${key}:1` } : undefined,
  })
  return { report, verificationMs: performance.now() - started }
})

assert.equal(summary.validCases, 500)
assert.equal(summary.invalidCases, 1100)
assert.equal(summary.falseAccepts, 0)
assert.equal(summary.falseRejects, 0)
const taxonomy = summarizeFailureTaxonomy(observations)
assert.ok(taxonomy.length >= 10)
for (const row of taxonomy.filter(row => row.invalidCases > 0)) assert.equal(row.falseAcceptanceRate, 0, row.faultClass)
const uplift = summarizeVerifiedSuccessUplift(observations)
assert.equal(uplift.verifierAcceptedPrecision, 1)
assert.equal(uplift.validRetentionRate, 1)
assert.equal(uplift.falseAcceptsPrevented, 1100)

const policy = {
  from: 'observe', to: 'enforce',
  minimumCases: config.promotion.minimumCases,
  minimumValidCases: config.promotion.minimumValidCases,
  minimumInvalidCases: config.promotion.minimumInvalidCases,
  maximumFalseAcceptanceRate: config.benchmarkGate.maximumFalseAcceptanceRate,
  maximumFalseRejectionRate: config.benchmarkGate.maximumFalseRejectionRate,
  maximumFalseAcceptanceUpperBound95: config.benchmarkGate.maximumFalseAcceptanceUpperBound95,
  requirePerPackGates: config.promotion.requirePerPackGates,
}
const evaluatedAt = 1_778_000_000_000
const decision = evaluateVerificationPromotion(observations, policy, { policyBinding: binding, now: evaluatedAt })
assert.equal(decision.eligible, true, decision.reasons.join('; '))
assert.ok(decision.far.upper95 < 0.005)
const receipt = createVerificationPromotionReceipt(decision, policy)
assert.equal(verifyVerificationPromotionReceipt(receipt, policy, binding, { now: evaluatedAt }).valid, true)
assert.equal(resolveVerificationModeWithPromotionReceipt(config.targetMode, receipt, binding, policy, { now: evaluatedAt }).mode, 'enforce')
assert.equal(resolveVerificationModeWithPromotionReceipt(config.targetMode, receipt, { ...binding, verifierRegistryFingerprint: 'drift' }, policy).mode, 'observe')
const tampered = { ...receipt, benchmarkFingerprint: 'tampered' }
assert.equal(verifyVerificationPromotionReceipt(tampered, policy, binding).valid, false)

const artifact = {
  schemaVersion: 1,
  release: 'v0.12.0',
  policyBinding: binding,
  policy,
  summary,
  far: decision.far,
  frr: decision.frr,
  uplift,
  taxonomy,
  promotionReceipt: receipt,
}
const outputDir = new URL('../benchmarks/verification/', import.meta.url)
await mkdir(outputDir, { recursive: true })
await writeFile(new URL('v0.12-calibration.json', outputDir), `${JSON.stringify(artifact, null, 2)}\n`)
await writeFile(new URL('../config/acceptance/release-v3-promotion.json', import.meta.url), `${JSON.stringify(receipt, null, 2)}\n`)
console.log(`v0.12 verifier calibration: ${summary.cases}/${summary.cases}; valid=${summary.validCases}; invalid=${summary.invalidCases}; FAR=0; FAR95<=${decision.far.upper95.toFixed(5)}; FRR=0; accepted-precision ${uplift.baselineAcceptedPrecision.toFixed(4)}->${uplift.verifierAcceptedPrecision.toFixed(4)}; promotion receipt=VALID; ENFORCE; PASS`)
