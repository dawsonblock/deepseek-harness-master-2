import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
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

describe('model/context-preflight integration', () => {
  it('emits pre-routing and post-routing preflight events with correct ordering', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('preflight-ordering'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const events = agent.session.events
    const preflightEvents = events.filter(e => e.type === 'model/context-preflight')
    const modelRequestEvents = events.filter(e => e.type === 'model/request')
    const modelUsageEvents = events.filter(e => e.type === 'model/usage')

    // Both pre-routing and post-routing preflight events should be emitted.
    expect(preflightEvents.length).toBeGreaterThanOrEqual(2)
    const preRouting = preflightEvents.find(e => (e.data as { phase: string }).phase === 'pre-routing')
    const postRouting = preflightEvents.find(e => (e.data as { phase: string }).phase === 'post-routing')
    expect(preRouting).toBeDefined()
    expect(postRouting).toBeDefined()

    // Ordering invariant: post-routing preflight seq < model/request seq < model/usage seq.
    const postRoutingSeq = postRouting!.seq
    const modelRequestSeq = modelRequestEvents[0]!.seq
    const modelUsageSeq = modelUsageEvents[0]!.seq
    expect(postRoutingSeq).toBeLessThan(modelRequestSeq)
    expect(modelRequestSeq).toBeLessThan(modelUsageSeq)

    // Pre-routing preflight must precede the routing decision (if any) and the post-routing preflight.
    expect(preRouting!.seq).toBeLessThan(postRoutingSeq)
  })

  it('populates WorkloadFeatures.context from pre-routing preflight', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('preflight-features'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const events = agent.session.events
    const preRouting = events.find(e => e.type === 'model/context-preflight' && (e.data as { phase: string }).phase === 'pre-routing')
    expect(preRouting).toBeDefined()

    // The pre-routing preflight event should carry estimator provenance.
    const data = preRouting!.data as {
      estimatedInputTokens: number
      estimatorId: string
      estimatorVersion: string
    }
    expect(data.estimatedInputTokens).toBeGreaterThan(0)
    expect(data.estimatorId).toBe('character-heuristic')
    expect(data.estimatorVersion).toBe('1')
  })

  it('does not break the agent when the estimator is unavailable', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)

    const agent = ctx.agentLoop.create(SessionId('preflight-no-estimator'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    // The agent should complete successfully without preflight events.
    const events = agent.session.events
    const preflightEvents = events.filter(e => e.type === 'model/context-preflight')
    expect(preflightEvents).toHaveLength(0)

    const assistantMessages = events.filter(e => e.type === 'assistant/message')
    expect(assistantMessages).toHaveLength(1)
  })

  it('emits preflight with routingDecisionId when a router is active', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('preflight-routing'), { provider: 'mock', model: 'mock' })

    ctx.on('agent/request', async (data, next) => {
      const config = await next()
      agent.session.append('model/routing-decision', {
        turn: data.turn,
        step: data.step,
        routingDecisionId: 'test-PF1',
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
    const data = postRouting!.data as { routingDecisionId?: string }
    expect(data.routingDecisionId).toBe('test-PF1')
  })
})
