import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')
const [types, calibration, promotion, index, pkg, config, rootPkg] = await Promise.all([
  read('packages/outcome/outcome-verification/src/types.ts'),
  read('packages/outcome/outcome-verification/src/calibration.ts'),
  read('packages/outcome/outcome-verification/src/promotion.ts'),
  read('packages/outcome/outcome-verification/src/index.ts'),
  read('packages/outcome/outcome-verification/package.json').then(JSON.parse),
  read('config/acceptance/release-v3.json').then(JSON.parse),
  read('package.json').then(JSON.parse),
])
assert.ok(Number.parseInt(pkg.version.split('.')[1] ?? '0', 10) >= 4, `outcome package ${pkg.version} predates v0.12 semantics`)
assert.match(types, /VerificationFailureTaxonomyEntry/)
assert.match(types, /VerifiedSuccessUpliftSummary/)
assert.match(types, /VerificationPromotionReceipt/)
assert.match(calibration, /summarizeFailureTaxonomy/)
assert.match(calibration, /summarizeVerifiedSuccessUplift/)
assert.match(promotion, /createVerificationPromotionReceipt/)
assert.match(promotion, /resolveVerificationModeWithPromotionReceipt/)
assert.match(index, /\.\/calibration\.js/)
assert.equal(config.targetMode, 'enforce')
assert.equal(config.requirePromotionReceipt, true)
assert.ok(config.promotion.minimumCases >= 1600)
assert.ok(config.promotion.minimumInvalidCases >= 1100)
assert.ok(config.benchmarkGate.maximumFalseAcceptanceUpperBound95 <= 0.005)
for (const name of ['qualify:outcome-v12','qualify:coding-fixtures-v12','resolve:release-verification-v12','verify:agent-kernel-v12']) assert.ok(rootPkg.scripts[name], `missing ${name}`)
console.log('v0.12 source integration guard: PASS')
