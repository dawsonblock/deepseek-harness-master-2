import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OutcomeVerificationEngine,
  TrustedCheckRegistry,
  VerifierRegistry,
  codingAcceptancePack,
  createTrustedCheckVerifier,
  generateVerificationMutations,
  runVerificationBenchmark,
  standardVerifiers,
  summarizeMutationCalibration,
} from '../packages/outcome/outcome-verification/lib/index.js'

const root = await mkdtemp(join(tmpdir(), 'dsh-v13-mutation-'))
try {
  const seeds = Array.from({ length: 40 }, (_, index) => ({
    id: `seed-${index}`, pack: 'coding', fixture: { source: 'export function solve(a,b){ return a+b }\n', unresolved: 0 },
  }))
  const operators = [
    { id: 'logic-subtract', faultClass: 'logic-bug', mutate: fixture => ({ ...fixture, source: 'export function solve(a,b){ return a-b }\n' }) },
    { id: 'syntax-break', faultClass: 'syntax-error', mutate: fixture => ({ ...fixture, source: 'export function solve(a,b){ return a+ }\n' }) },
    { id: 'side-effect-leak', faultClass: 'unresolved-side-effect', mutate: fixture => ({ ...fixture, unresolved: 1 }) },
  ]
  const generated = generateVerificationMutations(seeds, operators)
  assert.equal(generated.length, 120)
  const fixtures = new Map(generated.map(row => [row.benchmarkCase.id, row.fixture]))
  for (const seed of seeds) fixtures.set(seed.id, seed.fixture)
  const cases = [
    ...seeds.map(seed => ({ id: seed.id, pack: 'coding', groundTruth: 'valid', faultClass: 'valid-control' })),
    ...generated.map(row => row.benchmarkCase),
  ]

  async function evaluate(benchmarkCase) {
    const fixture = fixtures.get(benchmarkCase.id)
    assert.ok(fixture)
    const file = join(root, `${benchmarkCase.id.replaceAll(':','_')}.mjs`)
    await writeFile(file, fixture.source)
    const trusted = new TrustedCheckRegistry()
    trusted.register({ id: 'typecheck-pass', version: 'v0.13-fixture-1', run: () => {
      const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
      return { passed: check.status === 0, reason: check.status === 0 ? 'node syntax check passed' : 'node syntax check failed' }
    } })
    trusted.register({ id: 'tests-pass', version: 'v0.13-fixture-1', run: () => {
      const runner = `import {solve} from ${JSON.stringify(new URL(`file://${file}`).href)}; if(solve(7,5)!==12) process.exit(9)`
      const check = spawnSync(process.execPath, ['--input-type=module', '--eval', runner], { encoding: 'utf8' })
      return { passed: check.status === 0, reason: check.status === 0 ? 'behavior test passed' : 'behavior test failed' }
    } })
    const registry = new VerifierRegistry()
    for (const verifier of standardVerifiers()) registry.register(verifier)
    registry.register(createTrustedCheckVerifier(trusted))
    const engine = new OutcomeVerificationEngine(registry)
    const started = performance.now()
    const report = await engine.verify(codingAcceptancePack({ goalId: benchmarkCase.id, goalRevision: 1, objective: 'mutation fixture' }), {
      readRuntime: async key => key === 'unresolved-side-effects' ? { value: fixture.unresolved, version: `${benchmarkCase.id}:runtime:1` } : undefined,
    })
    return { report, verificationMs: performance.now() - started }
  }

  const { observations, summary } = await runVerificationBenchmark(cases, evaluate)
  assert.equal(summary.cases, 160)
  assert.equal(summary.validCases, 40)
  assert.equal(summary.invalidCases, 120)
  assert.equal(summary.falseAccepts, 0)
  assert.equal(summary.falseRejects, 0)
  const mutation = summarizeMutationCalibration(observations)
  assert.equal(mutation.cases, 120)
  assert.equal(mutation.killed, 120)
  assert.equal(mutation.survived, 0)
  assert.equal(mutation.killRate, 1)
  assert.deepEqual(mutation.operators, ['logic-subtract', 'side-effect-leak', 'syntax-break'])
  console.log('v0.13 executable mutation fixtures: 160/160; valid=40; mutations=120; killed=120; survived=0; mutation kill=1.000; FAR=0; FRR=0; PASS')
} finally {
  await rm(root, { recursive: true, force: true })
}
