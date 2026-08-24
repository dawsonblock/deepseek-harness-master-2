import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('..', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')
const [pkg, goalDomain, goalIndex, goalOutcome, known, hardeningTypes, hardeningMetrics, rootPkg, baseTsconfig, hostTsconfig, goalTsconfig] = await Promise.all([
  read('packages/outcome/outcome-verification/package.json'),
  read('packages/goal/goal/src/domain.ts'),
  read('packages/goal/goal/src/index.ts'),
  read('packages/goal/goal/src/outcome.ts'),
  read('packages/core/session/src/known-event-types.ts'),
  read('packages/runtime/agent-kernel-hardening/src/types.ts'),
  read('packages/runtime/agent-kernel-hardening/src/metrics.ts'),
  read('package.json'),
  read('tsconfig.base.json'),
  read('tsconfig.host.json'),
  read('packages/goal/goal/tsconfig.json'),
])
const manifest = JSON.parse(pkg)
assert.equal(manifest.name, '@deepseek-ai/dsh-outcome-verification')
assert.equal(manifest.exports['.'].default, './lib/index.js')
assert.match(goalDomain, /'goal\/outcome-receipt': GoalOutcomeReceiptMeta/)
assert.match(goalIndex, /registerOutcomeContract/)
assert.match(goalOutcome, /session\.append\('goal\/outcome-receipt'/)
assert.match(goalOutcome, /registerAcceptanceVerifier/)
assert.match(known, /'goal\/outcome-receipt'/)
assert.match(baseTsconfig, /@deepseek-ai\/dsh-outcome-verification/)
assert.match(hostTsconfig, /packages\/outcome\/outcome-verification/)
assert.match(goalTsconfig, /outcome\/outcome-verification/)
assert.match(hardeningTypes, /outcomeReceipts: number/)
assert.match(hardeningMetrics, /case 'goal\/outcome-receipt'/)
const scripts = JSON.parse(rootPkg).scripts
for (const key of ['check:all','check:ci','release:verify']) {
  assert.match(scripts[key], /test:outcome-verification/)
  assert.match(scripts[key], /verify:agent-kernel-v09/)
  assert.match(scripts[key], /qualify:outcome-v09/)
}
console.log('v0.9 source integration guard: PASS')
