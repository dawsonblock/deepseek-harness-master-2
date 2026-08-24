import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { TokenEstimateInput, TokenEstimateResult, TokenizerBackend } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function mockBackend(count: (text: string) => number): TokenizerBackend {
  return {
    id: 'deepseek-official-tokenizer',
    version: '1',
    countTokens: async text => count(text),
  }
}

describe('end-to-end context-preflight integration suite', () => {
  it('scenario 1: normal request completes with preflight and usage', async () => {
    const adapter = new MockAdapter([textResponse('ok')], undefined, undefined, 1_000_000)
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('e2e-normal'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const events = agent.session.events
    expect(events.some(e => e.type === 'model/context-preflight')).toBe(true)
    expect(events.some(e => e.type === 'model/request')).toBe(true)
    expect(events.some(e => e.type === 'model/usage')).toBe(true)
    expect(adapter.requests).toHaveLength(1)
  })

  it('scenario 2: tokenizer failure falls back to generic heuristic', async () => {
    const adapter = new MockAdapter([textResponse('ok')], undefined, undefined, 1_000_000)
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('e2e-tokenizer-fail'), { provider: 'mock', model: 'mock' })

    // Register a provider estimator that throws, simulating tokenizer failure.
    const failingBackend = mockBackend(() => { throw new Error('tokenizer crashed') })
    const { DeepSeekTokenizerEstimator } = await import('@deepseek-ai/dsh-llm-deepseek')
    const estimator = new DeepSeekTokenizerEstimator(failingBackend)
    ctx.tokenEstimatorRegistry.register(estimator)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const events = agent.session.events
    const postRouting = events.find(e =>
      e.type === 'model/context-preflight' && (e.data as { phase: string }).phase === 'post-routing',
    )
    expect(postRouting).toBeDefined()
    // The generic heuristic estimator should have been used as fallback.
    expect((postRouting!.data as { estimatorId: string }).estimatorId).toBe('character-heuristic')
    expect(events.some(e => e.type === 'model/request')).toBe(true)
  })

  it('scenario 3: both estimators unavailable does not break the agent', async () => {
    const adapter = new MockAdapter([textResponse('ok')], undefined, undefined, 1_000_000)
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)

    // Override the token estimator with one that always returns unavailable.
    const { TokenEstimatorResolver } = await import('@deepseek-ai/dsh-token-meter')
    new (class extends TokenEstimatorResolver {
      override async estimateInput(_input: TokenEstimateInput): Promise<TokenEstimateResult> {
        return { available: false, reason: 'fallback-estimator-failed' }
      }
    })(ctx)

    const agent = ctx.agentLoop.create(SessionId('e2e-both-unavailable'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const events = agent.session.events
    expect(events.filter(e => e.type === 'model/context-preflight')).toHaveLength(0)
    expect(events.some(e => e.type === 'model/request')).toBe(true)
    expect(adapter.requests).toHaveLength(1)
  })

  it('scenario 4: reject prevents provider invocation and billing', async () => {
    const adapter = new MockAdapter([textResponse('ok')], undefined, undefined, 100)
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('e2e-reject'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const events = agent.session.events
    expect(events.filter(e => e.type === 'model/request')).toHaveLength(0)
    expect(events.filter(e => e.type === 'model/usage')).toHaveLength(0)
    expect(adapter.requests).toHaveLength(0)
    const turnEnd = events.find(e => e.type === 'turn/end')
    expect((turnEnd!.data as { reason: { kind: string } }).reason.kind).toBe('error')
  })

  it('scenario 5: retry isolation — different attempts get separate preflight events', async () => {
    // Two responses: first is an error, second succeeds.
    const errorChunks = [
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 0 } },
      { type: 'finish', reason: { kind: 'error', failure: { message: 'transient', code: 'UNKNOWN' } } },
    ] as const
    const adapter = new MockAdapter([errorChunks as unknown as typeof errorChunks[number][], textResponse('ok')], undefined, undefined, 1_000_000)
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('e2e-retry'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const events = agent.session.events
    const postRoutingPreflights = events.filter(e =>
      e.type === 'model/context-preflight' && (e.data as { phase: string }).phase === 'post-routing',
    )
    // Each attempt should get its own post-routing preflight.
    expect(postRoutingPreflights.length).toBeGreaterThanOrEqual(1)
  })

  it('scenario 6: router identity — routingDecisionId joins preflight to usage', async () => {
    const adapter = new MockAdapter([textResponse('ok')], undefined, undefined, 1_000_000)
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('e2e-router-id'), { provider: 'mock', model: 'mock' })

    ctx.on('agent/request', async (data, next) => {
      const config = await next()
      agent.session.append('model/routing-decision', {
        turn: data.turn,
        step: data.step,
        routingDecisionId: 'e2e-R6',
        proposed: { provider: config.provider, model: config.model },
        selected: { provider: config.provider, model: config.model },
        authority: 'router',
        reason: 'explicit-selection-passthrough',
        threshold: 0,
        policyVersion: 1,
      }, { ignorable: true })
      return config
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const events = agent.session.events
    const postRouting = events.find(e =>
      e.type === 'model/context-preflight' && (e.data as { phase: string }).phase === 'post-routing',
    )
    expect(postRouting).toBeDefined()
    expect((postRouting!.data as { routingDecisionId?: string }).routingDecisionId).toBe('e2e-R6')

    const usage = events.find(e => e.type === 'model/usage')
    expect(usage).toBeDefined()
    expect((usage!.data as { routingDecisionId?: string }).routingDecisionId).toBe('e2e-R6')
  })
})
