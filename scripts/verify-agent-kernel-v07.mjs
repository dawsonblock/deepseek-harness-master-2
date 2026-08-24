import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const goal = readFileSync('packages/goal/goal/src/index.ts', 'utf8')
const domain = readFileSync('packages/goal/goal/src/domain.ts', 'utf8')
const metrics = readFileSync('packages/runtime/agent-kernel-hardening/src/metrics.ts', 'utf8')
const metricTypes = readFileSync('packages/runtime/agent-kernel-hardening/src/types.ts', 'utf8')

for (const token of [
  'verifierRegistryFingerprint()',
  "createHash('sha256')",
  'registryFingerprint: this.verifierRegistryFingerprint()',
  "latest.data.version !== 2",
  'latest.data.registryFingerprint !== this.verifierRegistryFingerprint()',
  'verifierVersion',
]) assert.ok(goal.includes(token) || domain.includes(token), `missing verifier-provenance token: ${token}`)

assert.ok(domain.includes('readonly basisSeq: number'), 'verification must preserve the pre-verification ledger basis')
assert.ok(domain.includes('readonly registryFingerprint: string'), 'verification must bind the verifier registry')
assert.ok(domain.includes("readonly version: 2"), 'goal verification event must use provenance schema v2')

for (const token of [
  'codeSubdispatchesStarted',
  'codeSubdispatchesSettled',
  'codeSubdispatchErrors',
  'codeSubdispatchLogBytes',
  'averageCodeSubdispatchLatencyMs',
  'averageCodeSubcallsPerRun',
]) assert.ok(metrics.includes(token) || metricTypes.includes(token), `missing Code Mode metric: ${token}`)

console.log('agent-kernel v0.7 source integration guard: PASS')
