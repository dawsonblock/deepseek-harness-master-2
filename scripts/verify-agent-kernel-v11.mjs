import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('..', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')
const [promotion, packRegistry, types, index, outcomePkg, rootPkg, releaseConfig, promotionCli] = await Promise.all([
  read('packages/outcome/outcome-verification/src/promotion.ts'),
  read('packages/outcome/outcome-verification/src/pack-registry.ts'),
  read('packages/outcome/outcome-verification/src/types.ts'),
  read('packages/outcome/outcome-verification/src/index.ts'),
  read('packages/outcome/outcome-verification/package.json'),
  read('package.json'),
  read('config/acceptance/release-v2.json'),
  read('scripts/evaluate-verifier-promotion-v11.mjs'),
])

assert.match(promotion, /wilson95/)
assert.match(promotion, /evaluateVerificationPromotion/)
assert.match(promotion, /resolvePromotedVerificationMode/)
assert.match(promotion, /verification policy drift/)
assert.match(packRegistry, /class AcceptancePackRegistry/)
assert.match(packRegistry, /fingerprint\(\)/)
assert.match(packRegistry, /mismatched descriptor/)
assert.match(types, /VerificationPromotionPolicy/)
assert.match(types, /VerificationPolicyBinding/)
assert.match(types, /maximumFalseAcceptanceUpperBound95/)
assert.match(index, /pack-registry/)
assert.match(index, /promotion/)
assert.ok(Number.parseInt(JSON.parse(outcomePkg).version.split('.')[1] ?? '0', 10) >= 3, 'outcome-verification package must remain >= 0.3.x')
const config = JSON.parse(releaseConfig)
assert.equal(config.schemaVersion, 2)
assert.equal(config.promotion.minimumCases, 150)
assert.equal(config.promotion.minimumInvalidCases, 100)
assert.equal(config.promotion.policyBindingRequired, true)
assert.equal(config.benchmarkGate.maximumFalseAcceptanceRate, 0)
assert.equal(config.benchmarkGate.maximumFalseAcceptanceUpperBound95, 0.04)
assert.match(promotionCli, /benchmark input must contain policyBinding/)
assert.match(promotionCli, /evaluateVerificationPromotion/)
const scripts = JSON.parse(rootPkg).scripts
assert.match(scripts['evaluate:verification-promotion'], /evaluate-verifier-promotion-v11/)
for (const key of ['check:all','check:ci','release:verify']) {
  assert.match(scripts[key], /verify:agent-kernel-v11/)
  assert.match(scripts[key], /qualify:outcome-v11/)
}
console.log('v0.11 statistically gated verification-promotion source guard: PASS')
