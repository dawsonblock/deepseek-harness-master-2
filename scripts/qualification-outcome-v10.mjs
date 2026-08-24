import assert from 'node:assert/strict'
import {
  OutcomeVerificationEngine,
  TrustedCheckRegistry,
  VerifierRegistry,
  assertVerificationBenchmarkGate,
  codingAcceptancePack,
  createTrustedCheckVerifier,
  decideVerification,
  releaseAcceptancePack,
  runVerificationBenchmark,
  standardVerifiers,
} from '../packages/outcome/outcome-verification/lib/index.js'

const scenarios = new Map([
  ['coding-good', { pack: 'coding', checks: { 'tests-pass': true, 'typecheck-pass': true }, runtime: { 'unresolved-side-effects': 0 }, valid: true }],
  ['coding-good-recovered', { pack: 'coding', checks: { 'tests-pass': true, 'typecheck-pass': true }, runtime: { 'unresolved-side-effects': 0, 'recovery-status': { canAutoResume: true } }, valid: true }],
  ['coding-bad-tests', { pack: 'coding', checks: { 'tests-pass': false, 'typecheck-pass': true }, runtime: { 'unresolved-side-effects': 0 }, valid: false }],
  ['coding-bad-typecheck', { pack: 'coding', checks: { 'tests-pass': true, 'typecheck-pass': false }, runtime: { 'unresolved-side-effects': 0 }, valid: false }],
  ['coding-bad-side-effect', { pack: 'coding', checks: { 'tests-pass': true, 'typecheck-pass': true }, runtime: { 'unresolved-side-effects': 1 }, valid: false }],
  ['release-good', { pack: 'release', checks: { 'outcome-engine-tests': true, 'agent-hardening-tests': true, 'python-reference-tests': true, 'failure-injection-tests': true, 'process-kill-tests': true, 'packed-consumer-pass': true, 'source-guards-pass': true, 'archive-manifest-valid': true }, runtime: { 'unresolved-side-effects': 0, 'recovery-status': 'clean' }, valid: true }],
  ['release-good-auto-resume', { pack: 'release', checks: { 'outcome-engine-tests': true, 'agent-hardening-tests': true, 'python-reference-tests': true, 'failure-injection-tests': true, 'process-kill-tests': true, 'packed-consumer-pass': true, 'source-guards-pass': true, 'archive-manifest-valid': true }, runtime: { 'unresolved-side-effects': 0, 'recovery-status': { canAutoResume: true, blocked: false } }, valid: true }],
  ['release-bad-manifest', { pack: 'release', checks: { 'outcome-engine-tests': true, 'agent-hardening-tests': true, 'python-reference-tests': true, 'failure-injection-tests': true, 'process-kill-tests': true, 'packed-consumer-pass': true, 'source-guards-pass': true, 'archive-manifest-valid': false }, runtime: { 'unresolved-side-effects': 0, 'recovery-status': 'clean' }, valid: false }],
  ['release-bad-chaos', { pack: 'release', checks: { 'outcome-engine-tests': true, 'agent-hardening-tests': true, 'python-reference-tests': true, 'failure-injection-tests': false, 'process-kill-tests': true, 'packed-consumer-pass': true, 'source-guards-pass': true, 'archive-manifest-valid': true }, runtime: { 'unresolved-side-effects': 0, 'recovery-status': 'clean' }, valid: false }],
  ['release-bad-recovery', { pack: 'release', checks: { 'outcome-engine-tests': true, 'agent-hardening-tests': true, 'python-reference-tests': true, 'failure-injection-tests': true, 'process-kill-tests': true, 'packed-consumer-pass': true, 'source-guards-pass': true, 'archive-manifest-valid': true }, runtime: { 'unresolved-side-effects': 0, 'recovery-status': { canAutoResume: false, blocked: true } }, valid: false }],
  ['release-bad-side-effect', { pack: 'release', checks: { 'outcome-engine-tests': true, 'agent-hardening-tests': true, 'python-reference-tests': true, 'failure-injection-tests': true, 'process-kill-tests': true, 'packed-consumer-pass': true, 'source-guards-pass': true, 'archive-manifest-valid': true }, runtime: { 'unresolved-side-effects': 2, 'recovery-status': 'clean' }, valid: false }],
  ['release-bad-consumer', { pack: 'release', checks: { 'outcome-engine-tests': true, 'agent-hardening-tests': true, 'python-reference-tests': true, 'failure-injection-tests': true, 'process-kill-tests': true, 'packed-consumer-pass': false, 'source-guards-pass': true, 'archive-manifest-valid': true }, runtime: { 'unresolved-side-effects': 0, 'recovery-status': 'clean' }, valid: false }],
])

const cases = [...scenarios.entries()].map(([id, scenario]) => ({ id, pack: scenario.pack, groundTruth: scenario.valid ? 'valid' : 'invalid' }))

const { observations, summary } = await runVerificationBenchmark(cases, async benchmarkCase => {
  const scenario = scenarios.get(benchmarkCase.id)
  assert.ok(scenario)
  const trusted = new TrustedCheckRegistry()
  for (const [id, passed] of Object.entries(scenario.checks)) trusted.register({ id, version: 'fixture-1', run: () => ({ passed, reason: passed ? 'fixture passed' : 'fixture failed' }) })
  const registry = new VerifierRegistry()
  for (const verifier of standardVerifiers()) registry.register(verifier)
  registry.register(createTrustedCheckVerifier(trusted))
  const engine = new OutcomeVerificationEngine(registry)
  const contract = scenario.pack === 'release'
    ? releaseAcceptancePack({ goalId: benchmarkCase.id, goalRevision: 1, objective: benchmarkCase.id })
    : codingAcceptancePack({ goalId: benchmarkCase.id, goalRevision: 1, objective: benchmarkCase.id })
  const start = performance.now()
  const report = await engine.verify(contract, {
    readRuntime: async key => Object.hasOwn(scenario.runtime, key) ? { value: scenario.runtime[key], version: `${key}:1` } : undefined,
  })
  return { report, verificationMs: performance.now() - start }
})

assertVerificationBenchmarkGate(summary, { maximumFalseAcceptanceRate: 0, maximumFalseRejectionRate: 0 })
assert.equal(summary.falseAcceptanceRate, 0)
assert.equal(summary.falseRejectionRate, 0)
assert.equal(summary.cases, 12)

// Observe mode must surface a rejection while leaving legacy completion unblocked.
const rejected = observations.find(row => row.caseId === 'coding-bad-tests')
assert.ok(rejected && rejected.accepted === false)
const fakeReport = { passed: false }
const observation = decideVerification(fakeReport, 'observe')
assert.equal(observation.accepted, true)
assert.equal(observation.wouldAccept, false)

console.log(`v0.10 verifier benchmark: ${summary.cases}/${summary.cases} labeled cases; FAR=0; FRR=0; PASS`)
