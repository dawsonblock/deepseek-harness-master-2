import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const childScript = fileURLToPath(new URL('./fixtures/agent-kernel-v08-checkpoint-crash-child.mjs', import.meta.url))

async function crashScenario(scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v08-checkpoint-chaos-'))
  const log = join(dir, 'events.jsonl')
  try {
    const child = spawn(process.execPath, [childScript, log, scenario], { stdio: ['ignore', 'pipe', 'pipe'] })
    let lines = 0
    const target = scenario === 'not-started' || scenario === 'legacy' ? 5 : 6
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${scenario}`)), 5000)
      child.on('error', reject)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        lines += chunk.split('\n').filter(Boolean).length
        if (lines >= target) { clearTimeout(timer); resolve() }
      })
    })
    child.kill('SIGKILL')
    await new Promise(resolve => child.once('exit', resolve))
    const text = readFileSync(log, 'utf8').trim()
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function receipt(events) {
  const checkpoint = [...events].reverse().find(e => e.type === 'session/checkpoint')
  const call = [...events].reverse().find(e => e.type === 'tool/call')
  const dispatched = events.some(e => e.type === 'tool/dispatch' && e.data.callId === call?.data.callId)
  const result = events.some(e => e.type === 'tool/result' && e.data.callId === call?.data.callId)
  const out = { notStarted: [], retrySafe: [], reconcile: [], legacy: [] }
  if (call && !result) {
    const tracked = call.data.lifecycleVersion === 1
    const unknown = !tracked || dispatched
    if (!unknown) out.notStarted.push(call.data.callId)
    else if (call.data.recoveryMode === 'idempotent') out.retrySafe.push(call.data.callId)
    else if (call.data.recoveryMode === 'reconcile') out.reconcile.push(call.data.callId)
    else out.legacy.push(call.data.callId)
  }
  const tailStartSeq = checkpoint ? checkpoint.seq + 1 : 0
  return { checkpoint, tailStartSeq, tailEventCount: events.length - tailStartSeq, ...out }
}

const expectations = {
  'not-started': 'notStarted',
  'retry-safe': 'retrySafe',
  'reconcile': 'reconcile',
  'legacy': 'legacy',
}
let passed = 0
for (const [scenario, bucket] of Object.entries(expectations)) {
  const events = await crashScenario(scenario)
  assert.equal(events[0]?.type, 'session/checkpoint', `${scenario}: checkpoint must be durable prefix anchor`); passed++
  const r = receipt(events)
  assert.equal(r.checkpoint?.data.version, 1, `${scenario}: checkpoint schema`); passed++
  assert.deepEqual(r[bucket], ['c'], `${scenario}: recovery bucket`); passed++
  assert.ok(r.tailEventCount >= 4, `${scenario}: crash tail must be measurable`); passed++
}
console.log(`agent-kernel v0.8 checkpoint process-kill qualification: ${passed}/16 PASS`)
