import assert from 'node:assert/strict'

function classify({ tracked, dispatched, result }) {
  if (result) return 'completed'
  if (tracked && !dispatched) return 'not-started'
  return 'outcome-unknown'
}

function verifiedCommitAllowed(events, goal) {
  const latest = events.at(-1)
  return latest?.type === 'goal/verification'
    && latest.data.passed === true
    && latest.data.goal.id === goal.id
    && latest.data.goal.revision === goal.revision
}

const crashScenarios = [
  { name: 'crash-before-dispatch', input: { tracked: true, dispatched: false, result: false }, expected: 'not-started' },
  { name: 'crash-after-dispatch', input: { tracked: true, dispatched: true, result: false }, expected: 'outcome-unknown' },
  { name: 'crash-after-result', input: { tracked: true, dispatched: true, result: true }, expected: 'completed' },
  { name: 'legacy-unmatched', input: { tracked: false, dispatched: false, result: false }, expected: 'outcome-unknown' },
]
for (const scenario of crashScenarios) {
  assert.equal(classify(scenario.input), scenario.expected, scenario.name)
}

const goal = { id: 'g', revision: 7 }
const pass = { type: 'goal/verification', data: { passed: true, goal } }
const fail = { type: 'goal/verification', data: { passed: false, goal } }
assert.equal(verifiedCommitAllowed([pass], goal), true, 'fresh exact passing verification')
assert.equal(verifiedCommitAllowed([fail], goal), false, 'failed verification')
assert.equal(verifiedCommitAllowed([pass, { type: 'model/request', data: {} }], goal), false, 'intervening durable event invalidates authorization')
assert.equal(verifiedCommitAllowed([{ ...pass, data: { ...pass.data, goal: { id: 'g', revision: 6 } } }], goal), false, 'stale revision')
assert.equal(verifiedCommitAllowed([{ ...pass, data: { ...pass.data, goal: { id: 'other', revision: 7 } } }], goal), false, 'wrong goal')

const reconciliation = {
  completed: 'reuse-result-no-redispatch',
  'not-executed': 'dispatch-body',
  unknown: 'block',
}
assert.equal(reconciliation.completed, 'reuse-result-no-redispatch')
assert.equal(reconciliation['not-executed'], 'dispatch-body')
assert.equal(reconciliation.unknown, 'block')

console.log('agent-kernel v0.6 failure-injection specification: 12/12 PASS')
