import assert from 'node:assert/strict'
import {
  EvidenceStore,
  OutcomeVerificationEngine,
  TrustedCheckRegistry,
  VerifierRegistry,
  compileContractDraft,
  createAcceptanceContract,
  createGoalOutcomeVerifier,
  createTrustedCheckVerifier,
  sha256Hex,
  standardVerifiers,
} from '../packages/outcome/outcome-verification/lib/index.js'

const values = new Map()
const versions = new Map()
const set = (key, value) => { values.set(key, value); versions.set(key, String((Number(versions.get(key) ?? '0')) + 1)) }
const checks = new TrustedCheckRegistry()
for (const id of ['tests-pass', 'typecheck-pass', 'lint-pass']) checks.register({ id, version: 'v0.10-adapter', run: () => ({ passed: values.get(id) === true, reason: `${id}=${String(values.get(id))}` }) })
const r = new VerifierRegistry()
for (const verifier of standardVerifiers()) r.register(verifier)
r.register(createTrustedCheckVerifier(checks))
const store = new EvidenceStore()
const engine = new OutcomeVerificationEngine(r, store)
const environment = () => ({
  now: () => Date.now(),
  readRuntime: async key => values.has(key) ? { value: values.get(key), version: versions.get(key) } : undefined,
})

let assertions = 0
const ok = (condition, message) => { assertions += 1; assert.equal(Boolean(condition), true, message) }

set('tests-pass', false); set('typecheck-pass', true); set('unresolved-side-effects', 0)
const contract = compileContractDraft({ goalId: 'release', goalRevision: 1, objective: 'release verified runtime', pack: 'coding' })
let report = await engine.verify(contract, environment())
ok(!report.passed, 'false completion must be rejected')
ok(engine.repairPlan(report).items.some(item => item.criterionId === 'tests-pass'), 'repair plan must name failing criterion')

set('tests-pass', true)
report = await engine.verify(contract, environment())
ok(report.passed, 'corrected work must pass')
let receipt = engine.createReceipt(report, [{ key: 'release.zip', sha256: 'aaa' }])
ok(engine.verifyReceipt(receipt), 'receipt hash must verify')
ok(!engine.verifyReceipt(receipt, [{ key: 'release.zip', sha256: 'bbb' }]), 'mutated artifact must invalidate current receipt match')

store.invalidate({ kind: 'runtime', key: 'trusted-check:tests-pass', version: 'changed' }, 'source changed after verification', Date.now() + 1)
ok(engine.status(contract).some(row => row.criterion.id === 'tests-pass' && row.state === 'stale'), 'dependency mutation must stale prior evidence')

const tampered = { ...receipt, contractHash: 'tampered' }
ok(!engine.verifyReceipt(tampered), 'receipt tampering must fail')

const contract2 = createAcceptanceContract({
  goalId: 'g', goalRevision: 2, objective: 'goal adapter',
  criteria: [{ id: 'ok', description: 'ok', severity: 'required', verificationMode: 'deterministic', verifier: 'value.equals', args: { channel: 'runtime', key: 'ok', expected: true } }],
})
set('ok', true)
let persisted
const adapter = createGoalOutcomeVerifier({ contract: contract2, engine: new OutcomeVerificationEngine(r), environment, onReceipt: value => { persisted = value } })
const mismatch = await adapter.verify({ goal: { id: 'g', revision: 1 } })
ok(!mismatch.passed, 'stale goal revision must fail closed')
const matched = await adapter.verify({ goal: { id: 'g', revision: 2 } })
ok(matched.passed, 'matching goal revision may pass')
ok(persisted && matched.evidence?.some(item => item === `outcome-receipt:${persisted.receiptHash}`), 'goal evidence must bind receipt hash')

const expected = sha256Hex('release')
ok(expected.length === 64, 'artifact hashes must be SHA-256 width')

console.log(`v0.9 outcome qualification: ${assertions}/${assertions} PASS`)
