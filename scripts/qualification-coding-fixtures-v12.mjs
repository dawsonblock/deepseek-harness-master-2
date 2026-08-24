import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  OutcomeVerificationEngine,
  TrustedCheckRegistry,
  VerifierRegistry,
  codingAcceptancePack,
  createTrustedCheckVerifier,
  runVerificationBenchmark,
  standardVerifiers,
  summarizeFailureTaxonomy,
  summarizeVerifiedSuccessUplift,
} from '../packages/outcome/outcome-verification/lib/index.js'

const root = await mkdtemp(join(tmpdir(), 'dsh-v12-coding-'))
try {
  const scenarios = new Map()
  for (let i = 0; i < 10; i += 1) scenarios.set(`valid-${i}`, { valid: true, faultClass: 'valid-control', source: 'export function solve(a,b){ return a+b }\n', unresolved: 0 })
  for (let i = 0; i < 10; i += 1) scenarios.set(`logic-${i}`, { valid: false, faultClass: 'logic-bug', source: 'export function solve(a,b){ return a-b }\n', unresolved: 0 })
  for (let i = 0; i < 10; i += 1) scenarios.set(`syntax-${i}`, { valid: false, faultClass: 'syntax-error', source: 'export function solve(a,b){ return a+ }\n', unresolved: 0 })
  for (let i = 0; i < 10; i += 1) scenarios.set(`side-effect-${i}`, { valid: false, faultClass: 'unresolved-side-effect', source: 'export function solve(a,b){ return a+b }\n', unresolved: 1 })

  for (const [id, scenario] of scenarios) {
    const dir = join(root, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'candidate.mjs'), scenario.source)
  }

  const cases = [...scenarios.entries()].map(([id, scenario]) => ({ id, pack: 'coding', groundTruth: scenario.valid ? 'valid' : 'invalid', faultClass: scenario.faultClass }))
  const { observations, summary } = await runVerificationBenchmark(cases, async benchmarkCase => {
    const scenario = scenarios.get(benchmarkCase.id)
    const candidate = join(root, benchmarkCase.id, 'candidate.mjs')
    const typecheck = spawnSync(process.execPath, ['--check', candidate], { encoding: 'utf8' }).status === 0
    const url = `${pathToFileURL(candidate).href}?case=${encodeURIComponent(benchmarkCase.id)}`
    const behavioral = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(url)}).then(m=>process.exit(m.solve(2,3)===5?0:1)).catch(()=>process.exit(2))`], { encoding: 'utf8' }).status === 0
    const trusted = new TrustedCheckRegistry()
    trusted.register({ id: 'tests-pass', version: 'fixture-v12', run: () => ({ passed: behavioral, reason: behavioral ? 'executable behavior passed' : 'executable behavior failed' }) })
    trusted.register({ id: 'typecheck-pass', version: 'fixture-v12', run: () => ({ passed: typecheck, reason: typecheck ? 'node syntax check passed' : 'node syntax check failed' }) })
    const registry = new VerifierRegistry()
    for (const verifier of standardVerifiers()) registry.register(verifier)
    registry.register(createTrustedCheckVerifier(trusted))
    const engine = new OutcomeVerificationEngine(registry)
    const contract = codingAcceptancePack({ goalId: benchmarkCase.id, goalRevision: 1, objective: 'Implement solve(a,b) = a+b' })
    const started = performance.now()
    const report = await engine.verify(contract, { readRuntime: async key => key === 'unresolved-side-effects' ? { value: scenario.unresolved, version: `${benchmarkCase.id}:runtime:1` } : undefined })
    return { report, verificationMs: performance.now() - started }
  })
  assert.equal(summary.cases, 40)
  assert.equal(summary.falseAccepts, 0)
  assert.equal(summary.falseRejects, 0)
  const uplift = summarizeVerifiedSuccessUplift(observations)
  assert.equal(uplift.baselineAcceptedPrecision, 0.25)
  assert.equal(uplift.verifierAcceptedPrecision, 1)
  assert.equal(uplift.acceptedPrecisionUplift, 0.75)
  assert.equal(uplift.validRetentionRate, 1)
  const taxonomy = summarizeFailureTaxonomy(observations)
  for (const row of taxonomy.filter(row => row.invalidCases > 0)) assert.equal(row.falseAcceptanceRate, 0)
  console.log(`v0.12 executable coding fixtures: 40/40 classified; FAR=0; FRR=0; accepted precision 25%->100% (+75pp); PASS`)
} finally {
  await rm(root, { recursive: true, force: true })
}
