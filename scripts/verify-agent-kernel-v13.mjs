import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const [types, promotion, mutation, calibration, index, pkg, config, rootPkg] = await Promise.all([
  read('packages/outcome/outcome-verification/src/types.ts'),
  read('packages/outcome/outcome-verification/src/promotion.ts'),
  read('packages/outcome/outcome-verification/src/mutation.ts'),
  read('packages/outcome/outcome-verification/src/calibration.ts'),
  read('packages/outcome/outcome-verification/src/index.ts'),
  read('packages/outcome/outcome-verification/package.json').then(JSON.parse),
  read('config/acceptance/release-v4.json').then(JSON.parse),
  read('package.json').then(JSON.parse),
])
assert.equal(pkg.version, '0.5.0')
assert.match(types, /VerificationPackPromotionGate/)
assert.match(types, /MutationCalibrationSummary/)
assert.match(types, /mutationOperator/)
assert.match(promotion, /requiredPacks/)
assert.match(promotion, /minimumMutationKillRate/)
assert.match(promotion, /packCalibrationHash/)
assert.match(mutation, /generateVerificationMutations/)
assert.match(calibration, /summarizeMutationCalibration/)
assert.match(index, /\.\/mutation\.js/)
assert.equal(config.targetMode, 'enforce')
assert.equal(Object.keys(config.requiredPacks).length, 6)
for (const [pack, gate] of Object.entries(config.requiredPacks)) {
  assert.ok(gate.minimumValidCases >= 100, `${pack} valid calibration too small`)
  assert.ok(gate.minimumInvalidCases >= 250, `${pack} invalid calibration too small`)
  assert.ok(gate.minimumMutationCases >= 150, `${pack} mutation corpus too small`)
  assert.equal(gate.minimumMutationKillRate, 1)
}
for (const name of ['verify:agent-kernel-v13','qualify:outcome-v13','qualify:mutation-fixtures-v13','resolve:release-verification-v13']) assert.ok(rootPkg.scripts[name], `missing ${name}`)
console.log('v0.13 source integration guard: PASS')
