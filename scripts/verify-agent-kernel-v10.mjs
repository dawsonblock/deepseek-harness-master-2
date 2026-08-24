import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('..', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')
const [packs, trusted, benchmark, compiler, builtins, adapter, goalOutcome, outcomePkg, hardeningTypes, hardeningExperiments, rootPkg, releaseConfig] = await Promise.all([
  read('packages/outcome/outcome-verification/src/packs.ts'),
  read('packages/outcome/outcome-verification/src/trusted-checks.ts'),
  read('packages/outcome/outcome-verification/src/benchmark.ts'),
  read('packages/outcome/outcome-verification/src/compiler.ts'),
  read('packages/outcome/outcome-verification/src/builtins.ts'),
  read('packages/outcome/outcome-verification/src/adapter.ts'),
  read('packages/goal/goal/src/outcome.ts'),
  read('packages/outcome/outcome-verification/package.json'),
  read('packages/runtime/agent-kernel-hardening/src/types.ts'),
  read('packages/runtime/agent-kernel-hardening/src/experiments.ts'),
  read('package.json'),
  read('config/acceptance/release-v1.json'),
])

for (const name of ['codingAcceptancePack','researchAcceptancePack','deploymentAcceptancePack','dataPipelineAcceptancePack','releaseAcceptancePack']) assert.match(packs, new RegExp(`function ${name}`))
assert.match(packs, /ACCEPTANCE_PACK_VERSIONS/)
assert.match(trusted, /class TrustedCheckRegistry/)
assert.match(trusted, /fingerprint\(\)/)
assert.match(benchmark, /falseAcceptanceRate/)
assert.match(benchmark, /falseRejectionRate/)
assert.match(benchmark, /assertVerificationBenchmarkGate/)
assert.match(compiler, /'research'/)
assert.match(compiler, /'deployment'/)
assert.match(compiler, /'data-pipeline'/)
assert.match(compiler, /'release'/)
assert.match(builtins, /runtime\.recovery-clean/)
assert.match(builtins, /evidence\.no-contradictions/)
assert.match(builtins, /external\.resource-exists/)
assert.match(adapter, /mode\?: VerificationEnforcementMode/)
assert.match(adapter, /verification-observe:reject/)
assert.match(goalOutcome, /readonly mode\?: VerificationEnforcementMode/)
assert.match(goalOutcome, /onReport/)
assert.ok(Number.parseInt(JSON.parse(outcomePkg).version.split('.')[1] ?? '0', 10) >= 2, 'outcome-verification package must remain >= 0.2.x')
assert.match(hardeningTypes, /VerificationObservation/)
assert.match(hardeningExperiments, /summarizeVerificationObservations/)
assert.match(hardeningExperiments, /compareVerificationPacks/)
const config = JSON.parse(releaseConfig)
assert.equal(config.pack, 'release')
assert.equal(config.packVersion, '1')
assert.equal(config.benchmarkGate.maximumFalseAcceptanceRate, 0)
const scripts = JSON.parse(rootPkg).scripts
for (const key of ['check:all','check:ci','release:verify']) {
  assert.match(scripts[key], /verify:agent-kernel-v10/)
  assert.match(scripts[key], /qualify:outcome-v10/)
}
console.log('v0.10 acceptance-pack and verifier-benchmark source guard: PASS')
