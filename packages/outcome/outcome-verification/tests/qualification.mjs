import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EvidenceGraph,
  EvidenceStore,
  OutcomeStateMachine,
  OutcomeTelemetry,
  OutcomeVerificationEngine,
  VerifierRegistry,
  acceptanceContractHash,
  canWorkerMutateCriterion,
  compileContractDraft,
  createAcceptanceContract,
  createGoalOutcomeVerifier,
  codingAcceptancePack,
  sha256Hex,
  stableStringify,
  standardVerifiers,
  valueEqualsVerifier,
  AcceptancePackRegistry,
  STANDARD_ACCEPTANCE_PACK_FACTORIES,
  evaluateVerificationPromotion,
  assertVerificationPromotion,
  wilson95,
  resolvePromotedVerificationMode,
  createVerificationPromotionReceipt,
  verifyVerificationPromotionReceipt,
} from '../lib/index.js'

function registry() {
  const r = new VerifierRegistry()
  for (const verifier of standardVerifiers()) r.register(verifier)
  return r
}
function env(values = {}, artifacts = {}) {
  return {
    now: () => 1000,
    readRuntime: async key => Object.hasOwn(values, key) ? { value: values[key], version: `runtime:${key}:1` } : undefined,
    readArtifact: async key => Object.hasOwn(artifacts, key) ? { value: artifacts[key], version: `artifact:${key}:1` } : undefined,
  }
}

test('sha256 implementation matches known vector', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('canonical JSON is stable across object insertion order', () => {
  assert.equal(stableStringify({ b: 2, a: 1 }), stableStringify({ a: 1, b: 2 }))
})

test('contract rejects dependency cycles', () => {
  assert.throws(() => createAcceptanceContract({
    goalId: 'g', goalRevision: 1, objective: 'x',
    criteria: [
      { id: 'a', description: 'a', severity: 'required', verificationMode: 'deterministic', verifier: 'value.equals', dependsOn: ['b'] },
      { id: 'b', description: 'b', severity: 'required', verificationMode: 'deterministic', verifier: 'value.equals', dependsOn: ['a'] },
    ],
  }), /cycle/)
})

test('registry fingerprint changes when verifier policy changes', () => {
  const a = new VerifierRegistry(); a.register({ ...valueEqualsVerifier })
  const b = new VerifierRegistry(); b.register({ ...valueEqualsVerifier, version: '2' })
  assert.notEqual(a.fingerprint(), b.fingerprint())
})

test('required deterministic criteria pass and produce receipt', async () => {
  const engine = new OutcomeVerificationEngine(registry())
  const contract = createAcceptanceContract({
    goalId: 'g', goalRevision: 1, objective: 'ship',
    criteria: [
      { id: 'tests', description: 'tests', severity: 'required', verificationMode: 'deterministic', verifier: 'value.equals', args: { channel: 'runtime', key: 'tests', expected: true } },
      { id: 'clean', description: 'clean', severity: 'required', verificationMode: 'runtime', verifier: 'runtime.no-unresolved-side-effects' },
    ],
    evidencePolicy: { requireDeterministicForRequired: true },
  })
  const report = await engine.verify(contract, env({ tests: true, 'unresolved-side-effects': 0 }))
  assert.equal(report.passed, true)
  const receipt = engine.createReceipt(report, [{ key: 'release.zip', sha256: 'abc' }])
  assert.equal(engine.verifyReceipt(receipt), true)
  assert.equal(engine.verifyReceipt(receipt, [{ key: 'release.zip', sha256: 'abc' }]), true)
  assert.equal(engine.verifyReceipt(receipt, [{ key: 'release.zip', sha256: 'changed' }]), false)
})

test('failing required criterion rejects outcome receipt', async () => {
  const engine = new OutcomeVerificationEngine(registry())
  const contract = compileContractDraft({ goalId: 'g', goalRevision: 1, objective: 'code', pack: 'coding' })
  const report = await engine.verify(contract, env({ 'tests-pass': false, 'typecheck-pass': true, 'unresolved-side-effects': 0 }))
  assert.equal(report.passed, false)
  assert.throws(() => engine.createReceipt(report), /failing verification report/)
  assert.equal(engine.repairPlan(report).items.some(item => item.criterionId === 'tests-pass'), true)
})

test('dependency failure blocks dependent criterion', async () => {
  const r = registry()
  const engine = new OutcomeVerificationEngine(r)
  const contract = createAcceptanceContract({ goalId: 'g', goalRevision: 1, objective: 'x', criteria: [
    { id: 'first', description: 'first', severity: 'required', verificationMode: 'deterministic', verifier: 'value.equals', args: { channel: 'runtime', key: 'first', expected: true } },
    { id: 'second', description: 'second', severity: 'required', verificationMode: 'deterministic', verifier: 'value.equals', args: { channel: 'runtime', key: 'second', expected: true }, dependsOn: ['first'] },
  ]})
  const report = await engine.verify(contract, env({ first: false, second: true }))
  assert.equal(report.criteria.find(row => row.criterion.id === 'second').state, 'blocked')
})

test('evidence dependency invalidation makes passing criterion stale', async () => {
  const store = new EvidenceStore()
  const engine = new OutcomeVerificationEngine(registry(), store)
  const contract = createAcceptanceContract({ goalId: 'g', goalRevision: 1, objective: 'x', criteria: [
    { id: 'tests', description: 'tests', severity: 'required', verificationMode: 'deterministic', verifier: 'value.equals', args: { channel: 'runtime', key: 'tests', expected: true } },
  ]})
  const report = await engine.verify(contract, env({ tests: true }))
  assert.equal(report.passed, true)
  store.invalidate({ kind: 'runtime', key: 'tests', version: 'runtime:tests:2' }, 'code changed', 1001)
  assert.equal(engine.status(contract)[0].state, 'stale')
})

test('integrity verifier failure blocks completion regardless advisory severity', async () => {
  const engine = new OutcomeVerificationEngine(registry())
  const contract = createAcceptanceContract({ goalId: 'g', goalRevision: 1, objective: 'x', criteria: [
    { id: 'accept', description: 'accept', severity: 'required', verificationMode: 'deterministic', verifier: 'value.equals', args: { channel: 'runtime', key: 'ok', expected: true } },
    { id: 'integrity', description: 'integrity', severity: 'advisory', verificationMode: 'runtime', verifier: 'runtime.no-unresolved-side-effects' },
  ]})
  const report = await engine.verify(contract, env({ ok: true, 'unresolved-side-effects': 1 }))
  assert.equal(report.passed, false)
})

test('required criterion can fail closed when verifier is not deterministic', async () => {
  const r = registry()
  r.register({ id: 'model.judge', version: '1', category: 'acceptance', deterministic: false, verify: () => ({ passed: true, reason: 'looks good', source: 'model' }) })
  const engine = new OutcomeVerificationEngine(r)
  const contract = createAcceptanceContract({ goalId: 'g', goalRevision: 1, objective: 'x', criteria: [
    { id: 'judge', description: 'judge', severity: 'required', verificationMode: 'model', verifier: 'model.judge' },
  ], evidencePolicy: { requireDeterministicForRequired: true } })
  const report = await engine.verify(contract)
  assert.equal(report.passed, false)
})

test('minimum evidence requirement needs repeated independent runs', async () => {
  const engine = new OutcomeVerificationEngine(registry())
  const contract = createAcceptanceContract({ goalId: 'g', goalRevision: 1, objective: 'x', criteria: [
    { id: 'twice', description: 'twice', severity: 'required', verificationMode: 'deterministic', verifier: 'value.equals', args: { channel: 'runtime', key: 'x', expected: 1 } },
  ], evidencePolicy: { minimumEvidencePerRequiredCriterion: 2 } })
  const first = await engine.verify(contract, env({ x: 1 }))
  assert.equal(first.passed, false)
  const second = await engine.verify(contract, env({ x: 1 }))
  assert.equal(second.passed, true)
})

test('benchmark no-regression verifier enforces tolerance', async () => {
  const engine = new OutcomeVerificationEngine(registry())
  const contract = createAcceptanceContract({ goalId: 'g', goalRevision: 1, objective: 'perf', criteria: [
    { id: 'latency', description: 'latency', severity: 'required', verificationMode: 'benchmark', verifier: 'benchmark.no-regression', args: { key: 'p95', baseline: 100, tolerance: 0.05, direction: 'lower-is-better' } },
  ]})
  assert.equal((await engine.verify(contract, env({ p95: 104 }))).passed, true)
  assert.equal((await engine.verify(contract, env({ p95: 106 }))).passed, false)
})

test('artifact verifier hashes exact current content', async () => {
  const expected = sha256Hex('hello')
  const engine = new OutcomeVerificationEngine(registry())
  const contract = createAcceptanceContract({ goalId: 'g', goalRevision: 1, objective: 'artifact', criteria: [
    { id: 'artifact', description: 'artifact', severity: 'required', verificationMode: 'artifact', verifier: 'artifact.sha256', args: { key: 'report', sha256: expected } },
  ]})
  assert.equal((await engine.verify(contract, env({}, { report: 'hello' }))).passed, true)
})

test('goal adapter fails closed on goal revision mismatch', async () => {
  const engine = new OutcomeVerificationEngine(registry())
  const contract = createAcceptanceContract({ goalId: 'g', goalRevision: 2, objective: 'x', criteria: [
    { id: 'ok', description: 'ok', severity: 'required', verificationMode: 'deterministic', verifier: 'value.equals', args: { channel: 'runtime', key: 'ok', expected: true } },
  ]})
  const verifier = createGoalOutcomeVerifier({ contract, engine, environment: () => env({ ok: true }) })
  const result = await verifier.verify({ goal: { id: 'g', revision: 1 } })
  assert.equal(result.passed, false)
})

test('goal adapter returns outcome receipt evidence on pass', async () => {
  const engine = new OutcomeVerificationEngine(registry())
  const contract = createAcceptanceContract({ goalId: 'g', goalRevision: 1, objective: 'x', criteria: [
    { id: 'ok', description: 'ok', severity: 'required', verificationMode: 'deterministic', verifier: 'value.equals', args: { channel: 'runtime', key: 'ok', expected: true } },
  ]})
  let receipt
  const verifier = createGoalOutcomeVerifier({ contract, engine, environment: () => env({ ok: true }), onReceipt: value => { receipt = value } })
  const result = await verifier.verify({ goal: { id: 'g', revision: 1 } })
  assert.equal(result.passed, true)
  assert.match(result.evidence[0], /^outcome-receipt:/)
  assert.equal(engine.verifyReceipt(receipt), true)
})

test('receipt tampering is detected', async () => {
  const engine = new OutcomeVerificationEngine(registry())
  const contract = createAcceptanceContract({ goalId: 'g', goalRevision: 1, objective: 'x', criteria: [
    { id: 'ok', description: 'ok', severity: 'required', verificationMode: 'deterministic', verifier: 'value.equals', args: { channel: 'runtime', key: 'ok', expected: true } },
  ]})
  const report = await engine.verify(contract, env({ ok: true }))
  const receipt = engine.createReceipt(report)
  assert.equal(engine.verifyReceipt({ ...receipt, goalRevision: 99 }), false)
})

test('receipt lineage is hash-bound', async () => {
  const engine = new OutcomeVerificationEngine(registry())
  const contract = createAcceptanceContract({ goalId: 'g', goalRevision: 1, objective: 'x', criteria: [
    { id: 'ok', description: 'ok', severity: 'required', verificationMode: 'deterministic', verifier: 'value.equals', args: { channel: 'runtime', key: 'ok', expected: true } },
  ]})
  const report = await engine.verify(contract, env({ ok: true }))
  const first = engine.createReceipt(report)
  const second = engine.createReceipt(report, [], [], first.receiptHash)
  assert.equal(second.supersedesReceipt, first.receiptHash)
  assert.notEqual(second.receiptHash, first.receiptHash)
})

test('evidence graph records contradictions explicitly', () => {
  const graph = new EvidenceGraph()
  graph.add({ from: 'e1', to: 'claim', relation: 'supports' })
  graph.add({ from: 'e2', to: 'claim', relation: 'contradicts' })
  assert.equal(graph.hasContradiction('claim'), true)
  assert.equal(graph.contradictions('claim').length, 1)
})

test('outcome state machine will not commit without matching verified receipt', async () => {
  const engine = new OutcomeVerificationEngine(registry())
  const contract = createAcceptanceContract({ goalId: 'g', goalRevision: 1, objective: 'x', criteria: [
    { id: 'ok', description: 'ok', severity: 'required', verificationMode: 'deterministic', verifier: 'value.equals', args: { channel: 'runtime', key: 'ok', expected: true } },
  ]})
  const receipt = engine.createReceipt(await engine.verify(contract, env({ ok: true })))
  const machine = new OutcomeStateMachine()
  machine.candidate(); machine.beginVerification(); machine.verified(receipt)
  assert.throws(() => machine.commit('wrong'), /receipt hash/)
  assert.equal(machine.commit(receipt.receiptHash).phase, 'committed-complete')
})

test('contract compiler protects non-worker criteria from worker mutation', () => {
  const contract = compileContractDraft({ goalId: 'g', goalRevision: 1, objective: 'x', pack: 'custom', criteria: [
    { id: 'human-check', description: 'human', severity: 'required', verificationMode: 'deterministic', verifier: 'value.equals', authority: 'human', args: { channel: 'runtime', key: 'x', expected: true } },
    { id: 'worker-check', description: 'worker', severity: 'advisory', verificationMode: 'deterministic', verifier: 'value.equals', authority: 'worker', args: { channel: 'runtime', key: 'y', expected: true } },
  ]})
  assert.equal(canWorkerMutateCriterion(contract.criteria[0]), false)
  assert.equal(canWorkerMutateCriterion(contract.criteria[1]), true)
})

test('outcome telemetry counts rejected completion candidates', async () => {
  const engine = new OutcomeVerificationEngine(registry())
  const telemetry = new OutcomeTelemetry()
  const contract = createAcceptanceContract({ goalId: 'g', goalRevision: 1, objective: 'x', criteria: [
    { id: 'ok', description: 'ok', severity: 'required', verificationMode: 'deterministic', verifier: 'value.equals', args: { channel: 'runtime', key: 'ok', expected: true } },
  ]})
  const failed = await engine.verify(contract, env({ ok: false }))
  telemetry.record(failed, 1)
  const passed = await engine.verify(contract, env({ ok: true }))
  telemetry.record(passed, 1)
  const snapshot = telemetry.snapshot()
  assert.equal(snapshot.verificationRuns, 2)
  assert.equal(snapshot.completionRejections, 1)
})

test('acceptance contract hash is stable', () => {
  const a = createAcceptanceContract({ goalId: 'g', goalRevision: 1, objective: 'x', criteria: [{ id: 'ok', description: 'ok', severity: 'required', verificationMode: 'deterministic', verifier: 'value.equals', args: { channel: 'runtime', key: 'x', expected: true } }] })
  const b = createAcceptanceContract({ objective: 'x', goalRevision: 1, goalId: 'g', criteria: [{ verifier: 'value.equals', id: 'ok', description: 'ok', verificationMode: 'deterministic', severity: 'required', args: { expected: true, key: 'x', channel: 'runtime' } }] })
  assert.equal(acceptanceContractHash(a), acceptanceContractHash(b))
})

test('verifyStale reuses fresh evidence and reruns only invalidated criteria', async () => {
  const r = new VerifierRegistry()
  let aRuns = 0
  let bRuns = 0
  r.register({ id: 'check.a', version: '1', category: 'acceptance', deterministic: true, verify: () => { aRuns += 1; return { passed: true, reason: 'a', dependencies: [{ kind: 'runtime', key: 'a', version: '1' }] } } })
  r.register({ id: 'check.b', version: '1', category: 'acceptance', deterministic: true, verify: () => { bRuns += 1; return { passed: true, reason: 'b', dependencies: [{ kind: 'runtime', key: 'b', version: '1' }] } } })
  const store = new EvidenceStore()
  const engine = new OutcomeVerificationEngine(r, store)
  const contract = createAcceptanceContract({ goalId: 'g', goalRevision: 1, objective: 'incremental', criteria: [
    { id: 'a', description: 'a', severity: 'required', verificationMode: 'deterministic', verifier: 'check.a' },
    { id: 'b', description: 'b', severity: 'required', verificationMode: 'deterministic', verifier: 'check.b' },
  ]})
  assert.equal((await engine.verify(contract, { now: () => 1000 })).passed, true)
  store.invalidate({ kind: 'runtime', key: 'b', version: '2' }, 'b changed', 1001)
  assert.equal((await engine.verifyStale(contract, { now: () => 1002 })).passed, true)
  assert.equal(aRuns, 1)
  assert.equal(bRuns, 2)
})

test('trusted named checks allow deterministic test/build gates without arbitrary command strings', async () => {
  const { createTrustedNamedCheckVerifier } = await import('../lib/index.js')
  const r = new VerifierRegistry()
  r.register(createTrustedNamedCheckVerifier({ tests: { version: 'suite-4', run: () => ({ passed: true, reason: '248/248 passed', result: { passed: 248 } }) } }))
  const engine = new OutcomeVerificationEngine(r)
  const contract = createAcceptanceContract({ goalId: 'g', goalRevision: 1, objective: 'tests', criteria: [
    { id: 'tests', description: 'tests pass', severity: 'required', verificationMode: 'deterministic', verifier: 'trusted-check.pass', args: { check: 'tests' } },
  ]})
  const report = await engine.verify(contract)
  assert.equal(report.passed, true)
  assert.match(report.criteria[0].reason, /248\/248 passed/)
})

test('versioned acceptance packs expose reviewed trusted-check criteria', async () => {
  const { codingAcceptancePack, researchAcceptancePack, deploymentAcceptancePack, dataPipelineAcceptancePack, releaseAcceptancePack, ACCEPTANCE_PACK_VERSIONS } = await import('../lib/index.js')
  const base = { goalId: 'pack-goal', goalRevision: 1, objective: 'prove outcome' }
  const packs = [
    codingAcceptancePack(base, { requireLint: true, minimumCoverage: 80 }),
    researchAcceptancePack(base),
    deploymentAcceptancePack(base),
    dataPipelineAcceptancePack(base, { minimumRows: 10, maximumNullRate: 0.01 }),
    releaseAcceptancePack(base),
  ]
  assert.deepEqual(packs.map(value => value.pack?.version), ['1','1','1','1','1'])
  assert.equal(ACCEPTANCE_PACK_VERSIONS.release, '1')
  assert.equal(packs[0].criteria.some(row => row.verifier === 'trusted-check.pass'), true)
  assert.equal(packs[4].criteria.some(row => row.id === 'archive-manifest-valid'), true)
})

test('TrustedCheckRegistry is version fingerprinted and duplicate safe', async () => {
  const { TrustedCheckRegistry } = await import('../lib/index.js')
  const a = new TrustedCheckRegistry()
  a.register({ id: 'tests-pass', version: '1', run: () => ({ passed: true, reason: 'ok' }) })
  const before = a.fingerprint()
  assert.throws(() => a.register({ id: 'tests-pass', version: '2', run: () => ({ passed: true, reason: 'duplicate' }) }), /already registered/)
  const b = new TrustedCheckRegistry()
  b.register({ id: 'tests-pass', version: '2', run: () => ({ passed: true, reason: 'ok' }) })
  assert.notEqual(before, b.fingerprint())
})

test('new recovery, evidence, artifact, and external verifiers fail closed', async () => {
  const engine = new OutcomeVerificationEngine(registry())
  const contract = createAcceptanceContract({ goalId: 'g', goalRevision: 1, objective: 'hard gates', criteria: [
    { id: 'recovery', description: 'recovery', severity: 'required', verificationMode: 'runtime', verifier: 'runtime.recovery-clean' },
    { id: 'contradictions', description: 'contradictions', severity: 'required', verificationMode: 'evidence', verifier: 'evidence.no-contradictions' },
    { id: 'artifact', description: 'artifact', severity: 'required', verificationMode: 'artifact', verifier: 'artifact.nonempty', args: { key: 'release' } },
    { id: 'external', description: 'external', severity: 'required', verificationMode: 'external-state', verifier: 'external.resource-exists', args: { key: 'deployment' } },
  ]})
  const bad = await engine.verify(contract, {
    readRuntime: async key => key === 'recovery-status' ? { value: { canAutoResume: false, blocked: true }, version: 'r1' } : key === 'evidence-contradictions' ? { value: 1, version: 'e1' } : undefined,
    readArtifact: async () => ({ value: '', version: 'a1' }),
    readExternal: async () => undefined,
  })
  assert.equal(bad.passed, false)
})

test('observe mode reports verifier rejection without blocking legacy completion', async () => {
  const { decideVerification } = await import('../lib/index.js')
  const engine = new OutcomeVerificationEngine(registry())
  const contract = createAcceptanceContract({ goalId: 'g', goalRevision: 1, objective: 'observe', criteria: [
    { id: 'ok', description: 'ok', severity: 'required', verificationMode: 'deterministic', verifier: 'value.equals', args: { channel: 'runtime', key: 'ok', expected: true } },
  ]})
  const report = await engine.verify(contract, env({ ok: false }))
  const observe = decideVerification(report, 'observe')
  const enforce = decideVerification(report, 'enforce')
  assert.equal(observe.wouldAccept, false)
  assert.equal(observe.accepted, true)
  assert.equal(enforce.accepted, false)
})

test('verification benchmark computes FAR and FRR and gates false acceptance', async () => {
  const { summarizeVerificationBenchmark, assertVerificationBenchmarkGate, summarizeVerificationByPack } = await import('../lib/index.js')
  const observations = [
    { caseId: 'good-1', pack: 'coding', groundTruth: 'valid', accepted: true, verificationMs: 10, verifierRuns: 3, evidenceRecords: 3, repairRounds: 0 },
    { caseId: 'good-2', pack: 'coding', groundTruth: 'valid', accepted: false, verificationMs: 11, verifierRuns: 3, evidenceRecords: 2, repairRounds: 1 },
    { caseId: 'bad-1', pack: 'coding', groundTruth: 'invalid', accepted: false, verificationMs: 9, verifierRuns: 3, evidenceRecords: 3, repairRounds: 0 },
    { caseId: 'bad-2', pack: 'release', groundTruth: 'invalid', accepted: false, verificationMs: 20, verifierRuns: 8, evidenceRecords: 8, repairRounds: 0 },
  ]
  const summary = summarizeVerificationBenchmark(observations)
  assert.equal(summary.falseAcceptanceRate, 0)
  assert.equal(summary.falseRejectionRate, 0.5)
  assert.doesNotThrow(() => assertVerificationBenchmarkGate(summary, { maximumFalseAcceptanceRate: 0, maximumFalseRejectionRate: 0.5 }))
  assert.throws(() => assertVerificationBenchmarkGate(summary, { maximumFalseAcceptanceRate: 0, maximumFalseRejectionRate: 0.1 }), /FRR/)
  assert.equal(summarizeVerificationByPack(observations).coding.cases, 3)
})

test('goal adapter observe mode records would-reject report without blocking completion', async () => {
  const engine = new OutcomeVerificationEngine(registry())
  const contract = createAcceptanceContract({ goalId: 'g', goalRevision: 1, objective: 'observe adapter', criteria: [
    { id: 'ok', description: 'ok', severity: 'required', verificationMode: 'deterministic', verifier: 'value.equals', args: { channel: 'runtime', key: 'ok', expected: true } },
  ]})
  let observedReport
  const verifier = createGoalOutcomeVerifier({ contract, engine, mode: 'observe', environment: () => env({ ok: false }), onReport: report => { observedReport = report } })
  const result = await verifier.verify({ goal: { id: 'g', revision: 1 } })
  assert.equal(result.passed, true)
  assert.equal(observedReport.passed, false)
  assert.equal(result.evidence[0], 'verification-observe:reject')
})


test('acceptance pack registry binds exact version and fingerprint', () => {
  const registry = new AcceptancePackRegistry()
  for (const factory of STANDARD_ACCEPTANCE_PACK_FACTORIES) registry.register(factory)
  const before = registry.fingerprint()
  const contract = registry.create('coding', '1', { goalId: 'g', goalRevision: 1, objective: 'code' })
  assert.equal(contract.pack.id, 'coding')
  assert.equal(contract.pack.version, '1')
  assert.equal(registry.latest('coding').version, '1')
  registry.register({ id: 'coding', version: '2', create: input => ({ ...codingAcceptancePack(input), pack: { id: 'coding', version: '2' } }) })
  assert.notEqual(registry.fingerprint(), before)
  assert.equal(registry.latest('coding').version, '2')
})

test('pack registry rejects implementation descriptor mismatch', () => {
  const registry = new AcceptancePackRegistry()
  registry.register({ id: 'coding', version: '9', create: input => codingAcceptancePack(input) })
  assert.throws(() => registry.create('coding', '9', { goalId: 'g', goalRevision: 1, objective: 'x' }), /mismatched descriptor/)
})

test('Wilson interval is conservative for a zero-error finite corpus', () => {
  const rate = wilson95(0, 40)
  assert.equal(rate.observed, 0)
  assert.ok(rate.upper95 > 0)
  assert.ok(rate.upper95 < 0.1)
})

test('promotion rejects a perfect but undersized corpus', () => {
  const observations = Array.from({ length: 12 }, (_, index) => ({
    caseId: `small-${index}`,
    pack: 'coding',
    groundTruth: index < 6 ? 'valid' : 'invalid',
    accepted: index < 6,
    verificationMs: 1,
    verifierRuns: 3,
    evidenceRecords: 3,
    repairRounds: 0,
  }))
  const decision = evaluateVerificationPromotion(observations, {
    from: 'observe', to: 'enforce', minimumCases: 50, minimumValidCases: 20, minimumInvalidCases: 20,
    maximumFalseAcceptanceRate: 0, maximumFalseRejectionRate: 0.05,
  }, { now: 123 })
  assert.equal(decision.eligible, false)
  assert.ok(decision.reasons.some(reason => reason.includes('50 labeled cases')))
})

test('promotion accepts sufficiently sized zero-error corpus and binds benchmark fingerprint', () => {
  const observations = Array.from({ length: 60 }, (_, index) => ({
    caseId: `case-${index}`,
    pack: index % 2 === 0 ? 'coding' : 'release',
    groundTruth: index < 20 ? 'valid' : 'invalid',
    accepted: index < 20,
    verificationMs: 1,
    verifierRuns: 4,
    evidenceRecords: 4,
    repairRounds: 0,
  }))
  const decision = evaluateVerificationPromotion(observations, {
    from: 'observe', to: 'enforce', minimumCases: 50, minimumValidCases: 20, minimumInvalidCases: 30,
    maximumFalseAcceptanceRate: 0, maximumFalseRejectionRate: 0.05,
    maximumFalseAcceptanceUpperBound95: 0.1, requirePerPackGates: true,
  }, { policyBinding: { packRegistryFingerprint: 'packs-v1', verifierRegistryFingerprint: 'verifiers-v1', trustedCheckRegistryFingerprint: 'checks-v1' }, now: 123 })
  assert.equal(decision.eligible, true)
  assert.equal(decision.policyBinding.packRegistryFingerprint, 'packs-v1')
  assert.equal(decision.summary.falseAcceptanceRate, 0)
  assert.equal(decision.summary.falseRejectionRate, 0)
  assert.ok(decision.benchmarkFingerprint.length >= 32)
  assert.doesNotThrow(() => assertVerificationPromotion(decision))
})

test('promotion fails conservative confidence-bound gate despite observed FAR zero', () => {
  const observations = Array.from({ length: 10 }, (_, index) => ({
    caseId: `invalid-${index}`, pack: 'coding', groundTruth: 'invalid', accepted: false,
    verificationMs: 1, verifierRuns: 1, evidenceRecords: 1, repairRounds: 0,
  }))
  const decision = evaluateVerificationPromotion(observations, {
    from: 'observe', to: 'enforce', minimumCases: 10, minimumValidCases: 0, minimumInvalidCases: 10,
    maximumFalseAcceptanceRate: 0, maximumFalseAcceptanceUpperBound95: 0.1,
  })
  assert.equal(decision.summary.falseAcceptanceRate, 0)
  assert.equal(decision.eligible, false)
  assert.ok(decision.reasons.some(reason => reason.includes('95% upper bound')))
})


test('policy drift demotes an eligible promotion back to observe', () => {
  const observations = Array.from({ length: 60 }, (_, index) => ({
    caseId: `bound-${index}`, pack: 'coding', groundTruth: index < 20 ? 'valid' : 'invalid', accepted: index < 20,
    verificationMs: 1, verifierRuns: 1, evidenceRecords: 1, repairRounds: 0,
  }))
  const binding = { packRegistryFingerprint: 'packs-a', verifierRegistryFingerprint: 'verifiers-a', trustedCheckRegistryFingerprint: 'checks-a' }
  const decision = evaluateVerificationPromotion(observations, {
    from: 'observe', to: 'enforce', minimumCases: 50, minimumValidCases: 20, minimumInvalidCases: 30,
    maximumFalseAcceptanceRate: 0, maximumFalseRejectionRate: 0.05, maximumFalseAcceptanceUpperBound95: 0.1,
  }, { policyBinding: binding })
  assert.equal(resolvePromotedVerificationMode('observe', decision, binding).mode, 'enforce')
  assert.equal(resolvePromotedVerificationMode('observe', decision, { ...binding, trustedCheckRegistryFingerprint: 'checks-b' }).mode, 'observe')
})

test('failure taxonomy groups adversarial classes and reports class FAR/FRR', async () => {
  const { summarizeFailureTaxonomy } = await import('../lib/index.js')
  const rows = [
    { caseId: 'v1', pack: 'coding', groundTruth: 'valid', faultClass: 'valid-control', accepted: true, verificationMs: 1, verifierRuns: 2, evidenceRecords: 2, repairRounds: 0 },
    { caseId: 'i1', pack: 'coding', groundTruth: 'invalid', faultClass: 'tests-fail', accepted: false, verificationMs: 1, verifierRuns: 2, evidenceRecords: 2, repairRounds: 0 },
    { caseId: 'i2', pack: 'coding', groundTruth: 'invalid', faultClass: 'tests-fail', accepted: true, verificationMs: 1, verifierRuns: 2, evidenceRecords: 2, repairRounds: 0 },
  ]
  const taxonomy = summarizeFailureTaxonomy(rows)
  const tests = taxonomy.find(row => row.faultClass === 'tests-fail')
  assert.equal(tests.cases, 2)
  assert.equal(tests.falseAccepts, 1)
  assert.equal(tests.falseAcceptanceRate, 0.5)
})

test('verified-success uplift measures accepted-outcome precision improvement', async () => {
  const { summarizeVerifiedSuccessUplift } = await import('../lib/index.js')
  const rows = [
    { caseId: 'v1', pack: 'coding', groundTruth: 'valid', accepted: true, verificationMs: 1, verifierRuns: 1, evidenceRecords: 1, repairRounds: 0 },
    { caseId: 'v2', pack: 'coding', groundTruth: 'valid', accepted: true, verificationMs: 1, verifierRuns: 1, evidenceRecords: 1, repairRounds: 0 },
    { caseId: 'i1', pack: 'coding', groundTruth: 'invalid', accepted: false, verificationMs: 1, verifierRuns: 1, evidenceRecords: 1, repairRounds: 0 },
    { caseId: 'i2', pack: 'coding', groundTruth: 'invalid', accepted: false, verificationMs: 1, verifierRuns: 1, evidenceRecords: 1, repairRounds: 0 },
  ]
  const uplift = summarizeVerifiedSuccessUplift(rows)
  assert.equal(uplift.baselineAcceptedPrecision, 0.5)
  assert.equal(uplift.verifierAcceptedPrecision, 1)
  assert.equal(uplift.acceptedPrecisionUplift, 0.5)
  assert.equal(uplift.validRetentionRate, 1)
  assert.equal(uplift.falseAcceptsPrevented, 2)
})

test('promotion receipt binds policy and all verification fingerprints', async () => {
  const {
    createVerificationPromotionReceipt,
    resolveVerificationModeWithPromotionReceipt,
    verifyVerificationPromotionReceipt,
  } = await import('../lib/index.js')
  const binding = { packRegistryFingerprint: 'packs', verifierRegistryFingerprint: 'verifiers', trustedCheckRegistryFingerprint: 'checks' }
  const policy = { from: 'observe', to: 'enforce', minimumCases: 10, minimumValidCases: 2, minimumInvalidCases: 5, maximumFalseAcceptanceRate: 0 }
  const observations = Array.from({ length: 10 }, (_, index) => ({
    caseId: `case-${index}`,
    pack: 'release',
    groundTruth: index < 3 ? 'valid' : 'invalid',
    accepted: index < 3,
    verificationMs: 1,
    verifierRuns: 1,
    evidenceRecords: 1,
    repairRounds: 0,
  }))
  const decision = evaluateVerificationPromotion(observations, policy, { policyBinding: binding, now: 100 })
  assert.equal(decision.eligible, true)
  const receipt = createVerificationPromotionReceipt(decision, policy, { expiresAt: 200 })
  assert.equal(verifyVerificationPromotionReceipt(receipt, policy, binding, { now: 150 }).valid, true)
  assert.equal(resolveVerificationModeWithPromotionReceipt('enforce', receipt, binding, policy, { now: 150 }).mode, 'enforce')
  assert.equal(resolveVerificationModeWithPromotionReceipt('enforce', receipt, { ...binding, trustedCheckRegistryFingerprint: 'changed' }, policy, { now: 150 }).mode, 'observe')
  assert.equal(resolveVerificationModeWithPromotionReceipt('enforce', receipt, binding, policy, { now: 201 }).mode, 'observe')
  assert.equal(resolveVerificationModeWithPromotionReceipt('enforce', undefined, binding, policy).mode, 'observe')
})

test('mutation generator preserves seed and operator provenance', async () => {
  const { generateVerificationMutations } = await import('../lib/index.js')
  const generated = generateVerificationMutations(
    [{ id: 'seed-1', pack: 'coding', fixture: { tests: true, typecheck: true } }],
    [
      { id: 'break-tests', faultClass: 'tests-fail', mutate: fixture => ({ ...fixture, tests: false }) },
      { id: 'break-types', faultClass: 'typecheck-fail', mutate: fixture => ({ ...fixture, typecheck: false }) },
    ],
  )
  assert.equal(generated.length, 2)
  assert.equal(generated[0].benchmarkCase.groundTruth, 'invalid')
  assert.equal(generated[0].benchmarkCase.mutationOf, 'seed-1')
  assert.equal(generated[0].benchmarkCase.mutationOperator, 'break-tests')
  assert.equal(generated[0].fixture.tests, false)
})

test('mutation calibration reports killed and surviving verifier mutations', async () => {
  const { summarizeMutationCalibration } = await import('../lib/index.js')
  const summary = summarizeMutationCalibration([
    { caseId: 'm1', pack: 'coding', groundTruth: 'invalid', faultClass: 'tests-fail', mutationOperator: 'break-tests', mutationOf: 's1', accepted: false, verificationMs: 1, verifierRuns: 1, evidenceRecords: 1, repairRounds: 0 },
    { caseId: 'm2', pack: 'coding', groundTruth: 'invalid', faultClass: 'typecheck-fail', mutationOperator: 'break-types', mutationOf: 's2', accepted: true, verificationMs: 1, verifierRuns: 1, evidenceRecords: 1, repairRounds: 0 },
  ])
  assert.equal(summary.cases, 2)
  assert.equal(summary.killed, 1)
  assert.equal(summary.survived, 1)
  assert.equal(summary.killRate, 0.5)
})

test('required pack calibration rejects aggregate success that hides an untested pack', () => {
  const observations = Array.from({ length: 80 }, (_, index) => ({
    caseId: `coding-only-${index}`, pack: 'coding', groundTruth: index < 30 ? 'valid' : 'invalid', accepted: index < 30,
    faultClass: index < 30 ? 'valid-control' : 'tests-fail', verificationMs: 1, verifierRuns: 2, evidenceRecords: 2, repairRounds: 0,
  }))
  const decision = evaluateVerificationPromotion(observations, {
    from: 'observe', to: 'enforce', minimumCases: 80, minimumValidCases: 30, minimumInvalidCases: 50,
    maximumFalseAcceptanceRate: 0, maximumFalseRejectionRate: 0,
    requiredPacks: {
      coding: { minimumValidCases: 20, minimumInvalidCases: 40, maximumFalseAcceptanceRate: 0 },
      release: { minimumValidCases: 10, minimumInvalidCases: 10, maximumFalseAcceptanceRate: 0 },
    },
  })
  assert.equal(decision.eligible, false)
  assert.match(decision.reasons.join('; '), /release: required pack has no benchmark observations/)
})

test('per-pack gate rejects missing fault coverage and surviving mutations', () => {
  const observations = [
    ...Array.from({ length: 20 }, (_, index) => ({ caseId: `good-${index}`, pack: 'coding', groundTruth: 'valid', accepted: true, faultClass: 'valid-control', verificationMs: 1, verifierRuns: 2, evidenceRecords: 2, repairRounds: 0 })),
    ...Array.from({ length: 40 }, (_, index) => ({ caseId: `bad-${index}`, pack: 'coding', groundTruth: 'invalid', accepted: index === 0, faultClass: 'tests-fail', mutationOperator: 'break-tests', mutationOf: `good-${index % 20}`, verificationMs: 1, verifierRuns: 2, evidenceRecords: 2, repairRounds: 0 })),
  ]
  const decision = evaluateVerificationPromotion(observations, {
    from: 'observe', to: 'enforce', minimumCases: 60, minimumValidCases: 20, minimumInvalidCases: 40,
    maximumFalseAcceptanceRate: 0.1, maximumFalseRejectionRate: 0,
    requiredPacks: {
      coding: {
        minimumValidCases: 20, minimumInvalidCases: 40, maximumFalseAcceptanceRate: 0.1,
        requiredFaultClasses: ['tests-fail', 'typecheck-fail'], minimumMutationCases: 40, minimumMutationKillRate: 1,
      },
    },
  })
  assert.equal(decision.eligible, false)
  assert.match(decision.reasons.join('; '), /typecheck-fail/)
  assert.match(decision.reasons.join('; '), /mutation kill rate/)
})

test('v2 promotion receipt binds independent pack calibration hash', () => {
  const observations = [
    ...Array.from({ length: 40 }, (_, index) => ({ caseId: `g-${index}`, pack: 'coding', groundTruth: 'valid', accepted: true, faultClass: 'valid-control', verificationMs: 1, verifierRuns: 2, evidenceRecords: 2, repairRounds: 0 })),
    ...Array.from({ length: 120 }, (_, index) => ({ caseId: `b-${index}`, pack: 'coding', groundTruth: 'invalid', accepted: false, faultClass: index % 2 ? 'tests-fail' : 'typecheck-fail', mutationOperator: index < 80 ? 'break-check' : undefined, mutationOf: index < 80 ? `g-${index % 40}` : undefined, verificationMs: 1, verifierRuns: 2, evidenceRecords: 2, repairRounds: 0 })),
  ]
  const policy = { from: 'observe', to: 'enforce', minimumCases: 160, minimumValidCases: 40, minimumInvalidCases: 120, maximumFalseAcceptanceRate: 0, maximumFalseRejectionRate: 0,
    requiredPacks: { coding: { minimumValidCases: 40, minimumInvalidCases: 120, maximumFalseAcceptanceRate: 0, requiredFaultClasses: ['tests-fail','typecheck-fail'], minimumMutationCases: 80, minimumMutationKillRate: 1 } } }
  const binding = { packRegistryFingerprint: 'p', verifierRegistryFingerprint: 'v', trustedCheckRegistryFingerprint: 't' }
  const decision = evaluateVerificationPromotion(observations, policy, { policyBinding: binding, now: 10 })
  assert.equal(decision.eligible, true, decision.reasons.join('; '))
  const receipt = createVerificationPromotionReceipt(decision, policy)
  assert.equal(receipt.receiptVersion, 2)
  assert.equal(typeof receipt.packCalibrationHash, 'string')
  assert.equal(verifyVerificationPromotionReceipt(receipt, policy, binding, { now: 10 }).valid, true)
})
