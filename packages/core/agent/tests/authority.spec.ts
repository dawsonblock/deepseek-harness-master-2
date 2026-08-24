import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  clearExplicitModelSelection,
  explicitModelSelectionMark,
  markExplicitModelSelection,
  nextAuthorityEpoch,
} from '../src/index.ts'
import type { ModelSelectionAuthorityEventData } from '../src/index.ts'

function freshSession(): Session {
  return Session.create(SessionId('authority-spec'))
}

function authorityEvents(session: Session): ModelSelectionAuthorityEventData[] {
  return session.events
    .filter((event): event is SessionEvent<'model/selection-authority'> => event.type === 'model/selection-authority')
    .map(event => event.data)
}

describe('model-selection authority', () => {
  it('an explicit claim sets the live mark AND records durably with its surface source', () => {
    const session = freshSession()
    markExplicitModelSelection(session, 'web', { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    expect(explicitModelSelectionMark(session)?.state).toMatchObject({ mode: 'manual', authority: 'user', selection: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } })
    const events = authorityEvents(session)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      mode: 'manual',
      authority: 'user',
      source: 'web',
      selection: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      authorityEpoch: 1,
      authoritySchemaVersion: 2,
    })
  })

  it('an SDK claim records authority sdk; re-claiming the same authority writes no new event', () => {
    const session = freshSession()
    markExplicitModelSelection(session, 'sdk', { provider: 'p', model: 'm' })
    expect(explicitModelSelectionMark(session)?.state).toMatchObject({ mode: 'manual', authority: 'sdk' })
    expect(authorityEvents(session).at(-1)).toMatchObject({ authority: 'sdk', source: 'sdk' })
    // v0.15.4: a same-authority re-selection with a DIFFERENT model is a
    // semantic change and records (crash after Pro→Flash must restore Flash).
    markExplicitModelSelection(session, 'sdk', { provider: 'p', model: 'm2' })
    expect(authorityEvents(session)).toHaveLength(2)
    expect(authorityEvents(session).at(-1)).toMatchObject({
      mode: 'manual',
      authority: 'sdk',
      selection: { model: 'm2' },
    })
    // An identical re-selection records nothing (complete no-op).
    markExplicitModelSelection(session, 'sdk', { provider: 'p', model: 'm2' })
    expect(authorityEvents(session)).toHaveLength(2)
    // A different authority (web after sdk) IS a transition and records.
    markExplicitModelSelection(session, 'web', { provider: 'p', model: 'm3' })
    expect(authorityEvents(session)).toHaveLength(3)
    expect(authorityEvents(session).at(-1)).toMatchObject({ authority: 'user', source: 'web' })
  })

  it('Auto (clear) releases authority durably; clearing an automatic session is a no-op', () => {
    const session = freshSession()
    clearExplicitModelSelection(session)
    expect(authorityEvents(session)).toHaveLength(0)
    markExplicitModelSelection(session, 'web', { provider: 'p', model: 'm3' })
    clearExplicitModelSelection(session, 'web')
    expect(explicitModelSelectionMark(session)).toBeUndefined()
    expect(authorityEvents(session).map(data => data.authority)).toEqual(['user', 'router'])
    expect(authorityEvents(session).at(-1)).toMatchObject({
      authority: 'router',
      source: 'web',
      reason: 'automatic selection restored',
    })
    // Idempotent: a second clear writes nothing.
    clearExplicitModelSelection(session)
    expect(authorityEvents(session)).toHaveLength(2)
  })

  it('nextAuthorityEpoch never resets: it continues above every persisted epoch, including legacy routing decisions', () => {
    const session = freshSession()
    // Simulate a v0.15.2-era log: routing decisions carried authorityEpoch 27.
    session.append('model/routing-decision', {
      turn: 1,
      step: 1,
      proposed: { provider: 'p', model: 'fast' },
      selected: { provider: 'p', model: 'heavy' },
      authority: 'router',
      authorityEpoch: 27,
      reason: 'escalated-to-heavy',
      threshold: 4,
      policyVersion: 2,
    }, { ignorable: true })
    expect(nextAuthorityEpoch(session.events)).toBe(28)
    markExplicitModelSelection(session, 'web', { provider: 'p', model: 'm3' })
    expect(authorityEvents(session).at(-1)?.authorityEpoch).toBe(28)
    // Authority events count too — and epochs from ANY schema version count:
    // reusing an epoch some future-schema event already wrote could collide
    // when that schema becomes current, so the counter never regresses.
    session.append('model/selection-authority', {
      authority: 'user',
      authorityEpoch: 99,
      source: 'web',
      authoritySchemaVersion: 99 as never,
    })
    expect(nextAuthorityEpoch(session.events)).toBe(100)
  })

  it('a fresh session starts at epoch 1', () => {
    expect(nextAuthorityEpoch([])).toBe(1)
  })

  it('model/selection-authority events are required (not ignorable): an older runtime that does not know the type must refuse the log', () => {
    // The session contract (dsh-session/types.ts) defines ignorable true as
    // "purely informational and cannot affect reconstruction." The persistence
    // read path (session-persistence/coordinator.ts assertEventsSupported)
    // refuses a log containing an unknown event type unless it is marked
    // ignorable. model/selection-authority is reconstruction-critical — it
    // determines who owns model selection and what mode is in force — so it
    // must NOT be ignorable. An older runtime that does not know the type must
    // reject the session rather than silently dropping a manual Pro selection.
    const session = freshSession()
    markExplicitModelSelection(session, 'web', { provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    const manualEvent = session.events.find(event => event.type === 'model/selection-authority')
    expect(manualEvent?.ignorable).toBeUndefined()

    clearExplicitModelSelection(session, 'web')
    const autoEvent = session.events.findLast(event => event.type === 'model/selection-authority')
    expect(autoEvent?.ignorable).toBeUndefined()
  })
})
