import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
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
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

/** A response that delivers usage then an error finish — the provider consumed tokens but the request failed. */
function errorAfterUsage(message: string, code: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'partial' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, source: 'provider' } },
    { type: 'finish', reason: { kind: 'error', failure: { message, code } } },
  ]
}

describe('model/usage accounting invariant', () => {
  it('records model/usage for every paid attempt, including retries that fail', async () => {
    const adapter = new MockAdapter([
      errorAfterUsage('busy', 'RATE_LIMIT'),
      textResponse('ok'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('usage-retry-invariant'), { provider: 'mock', model: 'mock' })

    ctx.on('agent/request-error', async () => ({ kind: 'retry' }))

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const events = agent.session.events
    const modelUsageEvents = events.filter(event => event.type === 'model/usage')
    const assistantMessages = events.filter(event => event.type === 'assistant/message')

    // Two paid attempts → two model/usage events.
    expect(modelUsageEvents).toHaveLength(2)
    // Only the successful attempt produced an assistant/message.
    expect(assistantMessages).toHaveLength(1)

    // The first model/usage is from the failed attempt (attempt 1).
    const firstUsage = modelUsageEvents[0]!
    expect(firstUsage.data.attempt).toBe(1)
    expect(firstUsage.data.usage.inputTokens).toBe(10)
    expect(firstUsage.data.usage.outputTokens).toBe(5)

    // The second model/usage is from the successful attempt (attempt 2).
    const secondUsage = modelUsageEvents[1]!
    expect(secondUsage.data.attempt).toBe(2)

    // Accounting total = attempt1 + attempt2.
    const totalInput = firstUsage.data.usage.inputTokens + secondUsage.data.usage.inputTokens
    const totalOutput = firstUsage.data.usage.outputTokens + secondUsage.data.usage.outputTokens
    expect(totalInput).toBe(20) // 10 + 10
    expect(totalOutput).toBeGreaterThan(5) // 5 + len('ok')
  })

  it('does not emit model/usage when the adapter reports no usage', async () => {
    const noUsageResponse: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'partial' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } },
      { type: 'finish', reason: { kind: 'error', failure: { message: 'no usage', code: 'NO_USAGE' } } },
    ]
    const adapter = new MockAdapter([
      noUsageResponse,
      textResponse('ok'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('usage-no-usage-invariant'), { provider: 'mock', model: 'mock' })

    ctx.on('agent/request-error', async () => ({ kind: 'retry' }))

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const events = agent.session.events
    const modelUsageEvents = events.filter(event => event.type === 'model/usage')
    const assistantMessages = events.filter(event => event.type === 'assistant/message')

    // Only the successful attempt had usage.
    expect(modelUsageEvents).toHaveLength(1)
    expect(assistantMessages).toHaveLength(1)
    expect(modelUsageEvents[0]!.data.attempt).toBe(2)
  })

  it('carries routingDecisionId on model/usage when a routing decision exists', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('usage-routing-id'), { provider: 'mock', model: 'mock' })

    // Simulate a router appending a routing decision.
    ctx.on('agent/request', async (data, next) => {
      const config = await next()
      agent.session.append('model/routing-decision', {
        turn: data.turn,
        step: data.step,
        routingDecisionId: 'test-R1',
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

    const modelUsageEvents = agent.session.events.filter(event => event.type === 'model/usage')
    expect(modelUsageEvents).toHaveLength(1)
    expect(modelUsageEvents[0]!.data.routingDecisionId).toBe('test-R1')
  })

  it('leaves routingDecisionId undefined for manual selection (no router)', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('usage-manual'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const modelUsageEvents = agent.session.events.filter(event => event.type === 'model/usage')
    expect(modelUsageEvents).toHaveLength(1)
    expect(modelUsageEvents[0]!.data.routingDecisionId).toBeUndefined()
  })
})
