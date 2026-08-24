import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const types = readFileSync('packages/core/session/src/types.ts', 'utf8')
const repair = readFileSync('packages/core/session/src/repair.ts', 'utf8')
const checkpoint = readFileSync('packages/session/session-checkpoint-policy/src/index.ts', 'utf8')
const metrics = readFileSync('packages/runtime/agent-kernel-hardening/src/metrics.ts', 'utf8')
const plan = readFileSync('packages/runtime/agent-kernel-hardening/src/recovery-plan.ts', 'utf8')
const known = readFileSync('packages/core/session/src/known-event-types.ts', 'utf8')

for (const token of ["'session/checkpoint'", "'session/recovery'", 'checkpointBasisSeq', 'reconciliationRequiredCalls']) {
  assert.ok(types.includes(token), `missing session recovery schema token: ${token}`)
}
for (const token of ['async function checkpoint(', "session.append('session/checkpoint'", "await ctx.sessions.flush(session)", "'tool-effect'", "'pre-step'"]) {
  assert.ok(checkpoint.includes(token), `missing durability checkpoint integration: ${token}`)
}
for (const token of ["type: 'session/recovery'", 'notStartedCalls', 'retrySafeCalls', 'reconciliationRequiredCalls', 'legacyAmbiguousCalls', 'latestCheckpoint']) {
  assert.ok(repair.includes(token), `missing crash recovery receipt integration: ${token}`)
}
for (const token of ['durabilityCheckpoints', 'recoveryReceipts', 'recoveryReconciliationRequiredCalls', 'averageRecoveryTailEvents']) {
  assert.ok(metrics.includes(token), `missing recovery telemetry: ${token}`)
}
for (const token of ['deriveLatestRecoveryPlan', "RecoveryDisposition = 'clean' | 'retryable' | 'blocked'", 'canAutoResume']) {
  assert.ok(plan.includes(token), `missing recovery plan API: ${token}`)
}
assert.ok(known.includes("'session/checkpoint'"))
assert.ok(known.includes("'session/recovery'"))
console.log('agent-kernel v0.8 source integration guard: PASS')
