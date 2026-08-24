import { appendFileSync, closeSync, fsyncSync, openSync } from 'node:fs'

const [logPath, scenario] = process.argv.slice(2)
if (!logPath || !scenario) throw new Error('usage: child <logPath> <scenario>')
let seq = 0
function append(type, data) {
  const fd = openSync(logPath, 'a')
  try {
    appendFileSync(fd, `${JSON.stringify({ seq: seq++, type, data })}\n`, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  process.stdout.write(`checkpoint:${type}\n`)
}
function waitForever() { setInterval(() => {}, 60_000) }

append('session/checkpoint', { version: 1, basisSeq: -1, reason: 'tool-effect' })
append('turn/start', { turn: 1 })
append('step/start', { turn: 1, step: 1 })
append('assistant/message', { turn: 1, step: 1, calls: [{ callId: 'c', name: 'side_effect' }] })

if (scenario === 'not-started') {
  append('tool/call', { callId: 'c', name: 'side_effect', lifecycleVersion: 1, recoveryMode: 'reconcile', operationKey: 'op:c' })
  waitForever()
}
if (scenario === 'retry-safe') {
  append('tool/call', { callId: 'c', name: 'read_only', lifecycleVersion: 1, recoveryMode: 'idempotent', operationKey: 'op:c' })
  append('tool/dispatch', { callId: 'c', name: 'read_only' })
  waitForever()
}
if (scenario === 'reconcile') {
  append('tool/call', { callId: 'c', name: 'side_effect', lifecycleVersion: 1, recoveryMode: 'reconcile', operationKey: 'op:c' })
  append('tool/dispatch', { callId: 'c', name: 'side_effect' })
  waitForever()
}
if (scenario === 'legacy') {
  append('tool/call', { callId: 'c', name: 'legacy_side_effect' })
  waitForever()
}
throw new Error(`unknown scenario: ${scenario}`)
