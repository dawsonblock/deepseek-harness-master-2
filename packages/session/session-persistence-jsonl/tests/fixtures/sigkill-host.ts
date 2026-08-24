/**
 * SIGKILL durability fixture: one child process performs a model-selection
 * mutation, flushes, prints SUCCESS, and waits to be killed. A second child
 * process loads the same storage and prints the reconstructed state as JSON.
 *
 * Usage:
 *   node --import tsx/esm sigkill-host.ts <rootDir> <scenario> <sessionId>
 *
 * Scenarios:
 *   manual      — claim manual Pro, flush, print SUCCESS
 *   auto        — claim manual Pro, release to Auto, flush, print SUCCESS
 *   reselect    — claim manual Pro, claim manual Flash, flush, print SUCCESS
 *   foreign     — append foreign request/header, claim foreign, release Auto, flush, print SUCCESS
 *   load        — load <sessionId>, reconstruct state, print JSON to stdout
 */

import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { claimModelSelection, releaseToAuto, reconstructSelectionState } from '@deepseek-ai/dsh-agent'

const [rootDir, scenario, sessionIdArg] = process.argv.slice(2) as [string, string, string | undefined]

if (!rootDir || !scenario) {
  console.error('usage: sigkill-host.ts <rootDir> <scenario> [sessionId]')
  process.exit(2)
}

async function main(): Promise<void> {
  if (scenario === 'load') {
    // Load phase: read from disk, reconstruct, print state as JSON.
    const sessionId = SessionId(sessionIdArg!)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: rootDir, compression: 'none' })
    const loaded = await ctx.sessionPersistence.load(sessionId)
    if (loaded === undefined) {
      console.log(JSON.stringify({ found: false }))
    } else {
      const state = reconstructSelectionState(loaded.events as readonly SessionEvent[])
      console.log(JSON.stringify({ found: true, state }))
    }
    await ctx.fiber.dispose()
    return
  }

  // Mutation phase: create session, perform scenario, flush, print SUCCESS.
  const sessionId = SessionId(sessionIdArg ?? 'sigkill-session')
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root: rootDir, compression: 'none' })
  const session = ctx.sessions.create(sessionId)

  if (scenario === 'manual') {
    claimModelSelection(session, { authority: 'user', source: 'web', selection: { provider: 'deepseek-official', model: 'deepseek-pro' } })
  } else if (scenario === 'auto') {
    claimModelSelection(session, { authority: 'user', source: 'web', selection: { provider: 'deepseek-official', model: 'deepseek-pro' } })
    releaseToAuto(session, 'web')
  } else if (scenario === 'reselect') {
    claimModelSelection(session, { authority: 'user', source: 'web', selection: { provider: 'deepseek-official', model: 'deepseek-pro' } })
    claimModelSelection(session, { authority: 'user', source: 'web', selection: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  } else if (scenario === 'foreign') {
    session.append('request/header', {
      header: { config: { provider: 'foreign-gateway', model: 'foreign-model' } },
      reason: 'initial',
    })
    claimModelSelection(session, { authority: 'user', source: 'web', selection: { provider: 'foreign-gateway', model: 'foreign-model' } })
    releaseToAuto(session, 'web')
  } else if (scenario === 'flush-fail') {
    // Claim manual Pro, then inject a flush failure. The event is appended
    // (synchronously for JSONL), but flush reports failure. The caller is
    // told the selection was not durably confirmed. The process is then
    // SIGKILLed. The reload must find either the old state (nothing was
    // written) or the new state (the append succeeded before flush), but
    // never a malformed or partial state.
    claimModelSelection(session, { authority: 'user', source: 'web', selection: { provider: 'deepseek-official', model: 'deepseek-pro' } })
    ctx.on('session/flush', () => { throw new Error('injected flush failure') })
    try {
      await ctx.sessions.flush(session)
    } catch {
      // Flush failed as expected. Signal to the parent.
      console.log('FLUSH_FAILED')
      setInterval(() => {}, 60_000)
      return
    }
    // If flush somehow succeeded, that's a test setup failure.
    console.error('flush unexpectedly succeeded')
    process.exit(1)
  } else {
    console.error(`unknown scenario: ${scenario}`)
    process.exit(2)
  }

  await ctx.sessions.flush(session)
  // Signal success to the parent. Do NOT dispose — the parent will SIGKILL.
  // A dispose() would run cleanup; SIGKILL bypasses it, which is the point.
  console.log('SUCCESS')
  // Keep the process alive so the parent can kill it.
  setInterval(() => {}, 60_000)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
