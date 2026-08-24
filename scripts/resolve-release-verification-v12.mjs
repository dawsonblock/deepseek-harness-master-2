import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  AcceptancePackRegistry,
  STANDARD_ACCEPTANCE_PACK_FACTORIES,
  TrustedCheckRegistry,
  VerifierRegistry,
  resolveVerificationModeWithPromotionReceipt,
  standardVerifiers,
  verifyVerificationPromotionReceipt,
} from '../packages/outcome/outcome-verification/lib/index.js'

const config = JSON.parse(await readFile(new URL('../config/acceptance/release-v3.json', import.meta.url), 'utf8'))
const receipt = JSON.parse(await readFile(new URL('../config/acceptance/release-v3-promotion.json', import.meta.url), 'utf8'))
const packs = new AcceptancePackRegistry()
for (const factory of STANDARD_ACCEPTANCE_PACK_FACTORIES) packs.register(factory)
const verifiers = new VerifierRegistry()
for (const verifier of standardVerifiers()) verifiers.register(verifier)
const checks = new TrustedCheckRegistry()
for (const id of config.trustedChecks) checks.register({ id, version: config.trustedCheckVersion, run: () => ({ passed: true, reason: 'fingerprint-only resolver' }) })
const binding = {
  packRegistryFingerprint: packs.fingerprint(),
  verifierRegistryFingerprint: verifiers.fingerprint(),
  trustedCheckRegistryFingerprint: checks.fingerprint(),
}
const policy = {
  from: 'observe', to: 'enforce',
  minimumCases: config.promotion.minimumCases,
  minimumValidCases: config.promotion.minimumValidCases,
  minimumInvalidCases: config.promotion.minimumInvalidCases,
  maximumFalseAcceptanceRate: config.benchmarkGate.maximumFalseAcceptanceRate,
  maximumFalseRejectionRate: config.benchmarkGate.maximumFalseRejectionRate,
  maximumFalseAcceptanceUpperBound95: config.benchmarkGate.maximumFalseAcceptanceUpperBound95,
  requirePerPackGates: config.promotion.requirePerPackGates,
}
const verified = verifyVerificationPromotionReceipt(receipt, policy, binding)
assert.equal(verified.valid, true, verified.reason)
const resolved = resolveVerificationModeWithPromotionReceipt(config.targetMode, receipt, binding, policy)
assert.equal(resolved.mode, 'enforce', resolved.reason)
console.log(`v0.12 release verification policy: ${resolved.mode.toUpperCase()} (${resolved.reason}); PASS`)
