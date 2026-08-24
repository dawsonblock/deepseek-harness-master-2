import assert from 'node:assert/strict'
import {
  AcceptancePackRegistry,
  OutcomeVerificationEngine,
  STANDARD_ACCEPTANCE_PACK_FACTORIES,
  TrustedCheckRegistry,
  VerifierRegistry,
  createTrustedCheckVerifier,
  evaluateVerificationPromotion,
  releaseAcceptancePack,
  runVerificationBenchmark,
  codingAcceptancePack,
  resolvePromotedVerificationMode,
  standardVerifiers,
  summarizeVerificationByPack,
} from '../packages/outcome/outcome-verification/lib/index.js'

const ALL_CHECKS = [
  'tests-pass', 'typecheck-pass',
  'outcome-engine-tests', 'agent-hardening-tests', 'python-reference-tests',
  'failure-injection-tests', 'process-kill-tests', 'packed-consumer-pass',
  'source-guards-pass', 'archive-manifest-valid',
]

const scenarios = new Map()
const add = (id, scenario) => scenarios.set(id, scenario)

// 25 valid + 50 invalid coding outcomes.
for (let i = 0; i < 25; i += 1) add(`coding-valid-${i}`, {
  pack: 'coding', valid: true,
  checks: { 'tests-pass': true, 'typecheck-pass': true },
  runtime: { 'unresolved-side-effects': 0 },
})
for (let i = 0; i < 50; i += 1) {
  const failure = i % 3
  add(`coding-invalid-${i}`, {
    pack: 'coding', valid: false,
    checks: { 'tests-pass': failure !== 0, 'typecheck-pass': failure !== 1 },
    runtime: { 'unresolved-side-effects': failure === 2 ? 1 : 0 },
  })
}

// 25 valid + 50 invalid release outcomes.
const releaseChecks = ['outcome-engine-tests','agent-hardening-tests','python-reference-tests','failure-injection-tests','process-kill-tests','packed-consumer-pass','source-guards-pass','archive-manifest-valid']
for (let i = 0; i < 25; i += 1) add(`release-valid-${i}`, {
  pack: 'release', valid: true,
  checks: Object.fromEntries(releaseChecks.map(id => [id, true])),
  runtime: { 'unresolved-side-effects': 0, 'recovery-status': i % 2 === 0 ? 'clean' : { canAutoResume: true, blocked: false } },
})
for (let i = 0; i < 50; i += 1) {
  const checks = Object.fromEntries(releaseChecks.map(id => [id, true]))
  const failure = i % (releaseChecks.length + 2)
  const runtime = { 'unresolved-side-effects': 0, 'recovery-status': 'clean' }
  if (failure < releaseChecks.length) checks[releaseChecks[failure]] = false
  else if (failure === releaseChecks.length) runtime['unresolved-side-effects'] = 1
  else runtime['recovery-status'] = { canAutoResume: false, blocked: true }
  add(`release-invalid-${i}`, { pack: 'release', valid: false, checks, runtime })
}

const cases = [...scenarios.entries()].map(([id, value]) => ({ id, pack: value.pack, groundTruth: value.valid ? 'valid' : 'invalid' }))
assert.equal(cases.length, 150)

const packRegistry = new AcceptancePackRegistry()
for (const factory of STANDARD_ACCEPTANCE_PACK_FACTORIES) packRegistry.register(factory)
const verifierRegistry = new VerifierRegistry()
for (const verifier of standardVerifiers()) verifierRegistry.register(verifier)
const trustedTemplate = new TrustedCheckRegistry()
for (const id of ALL_CHECKS) trustedTemplate.register({ id, version: 'qualification-v11', run: () => ({ passed: true, reason: 'template' }) })
const binding = {
  packRegistryFingerprint: packRegistry.fingerprint(),
  verifierRegistryFingerprint: verifierRegistry.fingerprint(),
  trustedCheckRegistryFingerprint: trustedTemplate.fingerprint(),
}

const { observations, summary } = await runVerificationBenchmark(cases, async benchmarkCase => {
  const scenario = scenarios.get(benchmarkCase.id)
  assert.ok(scenario)
  const trusted = new TrustedCheckRegistry()
  for (const id of ALL_CHECKS) trusted.register({
    id,
    version: 'qualification-v11',
    run: () => {
      const passed = scenario.checks[id] ?? true
      return { passed, reason: passed ? 'fixture passed' : 'fixture failed' }
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

assert.equal(summary.cases, 150)
assert.equal(summary.validCases, 50)
assert.equal(summary.invalidCases, 100)
assert.equal(summary.falseAccepts, 0)
assert.equal(summary.falseRejects, 0)

const decision = evaluateVerificationPromotion(observations, {
  from: 'observe', to: 'enforce',
  minimumCases: 150, minimumValidCases: 50, minimumInvalidCases: 100,
  maximumFalseAcceptanceRate: 0,
  maximumFalseRejectionRate: 0.05,
  maximumFalseAcceptanceUpperBound95: 0.04,
  requirePerPackGates: true,
}, { policyBinding: binding, now: 1_777_000_000_000 })
assert.equal(decision.eligible, true, decision.reasons.join('; '))
assert.ok(decision.far.upper95 < 0.04)
assert.equal(resolvePromotedVerificationMode('observe', decision, binding).mode, 'enforce')
assert.equal(resolvePromotedVerificationMode('observe', decision, { ...binding, verifierRegistryFingerprint: 'changed' }).mode, 'observe')

const byPack = summarizeVerificationByPack(observations)
assert.equal(byPack.coding.falseAcceptanceRate, 0)
assert.equal(byPack.release.falseAcceptanceRate, 0)
assert.equal(byPack.coding.falseRejectionRate, 0)
assert.equal(byPack.release.falseRejectionRate, 0)

console.log(`v0.11 verifier calibration: ${summary.cases}/${summary.cases}; valid=${summary.validCases}; invalid=${summary.invalidCases}; FAR=${summary.falseAcceptanceRate}; FAR95<=${decision.far.upper95.toFixed(4)}; FRR=${summary.falseRejectionRate}; promotion=ENFORCE; PASS`)
