import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import {
  AcceptancePackRegistry,
  OutcomeVerificationEngine,
  STANDARD_ACCEPTANCE_PACK_FACTORIES,
  TrustedCheckRegistry,
  VerifierRegistry,
  codingAcceptancePack,
  createTrustedCheckVerifier,
  createVerificationPromotionReceipt,
  dataPipelineAcceptancePack,
  deploymentAcceptancePack,
  evaluateVerificationPromotion,
  releaseAcceptancePack,
  researchAcceptancePack,
  resolveVerificationModeWithPromotionReceipt,
  runVerificationBenchmark,
  runtimeAcceptancePack,
  standardVerifiers,
  summarizeFailureTaxonomy,
  summarizeVerifiedSuccessUplift,
  verifyVerificationPromotionReceipt,
} from '../packages/outcome/outcome-verification/lib/index.js'

const config = JSON.parse(await readFile(new URL('../config/acceptance/release-v4.json', import.meta.url), 'utf8'))
const scenarios = new Map()
const add = (id, value) => scenarios.set(id, value)
const base = pack => ({ pack, checks: {}, runtime: { 'unresolved-side-effects': 0, 'recovery-status': 'clean', 'evidence-contradictions': 0, 'dataset.row-count': 1000, 'dataset.null-rate': 0.001, 'dataset.duplicate-rate': 0.001 }, external: { deployment: { id: 'dep-1', healthy: true } } })

const faults = {
  runtime: ['qualification-fail', 'consumer-fail', 'unresolved-side-effect', 'recovery-blocked', 'dual-fault'],
  coding: ['tests-fail', 'typecheck-fail', 'unresolved-side-effect', 'dual-check-fail'],
  research: ['claim-provenance-fail', 'contradiction-present', 'source-quality-fail', 'experiment-missing'],
  deployment: ['build-fail', 'deployment-missing', 'healthcheck-fail', 'smoke-test-fail', 'rollback-missing', 'unresolved-side-effect'],
  'data-pipeline': ['schema-invalid', 'referential-integrity-fail', 'row-count-low', 'null-rate-high', 'duplicate-rate-high', 'unresolved-side-effect'],
  release: ['trusted-check-fail', 'unresolved-side-effect', 'recovery-blocked', 'multi-fault'],
}

function validScenario(pack) {
  const s = base(pack)
  if (pack === 'runtime') Object.assign(s.checks, { 'qualification-pass': true, 'package-consumer-pass': true })
  if (pack === 'coding') Object.assign(s.checks, { 'tests-pass': true, 'typecheck-pass': true })
  if (pack === 'research') Object.assign(s.checks, { 'claim-provenance': true, 'source-quality': true, 'required-experiments': true })
  if (pack === 'deployment') Object.assign(s.checks, { 'build-pass': true, 'healthcheck-pass': true, 'smoke-test-pass': true, 'rollback-ready': true })
  if (pack === 'data-pipeline') Object.assign(s.checks, { 'schema-valid': true, 'referential-integrity': true })
  if (pack === 'release') Object.assign(s.checks, Object.fromEntries(config.releaseTrustedChecks.map(id => [id, true])))
  return s
}

function invalidScenario(pack, faultClass) {
  const s = validScenario(pack)
  if (faultClass === 'qualification-fail') s.checks['qualification-pass'] = false
  if (faultClass === 'consumer-fail') s.checks['package-consumer-pass'] = false
  if (faultClass === 'tests-fail') s.checks['tests-pass'] = false
  if (faultClass === 'typecheck-fail') s.checks['typecheck-pass'] = false
  if (faultClass === 'dual-check-fail') { s.checks['tests-pass'] = false; s.checks['typecheck-pass'] = false }
  if (faultClass === 'claim-provenance-fail') s.checks['claim-provenance'] = false
  if (faultClass === 'contradiction-present') s.runtime['evidence-contradictions'] = 1
  if (faultClass === 'source-quality-fail') s.checks['source-quality'] = false
  if (faultClass === 'experiment-missing') s.checks['required-experiments'] = false
  if (faultClass === 'build-fail') s.checks['build-pass'] = false
  if (faultClass === 'deployment-missing') delete s.external.deployment
  if (faultClass === 'healthcheck-fail') s.checks['healthcheck-pass'] = false
  if (faultClass === 'smoke-test-fail') s.checks['smoke-test-pass'] = false
  if (faultClass === 'rollback-missing') s.checks['rollback-ready'] = false
  if (faultClass === 'schema-invalid') s.checks['schema-valid'] = false
  if (faultClass === 'referential-integrity-fail') s.checks['referential-integrity'] = false
  if (faultClass === 'row-count-low') s.runtime['dataset.row-count'] = 10
  if (faultClass === 'null-rate-high') s.runtime['dataset.null-rate'] = 0.2
  if (faultClass === 'duplicate-rate-high') s.runtime['dataset.duplicate-rate'] = 0.2
  if (faultClass === 'unresolved-side-effect') s.runtime['unresolved-side-effects'] = 2
  if (faultClass === 'recovery-blocked') s.runtime['recovery-status'] = { canAutoResume: false, blocked: true }
  if (faultClass === 'trusted-check-fail') s.checks[config.releaseTrustedChecks[0]] = false
  if (faultClass === 'dual-fault') { s.checks['qualification-pass'] = false; s.runtime['unresolved-side-effects'] = 1 }
  if (faultClass === 'multi-fault') { s.checks['failure-injection-tests'] = false; s.checks['archive-manifest-valid'] = false; s.runtime['unresolved-side-effects'] = 1 }
  return s
}

const packs = ['runtime', 'coding', 'research', 'deployment', 'data-pipeline', 'release']
for (const pack of packs) {
  for (let i = 0; i < 100; i += 1) add(`${pack}-valid-${i}`, { ...validScenario(pack), valid: true, faultClass: 'valid-control' })
  const classes = faults[pack]
  for (let i = 0; i < 250; i += 1) {
    const faultClass = classes[i % classes.length]
    add(`${pack}-invalid-${i}`, {
      ...invalidScenario(pack, faultClass), valid: false, faultClass,
      ...(i < 150 ? { mutationOperator: `${pack}:${faultClass}`, mutationOf: `${pack}-valid-${i % 100}` } : {}),
    })
  }
}

const cases = [...scenarios.entries()].map(([id, value]) => ({
  id, pack: value.pack, groundTruth: value.valid ? 'valid' : 'invalid', faultClass: value.faultClass,
  ...(value.mutationOperator ? { mutationOperator: value.mutationOperator, mutationOf: value.mutationOf } : {}),
}))
assert.equal(cases.length, 2100)

const packRegistry = new AcceptancePackRegistry()
for (const factory of STANDARD_ACCEPTANCE_PACK_FACTORIES) packRegistry.register(factory)
const baseVerifiers = new VerifierRegistry()
for (const verifier of standardVerifiers()) baseVerifiers.register(verifier)
const templateChecks = new TrustedCheckRegistry()
for (const id of config.trustedChecks) templateChecks.register({ id, version: config.trustedCheckVersion, run: () => ({ passed: true, reason: 'v0.13 calibration template' }) })
const binding = {
  packRegistryFingerprint: packRegistry.fingerprint(),
  verifierRegistryFingerprint: baseVerifiers.fingerprint(),
  trustedCheckRegistryFingerprint: templateChecks.fingerprint(),
}

function contractFor(benchmarkCase) {
  const input = { goalId: benchmarkCase.id, goalRevision: 1, objective: benchmarkCase.id }
  if (benchmarkCase.pack === 'runtime') return runtimeAcceptancePack(input)
  if (benchmarkCase.pack === 'coding') return codingAcceptancePack(input)
  if (benchmarkCase.pack === 'research') return researchAcceptancePack(input)
  if (benchmarkCase.pack === 'deployment') return deploymentAcceptancePack(input)
  if (benchmarkCase.pack === 'data-pipeline') return dataPipelineAcceptancePack(input, { minimumRows: 100, maximumNullRate: 0.01, maximumDuplicateRate: 0.01 })
  if (benchmarkCase.pack === 'release') return releaseAcceptancePack(input)
  throw new Error(`unknown pack ${benchmarkCase.pack}`)
}

const { observations, summary } = await runVerificationBenchmark(cases, async benchmarkCase => {
  const scenario = scenarios.get(benchmarkCase.id)
  assert.ok(scenario)
  const checks = new TrustedCheckRegistry()
  for (const id of config.trustedChecks) checks.register({ id, version: config.trustedCheckVersion, run: () => {
    const passed = scenario.checks[id] ?? true
    return { passed, reason: passed ? 'fixture passed' : `fixture failed: ${scenario.faultClass}` }
  } })
  assert.equal(checks.fingerprint(), binding.trustedCheckRegistryFingerprint)
  const registry = new VerifierRegistry()
  for (const verifier of standardVerifiers()) registry.register(verifier)
  registry.register(createTrustedCheckVerifier(checks))
  const engine = new OutcomeVerificationEngine(registry)
  const started = performance.now()
  const report = await engine.verify(contractFor(benchmarkCase), {
    readRuntime: async key => Object.hasOwn(scenario.runtime, key) ? { value: scenario.runtime[key], version: `${benchmarkCase.id}:runtime:${key}:1` } : undefined,
    readExternal: async key => Object.hasOwn(scenario.external, key) ? { value: scenario.external[key], version: `${benchmarkCase.id}:external:${key}:1` } : undefined,
  })
  return { report, verificationMs: performance.now() - started }
})

assert.equal(summary.validCases, 600)
assert.equal(summary.invalidCases, 1500)
assert.equal(summary.falseAccepts, 0)
assert.equal(summary.falseRejects, 0)
const taxonomy = summarizeFailureTaxonomy(observations)
const uplift = summarizeVerifiedSuccessUplift(observations)
assert.equal(uplift.verifierAcceptedPrecision, 1)
assert.equal(uplift.validRetentionRate, 1)
assert.equal(uplift.falseAcceptsPrevented, 1500)

const policy = {
  from: 'observe', to: 'enforce',
  minimumCases: config.promotion.minimumCases,
  minimumValidCases: config.promotion.minimumValidCases,
  minimumInvalidCases: config.promotion.minimumInvalidCases,
  maximumFalseAcceptanceRate: config.benchmarkGate.maximumFalseAcceptanceRate,
  maximumFalseRejectionRate: config.benchmarkGate.maximumFalseRejectionRate,
  maximumFalseAcceptanceUpperBound95: config.benchmarkGate.maximumFalseAcceptanceUpperBound95,
  requirePerPackGates: config.promotion.requirePerPackGates,
  requiredPacks: config.requiredPacks,
}
const evaluatedAt = 1_778_100_000_000
const decision = evaluateVerificationPromotion(observations, policy, { policyBinding: binding, now: evaluatedAt })
assert.equal(decision.eligible, true, decision.reasons.join('; '))
assert.ok(decision.far.upper95 < 0.003)
for (const pack of packs) {
  const calibration = decision.packCalibrations[pack]
  assert.ok(calibration, `${pack} calibration missing`)
  assert.equal(calibration.summary.validCases, 100)
  assert.equal(calibration.summary.invalidCases, 250)
  assert.equal(calibration.summary.falseAccepts, 0)
  assert.equal(calibration.summary.falseRejects, 0)
  assert.equal(calibration.mutation.cases, 150)
  assert.equal(calibration.mutation.killRate, 1)
  assert.ok(calibration.far.upper95 < 0.016)
}

const receipt = createVerificationPromotionReceipt(decision, policy)
assert.equal(receipt.receiptVersion, 2)
assert.equal(typeof receipt.packCalibrationHash, 'string')
assert.equal(verifyVerificationPromotionReceipt(receipt, policy, binding, { now: evaluatedAt }).valid, true)
assert.equal(resolveVerificationModeWithPromotionReceipt(config.targetMode, receipt, binding, policy, { now: evaluatedAt }).mode, 'enforce')
const drift = { ...binding, trustedCheckRegistryFingerprint: 'drift' }
assert.equal(resolveVerificationModeWithPromotionReceipt(config.targetMode, receipt, drift, policy).mode, 'observe')

const artifact = {
  schemaVersion: 2,
  release: 'v0.13.0',
  policyBinding: binding,
  policy,
  summary,
  far: decision.far,
  frr: decision.frr,
  packCalibrations: decision.packCalibrations,
  uplift,
  taxonomy,
  promotionReceipt: receipt,
}
await mkdir(new URL('../benchmarks/verification/', import.meta.url), { recursive: true })
await writeFile(new URL('../benchmarks/verification/v0.13-calibration.json', import.meta.url), `${JSON.stringify(artifact, null, 2)}\n`)
await writeFile(new URL('../config/acceptance/release-v4-promotion.json', import.meta.url), `${JSON.stringify(receipt, null, 2)}\n`)
console.log(`v0.13 pack calibration: ${summary.cases}/${summary.cases}; packs=6; valid=${summary.validCases}; invalid=${summary.invalidCases}; FAR=0; FAR95<=${decision.far.upper95.toFixed(5)}; FRR=0; per-pack mutation kill=1.000; receipt=v2 VALID; ENFORCE; PASS`)
