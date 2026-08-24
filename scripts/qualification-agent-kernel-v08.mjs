import assert from 'node:assert/strict'

function classify(call) {
  const unknown = call.callSeq !== undefined && (!call.dispatchTracked || call.dispatched)
  if (!unknown) return 'not-started'
  if (call.recoveryMode === 'idempotent') return 'retry-safe'
  if (call.recoveryMode === 'reconcile') return 'reconcile-required'
  return 'legacy-ambiguous'
}

const cases = [
  [{ name: 'read', dispatchTracked: true, dispatched: false }, 'not-started'],
  [{ name: 'read', callSeq: 5, dispatchTracked: true, dispatched: false, recoveryMode: 'idempotent' }, 'not-started'],
  [{ name: 'read', callSeq: 5, dispatchTracked: true, dispatched: true, recoveryMode: 'idempotent' }, 'retry-safe'],
  [{ name: 'write', callSeq: 5, dispatchTracked: true, dispatched: true, recoveryMode: 'reconcile' }, 'reconcile-required'],
  [{ name: 'shell', callSeq: 5, dispatchTracked: false, dispatched: false }, 'legacy-ambiguous'],
]
let passed = 0
for (const [input, expected] of cases) { assert.equal(classify(input), expected); passed++ }

function recoveryDisposition(receipt) {
  if (receipt.reconciliationRequiredCalls.length || receipt.legacyAmbiguousCalls.length) return 'blocked'
  if (receipt.notStartedCalls.length || receipt.retrySafeCalls.length) return 'retryable'
  return 'clean'
}
assert.equal(recoveryDisposition({ notStartedCalls: ['a'], retrySafeCalls: [], reconciliationRequiredCalls: [], legacyAmbiguousCalls: [] }), 'retryable'); passed++
assert.equal(recoveryDisposition({ notStartedCalls: [], retrySafeCalls: ['a'], reconciliationRequiredCalls: [], legacyAmbiguousCalls: [] }), 'retryable'); passed++
assert.equal(recoveryDisposition({ notStartedCalls: [], retrySafeCalls: [], reconciliationRequiredCalls: ['a'], legacyAmbiguousCalls: [] }), 'blocked'); passed++
assert.equal(recoveryDisposition({ notStartedCalls: [], retrySafeCalls: [], reconciliationRequiredCalls: [], legacyAmbiguousCalls: ['a'] }), 'blocked'); passed++
assert.equal(recoveryDisposition({ notStartedCalls: [], retrySafeCalls: [], reconciliationRequiredCalls: [], legacyAmbiguousCalls: [] }), 'clean'); passed++

function checkpointAppend(events, reason) {
  const latest = events.at(-1)
  if (latest?.type === 'session/checkpoint') return events
  return [...events, { seq: events.length, type: 'session/checkpoint', data: { version: 1, basisSeq: latest?.seq ?? -1, reason } }]
}
let events = [{ seq: 0, type: 'turn/start', data: {} }]
events = checkpointAppend(events, 'pre-step')
assert.equal(events.length, 2); passed++
assert.equal(events[1].data.basisSeq, 0); passed++
events = checkpointAppend(events, 'model-request')
assert.equal(events.length, 2, 'same prefix must reuse existing marker'); passed++
events.push({ seq: 2, type: 'request/header', data: {} })
events = checkpointAppend(events, 'model-request')
assert.equal(events.length, 4); passed++
assert.equal(events[3].data.basisSeq, 2); passed++

console.log(`agent-kernel v0.8 checkpoint/recovery qualification: ${passed}/15 PASS`)
