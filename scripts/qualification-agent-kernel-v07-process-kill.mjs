import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const childScript = fileURLToPath(new URL('./fixtures/agent-kernel-v07-crash-child.mjs', import.meta.url))

function classify(events) {
  const types = new Set(events.map(event => event.type))
  if (types.has('tool/result')) return 'completed'
  if (types.has('tool/dispatch')) return 'outcome-unknown'
  if (types.has('tool/call')) return 'not-started'
  return 'missing'
}

async function crashAt(stopAfter) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-v07-chaos-'))
  const log = join(dir, 'events.jsonl')
  try {
    const child = spawn(process.execPath, [childScript, log, stopAfter], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buffered = ''
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${stopAfter}`)), 5000)
      child.on('error', reject)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        buffered += chunk
        if (buffered.includes(`checkpoint:${stopAfter}\n`)) {
          clearTimeout(timer)
          resolve()
        }
      })
    })
    child.kill('SIGKILL')
    await new Promise(resolve => child.once('exit', resolve))
    const text = readFileSync(log, 'utf8').trim()
    return text.length === 0 ? [] : text.split('\n').map(line => JSON.parse(line))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const scenarios = [
  ['tool/call', 'not-started'],
  ['tool/dispatch', 'outcome-unknown'],
  ['tool/settled', 'outcome-unknown'],
  ['tool/result', 'completed'],
]

let passed = 0
for (const [checkpoint, expected] of scenarios) {
  const events = await crashAt(checkpoint)
  assert.equal(classify(events), expected, checkpoint)
  assert.ok(events.length >= 1, `${checkpoint} must durably preserve at least tool/call`)
  passed += 2
}

console.log(`agent-kernel v0.7 process-kill lifecycle qualification: ${passed}/${scenarios.length * 2} PASS`)
