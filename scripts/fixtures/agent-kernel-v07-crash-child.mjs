import { appendFileSync, closeSync, fsyncSync, openSync } from 'node:fs'

const [logPath, stopAfter] = process.argv.slice(2)
if (!logPath || !stopAfter) throw new Error('usage: child <logPath> <stopAfter>')

function append(type, data) {
  const fd = openSync(logPath, 'a')
  try {
    appendFileSync(fd, `${JSON.stringify({ type, data })}\n`, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  process.stdout.write(`checkpoint:${type}\n`)
}

function waitForever() {
  setInterval(() => {}, 60_000)
}

append('tool/call', { callId: 'c', name: 'side_effect', lifecycleVersion: 1 })
if (stopAfter === 'tool/call') waitForever()
else {
  append('tool/dispatch', { callId: 'c', name: 'side_effect' })
  if (stopAfter === 'tool/dispatch') waitForever()
  else {
    append('tool/settled', { callId: 'c', name: 'side_effect', outcome: 'resolved' })
    if (stopAfter === 'tool/settled') waitForever()
    else {
      append('tool/result', { callId: 'c', name: 'side_effect' })
      waitForever()
    }
  }
}
