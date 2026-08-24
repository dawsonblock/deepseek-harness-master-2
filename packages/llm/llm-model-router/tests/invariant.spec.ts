import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as RouterInvariant from '@deepseek-ai/dsh-llm-model-router/invariant'
import { routingDecisionIdentity, POLICY_VERSION, SCORER_VERSION } from '../src/index.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(RouterInvariant)
  return ctx
}

function manualState(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'manual' as const,
    authority: 'user' as const,
    selection: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    authorityEpoch: 1,
    source: 'web' as const,
    authoritySchemaVersion: 2 as const,
    ...overrides,
  }
}

function decision(overrides: Record<string, unknown> = {}) {
  return {
    turn: 1,
    step: 1,
    routingDecisionId: routingDecisionIdentity('s', 1, 1, POLICY_VERSION, 'confighash00000000'),
    proposed: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    selected: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    authority: 'router' as const,
    activeAuthority: 'router' as const,
    reason: 'routed-fast' as const,
    threshold: 4,
    policyVersion: POLICY_VERSION,
    scorerVersion: SCORER_VERSION,
    configFingerprint: 'confighash00000000',
    ...overrides,
  }
}

describe('llm-model-router invariants', () => {
  it('accepts a healthy authority stream: manual → auto → router decisions', async () => {
    const ctx = await setup()
    const created = ctx.sessions.create(SessionId('router-invariant-healthy'))
    expect(() => {
      created.append('model/selection-authority', manualState())
      created.append('model/selection-authority', {
        mode: 'auto',
        authority: 'router',
        authorityEpoch: 2,
        source: 'web',
        authoritySchemaVersion: 2,
      })
      created.append('model/routing-decision', decision())
    }).not.toThrow()
  })

  it('rejects a manual state without a complete selection', async () => {
    const ctx = await setup()
    const created = ctx.sessions.create(SessionId('router-invariant-manual-empty'))
    expect(() => {
      created.append('model/selection-authority', manualState({ selection: { provider: '', model: '' } }))
    }).toThrow(/complete non-empty selection/)
  })

  it('rejects an auto state that carries a manual selection', async () => {
    const ctx = await setup()
    const created = ctx.sessions.create(SessionId('router-invariant-auto-selection'))
    expect(() => {
      created.append('model/selection-authority', {
        mode: 'auto',
        authority: 'router',
        selection: { provider: 'p', model: 'm' },
        authorityEpoch: 1,
        source: 'web',
        authoritySchemaVersion: 2,
      })
    }).toThrow(/must not carry a manual selection/)
  })

  it('rejects a router decision made while manual authority is in force', async () => {
    const ctx = await setup()
    const created = ctx.sessions.create(SessionId('router-invariant-supersede'))
    created.append('model/selection-authority', manualState())
    expect(() => {
      created.append('model/routing-decision', decision())
    }).toThrow(/missing auto release/)
  })

  it('accepts a router decision when the router itself claims authority via a decision (no manual state exists)', async () => {
    const ctx = await setup()
    const created = ctx.sessions.create(SessionId('router-invariant-no-manual'))
    expect(() => {
      created.append('model/routing-decision', decision())
      created.append('model/routing-decision', decision({ turn: 2, step: 1 }))
    }).not.toThrow()
  })

  it('rejects epoch regression in the authority stream', async () => {
    const ctx = await setup()
    const created = ctx.sessions.create(SessionId('router-invariant-epoch-regress'))
    created.append('model/selection-authority', manualState({ authorityEpoch: 5 }))
    expect(() => {
      created.append('model/selection-authority', {
        mode: 'auto',
        authority: 'router',
        authorityEpoch: 3,
        source: 'web',
        authoritySchemaVersion: 2,
      })
    }).toThrow(/regressed/)
  })

  it('rejects decisions missing the deterministic id, scorer version, or config fingerprint', async () => {
    const ctx = await setup()
    const created = ctx.sessions.create(SessionId('router-invariant-stamps'))
    expect(() => {
      created.append('model/routing-decision', decision({ routingDecisionId: '' }))
    }).toThrow(/routingDecisionId/)
    expect(() => {
      created.append('model/routing-decision', decision({ scorerVersion: 1 }))
    }).toThrow(/scoring implementation/)
    const { configFingerprint: _omitted, ...withoutFingerprint } = decision()
    void _omitted
    expect(() => {
      created.append('model/routing-decision', withoutFingerprint)
    }).toThrow(/configuration fingerprint/)
  })

  it('rejects an authority state from a future schema version', async () => {
    const ctx = await setup()
    const created = ctx.sessions.create(SessionId('router-invariant-future-schema'))
    expect(() => {
      created.append('model/selection-authority', manualState({ authoritySchemaVersion: 99 }))
    }).toThrow(/authority schema version/)
  })
})
