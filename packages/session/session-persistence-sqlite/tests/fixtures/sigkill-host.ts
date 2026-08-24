/**
 * SIGKILL durability fixture for SQLite: one child process performs a
 * model-selection mutation, flushes, prints SUCCESS, and waits to be killed.
 * A second child process loads the same SQLite database and prints the
 * reconstructed state as JSON.
 *
 * Usage:
 *   node --import tsx/esm sigkill-host.ts <dbPath> <scenario> <sessionId>
 */

import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionPersistenceSqlite from '@deepseek-ai/dsh-session-persistence-sqlite'
import { claimModelSelection, releaseToAuto, reconstructSelectionState } from '@deepseek-ai/dsh-agent'

const [dbPath, scenario, sessionIdArg] = process.argv.slice(2) as [string, string, string | undefined]

if (!dbPath || !scenario) {
  console.error('usage: sigkill-host.ts <dbPath> <scenario> [sessionId]')
  process.exit(2)
}

async function main(): Promise<void> {
  if (scenario === 'load') {
    const sessionId = SessionId(sessionIdArg!)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionPersistenceSqlite, { path: dbPath })
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

  const sessionId = SessionId(sessionIdArg ?? 'sigkill-session')
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionPersistenceSqlite, { path: dbPath })
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
    claimModelSelection(session, { authority: 'user', source: 'web', selection: { provider: 'deepseek-official', model: 'deepseek-pro' } })
    ctx.on('session/flush', () => { throw new Error('injected flush failure') })
    try {
      await ctx.sessions.flush(session)
    } catch {
      console.log('FLUSH_FAILED')
      setInterval(() => {}, 60_000)
      return
    }
    console.error('flush unexpectedly succeeded')
    process.exit(1)
  } else {
    console.error(`unknown scenario: ${scenario}`)
    process.exit(2)
  }

  await ctx.sessions.flush(session)
  console.log('SUCCESS')
  setInterval(() => {}, 60_000)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
