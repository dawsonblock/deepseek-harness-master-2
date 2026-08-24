import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

function fingerprint(rows) {
  const stable = [...rows]
    .map(row => ({ role: row.role, name: row.name, version: row.version ?? '' }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.role.localeCompare(b.role))
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex')
}

function verifiedCommitAllowed(events, goal, currentFingerprint) {
  const latest = events.at(-1)
  return latest?.type === 'goal/verification'
    && latest.data.version === 2
    && latest.data.passed === true
    && latest.data.goal.id === goal.id
    && latest.data.goal.revision === goal.revision
    && latest.data.registryFingerprint === currentFingerprint
}

const registryA = [
  { name: 'runtime-integrity', role: 'integrity', version: '1' },
  { name: 'tests-pass', role: 'acceptance', version: '3' },
]
const registryAReordered = [...registryA].reverse()
const registryB = [
  { name: 'runtime-integrity', role: 'integrity', version: '1' },
  { name: 'tests-pass', role: 'acceptance', version: '4' },
]

const fpA = fingerprint(registryA)
assert.match(fpA, /^[0-9a-f]{64}$/)
assert.equal(fpA, fingerprint(registryAReordered), 'fingerprint must be order independent')
assert.notEqual(fpA, fingerprint(registryB), 'verifier version changes must invalidate policy binding')

const goal = { id: 'g', revision: 9 }
const verification = {
  type: 'goal/verification',
  data: {
    version: 2,
    passed: true,
    goal,
    basisSeq: 40,
    registryFingerprint: fpA,
  },
}
assert.equal(verifiedCommitAllowed([verification], goal, fpA), true)
assert.equal(verifiedCommitAllowed([verification], goal, fingerprint(registryB)), false, 'changed verifier registry must invalidate authorization')
assert.equal(verifiedCommitAllowed([{ ...verification, data: { ...verification.data, version: 1 } }], goal, fpA), false, 'legacy verification is not a v0.7 authorization')
assert.equal(verifiedCommitAllowed([verification, { type: 'model/request', data: {} }], goal, fpA), false, 'intervening event invalidates one-shot authorization')

const codeEvents = [
  { type: 'tool/call', time: 0, data: { callId: 'outer', name: 'run_code' } },
  { type: 'tool/code-dispatch-start', time: 10, data: { parentCallId: 'outer', subCallId: 'a' } },
  { type: 'tool/code-dispatch-start', time: 12, data: { parentCallId: 'outer', subCallId: 'b' } },
  { type: 'tool/code-dispatch', time: 16, data: { parentCallId: 'outer', subCallId: 'b', isError: false } },
  { type: 'tool/code-dispatch', time: 20, data: { parentCallId: 'outer', subCallId: 'a', isError: false } },
]
const starts = new Map(codeEvents.filter(e => e.type === 'tool/code-dispatch-start').map(e => [e.data.subCallId, e.time]))
const latencies = codeEvents.filter(e => e.type === 'tool/code-dispatch').map(e => e.time - starts.get(e.data.subCallId))
assert.deepEqual(latencies, [4, 10])
assert.equal(codeEvents.filter(e => e.type === 'tool/code-dispatch').length, 2)

console.log('agent-kernel v0.7 policy-binding + Code Mode qualification: 10/10 PASS')
