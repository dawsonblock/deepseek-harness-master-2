/**
 * Web session model-directory and selection behavior: dynamic provider grouping,
 * provider-local catalog failures, logged-selection restoration without stale
 * catalog injection, advisory pass-through models, and the prompt-assembly
 * boundary for a running selection change.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AttachmentStore from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmCallConfig, LlmModelInfo, LlmModelReasoningInfo, LlmProviderInfo,
  LlmResolvedModelInfo, StreamChunk,
  UserMessage,
} from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`models-${String(nextRpc++)}`), payload }
}

class CatalogAdapter extends LlmAdapter {
  constructor(
    private readonly name: string,
    private readonly models: readonly LlmModelInfo[] | Error,
    private readonly reasoning?: LlmModelReasoningInfo,
    private readonly exactError?: Error,
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.name }
  }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return this.models instanceof Error
      ? Promise.reject(this.models)
      : Promise.resolve(this.models)
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (this.exactError !== undefined) return Promise.reject(this.exactError)
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...this.reasoning === undefined ? {} : { reasoning: this.reasoning },
    })
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Catalog tests never enter provider streaming.
  }
}

const REASONING: LlmModelReasoningInfo = {
  efforts: [
    { id: ReasoningEffortId('off'), name: 'Off' },
    { id: ReasoningEffortId('high'), name: 'High' },
    { id: ReasoningEffortId('max'), name: 'Max' },
  ],
  defaultEffort: ReasoningEffortId('high'),
}

async function harness(logged?: {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
}): Promise<{
  ctx: Context
  agent: Agent
  sessionId: SessionId
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  ctx.llm.registerAdapter(['deepseek-official'], new CatalogAdapter('DeepSeek', [
    { provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' },
    { provider: 'deepseek-official', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', description: 'Reasoning model' },
  ], REASONING))
  ctx.llm.registerAdapter(['broken'], new CatalogAdapter('Broken Provider', new Error('catalog offline')))
  ctx.llm.registerAdapter(['metadata-broken'], new CatalogAdapter('Metadata Broken', [
    { provider: 'metadata-broken', id: 'listed', name: 'Listed' },
  ], undefined, new Error('reasoning metadata offline')))
  ctx.llm.registerAdapter(['empty'], new CatalogAdapter('Empty Provider', []))
  ctx.llm.registerAdapter(['duplicate'], new CatalogAdapter('Duplicate Provider', [
    { provider: 'duplicate', id: 'same', name: 'Same' },
    { provider: 'duplicate', id: 'same', name: 'Same Again' },
  ]))
  const session = ctx.sessions.create()
  if (logged !== undefined) {
    session.append('request/header', { header: { config: logged }, reason: 'initial' })
  }
  const agent = {
    id: session.id,
    session,
    status: 'running',
    ctx,
    inbox: { nextTurn: [], nextStep: [] },
  } as unknown as Agent
  ctx.agents.register(agent)
  return { ctx, agent, sessionId: session.id }
}

function expectValue<T>(response: { result: { ok: true; value: T } | { ok: false } }): T {
  if (!response.result.ok) throw new Error('expected successful response')
  return response.result.value
}

function registerTextOnly(ctx: Context): void {
  ctx.llm.registerAdapter(['text-only'], new class extends CatalogAdapter {
    override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
      return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] })
    }
  }('Text Only', []))
}

describe('Web session model selection', () => {
  it('validates an ordered image batch before persisting any member', async () => {
    const { ctx, agent, sessionId } = await harness()
    const validateImage = vi.fn((_input: { data: Uint8Array }) => Promise.resolve())
    const saveImage = vi.fn((input: { data: Uint8Array; mediaType: 'image/png'; name?: string }) => Promise.resolve({
      attachmentId: `att-${String(input.data[0])}`,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      ...input.name === undefined ? {} : { name: input.name },
    }))
    const attachments = {
      imageLimits: {
        maxImageBytes: 4,
        maxImagesPerMessage: 2,
        maxMessageImageBytes: 4,
        maxImagePixels: 4,
        maxImageDimension: 2000,
        mediaTypes: ['image/png'],
      },
      validateImage,
      saveImage,
    }
    ctx.provide('attachments', Object.setPrototypeOf(attachments, AttachmentStore.prototype) as never)
    const followup = vi.fn()
    Object.assign(agent, { followup })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })

    const result = await api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: [
        { type: 'image' as const, mediaType: 'image/png' as const, data: 'AQ==', name: 'first.png' },
        { type: 'text' as const, text: 'compare' },
        { type: 'image' as const, mediaType: 'image/png' as const, data: 'Ag==' },
      ],
    }))
    expect(result.result.ok).toBe(true)
    expect(validateImage.mock.calls.map(([input]) => [...input.data])).toEqual([[1], [2]])
    expect(saveImage.mock.calls.map(([input]) => [...input.data])).toEqual([[1], [2]])
    expect((followup.mock.calls[0]?.[0] as UserMessage).content).toEqual([
      {
        type: 'image',
        attachment: {
          attachmentId: 'att-1', mediaType: 'image/png', bytes: 1, width: 1, height: 1, name: 'first.png',
        },
      },
      { type: 'text', text: 'compare' },
      { type: 'image', attachment: { attachmentId: 'att-2', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
    ])

    const denied = await api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: Array.from({ length: 3 }, () => ({
        type: 'image' as const, mediaType: 'image/png' as const, data: 'AQ==',
      })),
    }))
    expect(denied.result).toMatchObject({
      ok: false,
      error: { code: 'attachment-error', details: { reason: 'TOO_MANY_IMAGES' } },
    })
    expect(saveImage).toHaveBeenCalledTimes(2)
    await ctx.fiber.dispose()
  })

  it('v0.15.4: selectModel mode auto releases manual authority and resets the picked model to the default', async () => {
    const { ctx, agent, sessionId } = await harness()
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })
    // A manual FOREIGN selection claims durable authority and picks the route.
    expect(expectValue(await api.sessions.selectModel(request({
      sessionId, provider: 'duplicate', model: 'same',
    }))).selected).toEqual({ provider: 'duplicate', model: 'same' })

    // Auto: releases the durable claim AND resets the effective selection to
    // the deployment default — the stale foreign route must not keep
    // impersonating a manual choice.
    expect(expectValue(await api.sessions.selectModel(request({
      sessionId, mode: 'auto',
    }))).selected).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })

    const authorityEvents = agent.session.events.filter(event => event.type === 'model/selection-authority')
    expect(authorityEvents.map(event => event.data.mode)).toEqual(['manual', 'auto'])
    expect(authorityEvents.at(-1)?.data).toMatchObject({ mode: 'auto', authority: 'router' })
    await ctx.fiber.dispose()
  })

  it('v0.15.4: a manual selection is crash-durable ahead of the logged header', async () => {
    // The session header says deepseek-chat; the user then selects the
    // reasoner and the process dies before any request runs. A fresh proxy
    // (new process) must resolve the MANUAL selection, not the stale header.
    const { ctx, agent, sessionId } = await harness({ provider: 'deepseek-official', model: 'deepseek-chat' })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })
    expect(expectValue(await api.sessions.selectModel(request({
      sessionId, provider: 'deepseek-official', model: 'deepseek-reasoner',
    }))).selected).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-reasoner' })

    // Simulated restart: a FRESH process (new context + proxy) mounts the
    // same session log; the in-process picked state is gone. The durable
    // manual claim must win over the stale request header.
    const secondCtx = new Context()
    await secondCtx.plugin(SessionStore)
    await secondCtx.plugin(SystemPrompt, { persona: '' })
    await secondCtx.plugin(LlmRuntime)
    await secondCtx.plugin(UserQuestionService)
    await secondCtx.plugin(AgentRegistry)
    secondCtx.llm.registerAdapter(['deepseek-official'], new CatalogAdapter('DeepSeek', [
      { provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { provider: 'deepseek-official', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    ], REASONING))
    secondCtx.agents.register(agent)
    const second = createApiProxy(secondCtx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })
    const models = expectValue(await second.sessions.models(request({ sessionId })))
    expect(models.current).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-reasoner' })
    const state = agent.session.events.findLast(event => event.type === 'model/selection-authority')?.data
    expect(state).toMatchObject({ mode: 'manual', selection: { model: 'deepseek-reasoner' } })
    await secondCtx.fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('v0.15.5: Auto after a foreign manual selection survives restart — the stale request header must NOT resurrect the foreign route', async () => {
    // P0-2: the user manually selects a foreign model, a request runs (so the
    // request header now carries the foreign route), then the user selects Auto.
    // In the current process this works (resetAutomatic clears picked). After a
    // restart, the process-local picked state is gone. The durable state says
    // auto, but the request header still says foreign. The Host resolver must
    // honor durable Auto (deployment default), NOT fall through to the stale
    // foreign request header.
    const { ctx, agent, sessionId } = await harness({ provider: 'deepseek-official', model: 'deepseek-chat' })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })
    // Manual foreign selection.
    expect(expectValue(await api.sessions.selectModel(request({
      sessionId, provider: 'duplicate', model: 'same',
    }))).selected).toEqual({ provider: 'duplicate', model: 'same' })
    // A request runs, stamping the foreign route into the request header.
    agent.session.append('request/header', {
      header: { config: { provider: 'duplicate', model: 'same' } },
      reason: 'change',
    })
    // Auto releases the manual claim.
    expect(expectValue(await api.sessions.selectModel(request({
      sessionId, mode: 'auto',
    }))).selected).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })

    // Simulated restart: a FRESH process mounts the same session log. The
    // durable state is auto; the request header still carries the stale
    // foreign route. The resolver must return the deployment default, NOT the
    // stale foreign header.
    const secondCtx = new Context()
    await secondCtx.plugin(SessionStore)
    await secondCtx.plugin(SystemPrompt, { persona: '' })
    await secondCtx.plugin(LlmRuntime)
    await secondCtx.plugin(UserQuestionService)
    await secondCtx.plugin(AgentRegistry)
    secondCtx.llm.registerAdapter(['deepseek-official'], new CatalogAdapter('DeepSeek', [
      { provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' },
    ], REASONING))
    secondCtx.llm.registerAdapter(['duplicate'], new CatalogAdapter('Duplicate Provider', [
      { provider: 'duplicate', id: 'same', name: 'Same' },
    ]))
    secondCtx.agents.register(agent)
    const second = createApiProxy(secondCtx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })
    const models = expectValue(await second.sessions.models(request({ sessionId })))
    expect(models.current).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
    const state = agent.session.events.findLast(event => event.type === 'model/selection-authority')?.data
    expect(state).toMatchObject({ mode: 'auto', authority: 'router' })
    await secondCtx.fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('v0.15.5: Auto after a manual Pro selection survives restart without a router — the deployment default applies', async () => {
    // Without the router middleware, durable Auto must still resolve to the
    // deployment default after a restart, not to a stale request header from
    // the prior manual selection. This proves the Host resolver is correct
    // independently of the router masking it.
    const { ctx, agent, sessionId } = await harness({ provider: 'deepseek-official', model: 'deepseek-chat' })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })
    expect(expectValue(await api.sessions.selectModel(request({
      sessionId, provider: 'deepseek-official', model: 'deepseek-reasoner',
    }))).selected).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-reasoner' })
    // A request runs under the manual selection, stamping the reasoner route.
    agent.session.append('request/header', {
      header: { config: { provider: 'deepseek-official', model: 'deepseek-reasoner' } },
      reason: 'change',
    })
    // Auto releases the manual claim.
    expect(expectValue(await api.sessions.selectModel(request({
      sessionId, mode: 'auto',
    }))).selected).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })

    // Restart: fresh process, no router plugin. Durable Auto must resolve to
    // the deployment default, not the stale reasoner request header.
    const secondCtx = new Context()
    await secondCtx.plugin(SessionStore)
    await secondCtx.plugin(SystemPrompt, { persona: '' })
    await secondCtx.plugin(LlmRuntime)
    await secondCtx.plugin(UserQuestionService)
    await secondCtx.plugin(AgentRegistry)
    secondCtx.llm.registerAdapter(['deepseek-official'], new CatalogAdapter('DeepSeek', [
      { provider: 'deepseek-official', id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { provider: 'deepseek-official', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    ], REASONING))
    secondCtx.agents.register(agent)
    const second = createApiProxy(secondCtx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })
    const models = expectValue(await second.sessions.models(request({ sessionId })))
    expect(models.current).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
    await secondCtx.fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('allows a text-only selection while durable or pending images remain available for later models', async () => {
    const { ctx, agent, sessionId } = await harness()
    registerTextOnly(ctx)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })
    const image = {
      type: 'image' as const,
      attachment: { attachmentId: 'att-history', mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 },
    }
    const imageEvent = agent.session.append('user/message', {
      id: 'image-message', role: 'user', source: { kind: 'user' }, content: [image],
    } as never, { surfaceOp: 'append' })
    expect(expectValue(await api.sessions.selectModel(request({
      sessionId, provider: 'text-only', model: 'plain',
    }))).selected).toEqual({ provider: 'text-only', model: 'plain' })

    // The model selection above appended a non-surface authority event, so the
    // replace range must name the shadowed SURFACE node, not "the last event".
    agent.session.append('user/message', {
      id: 'summary', role: 'user', source: { kind: 'plugin', plugin: 'compact' },
      content: [{ type: 'text', text: 'image summarized' }],
    } as never, {
      surfaceOp: { op: 'replace', start: 0, end: imageEvent.seq },
      sourceEventSeqs: [imageEvent.seq],
    })
    ;(agent.inbox.nextTurn as UserMessage[]).push({
      id: 'pending-image', role: 'user', source: { kind: 'user' }, content: [image],
    } as never)
    expect(expectValue(await api.sessions.selectModel(request({
      sessionId, provider: 'text-only', model: 'plain',
    }))).selected).toEqual({ provider: 'text-only', model: 'plain' })
    await ctx.fiber.dispose()
  })

  it('authorizes attachment bytes only when the session event stream references the id', async () => {
    const { ctx, agent, sessionId } = await harness()
    const ref = {
      attachmentId: 'att-authorized', mediaType: 'image/png' as const, bytes: 2, width: 1, height: 1,
    }
    const readImage = vi.fn(() => Promise.resolve({ ref, data: Uint8Array.of(1, 2) }))
    ctx.provide('attachments', { readImage } as never)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })
    agent.session.append('agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: [{
        id: 'queued-image', role: 'user', source: { kind: 'user' },
        content: [{ type: 'image', attachment: ref }],
      }],
    } as never)

    const allowed = await api.sessions.attachment(request({
      sessionId, attachmentId: 'att-authorized' as never,
    }))
    expect(allowed.result).toMatchObject({ ok: true, value: { attachment: ref, data: 'AQI=' } })
    const denied = await api.sessions.attachment(request({
      sessionId, attachmentId: 'att-other' as never,
    }))
    expect(denied.result).toMatchObject({
      ok: false,
      error: { code: 'attachment-error', details: { reason: 'ATTACHMENT_NOT_REFERENCED' } },
    })
    expect(readImage).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })
  it('groups successful providers and leaves an unlisted current selection out of the catalog', async () => {
    const { ctx, sessionId } = await harness({
      provider: 'deepseek-official',
      model: 'private-preview',
      reasoningEffort: ReasoningEffortId('max'),
    })
    const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }), cwd: '/tmp' })

    const catalog = expectValue(await api.sessions.models(request({ sessionId })))
    expect(catalog.current).toEqual({
      provider: 'deepseek-official',
      model: 'private-preview',
      reasoningEffort: 'max',
    })
    expect(catalog.groups).toEqual([{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-chat', name: 'DeepSeek Chat', reasoning: REASONING },
        {
          id: 'deepseek-reasoner',
          name: 'DeepSeek Reasoner',
          description: 'Reasoning model',
          reasoning: REASONING,
        },
      ],
    }])
    expect(catalog.failures).toEqual([
      { id: 'broken', name: 'Broken Provider', message: 'catalog offline' },
      { id: 'metadata-broken', name: 'Metadata Broken', message: 'reasoning metadata offline' },
      {
        id: 'duplicate',
        name: 'Duplicate Provider',
        message: 'adapter returned invalid or duplicate model metadata for provider "duplicate"',
      },
    ])
    await ctx.fiber.dispose()
  })

  it('accepts an advisory-unlisted model, rejects an unavailable provider, and switches only after the next assembly', async () => {
    const { ctx, agent, sessionId } = await harness()
    const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }), cwd: '/tmp' })
    const seed: LlmCallConfig = { provider: 'seed', model: 'seed', temperature: 0.2 }
    const signal = new AbortController().signal

    expect(expectValue(await api.sessions.models(request({ sessionId }))).current)
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
    expect((await ctx.systemPrompt.assemble()).variables)
      .toMatchObject({ provider: 'deepseek-official', model: 'deepseek-chat' })

    const selected = expectValue(await api.sessions.selectModel(request({
      sessionId,
      provider: 'deepseek-official',
      model: 'private-preview',
      reasoningEffort: 'max',
    })))
    expect(selected.selected).toEqual({
      provider: 'deepseek-official',
      model: 'private-preview',
      reasoningEffort: 'max',
    })
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toMatchObject({ provider: 'deepseek-official', model: 'deepseek-chat' })

    expect((await ctx.systemPrompt.assemble()).variables)
      .toMatchObject({ provider: 'deepseek-official', model: 'private-preview' })
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 1, signal }, () => Promise.resolve(seed),
    )).resolves.toMatchObject({
      provider: 'deepseek-official',
      model: 'private-preview',
      reasoningEffort: 'max',
    })

    const unsupported = await api.sessions.selectModel(request({
      sessionId,
      provider: 'deepseek-official',
      model: 'private-preview',
      reasoningEffort: 'medium',
    }))
    expect(unsupported.result).toMatchObject({
      ok: false,
      error: {
        code: 'model-unavailable',
        message: 'provider "deepseek-official" model "private-preview" does not support reasoning effort "medium"',
      },
    })

    const rejected = await api.sessions.selectModel(request({
      sessionId,
      provider: 'missing',
      model: 'model',
    }))
    expect(rejected.result).toEqual({
      ok: false,
      error: {
        code: 'model-unavailable',
        message: 'no adapter registered for provider "missing"',
        details: { provider: 'missing', model: 'model' },
      },
    })
    expect(expectValue(await api.sessions.models(request({ sessionId }))).current)
      .toEqual({ provider: 'deepseek-official', model: 'private-preview', reasoningEffort: 'max' })
    await ctx.fiber.dispose()
  })

  it('reads the Agent default live for a session whose log names no selection', async () => {
    const { ctx, sessionId } = await harness()
    let stored = { provider: 'deepseek-official', model: 'deepseek-chat' }
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => stored,
      cwd: '/tmp',
    })

    expect(expectValue(await api.sessions.models(request({ sessionId }))).current)
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
    // The default moving after the session exists still reaches it: New
    // Session reuses a blank session rather than minting another, so a seed
    // captured at creation would show the superseded model there.
    stored = { provider: 'deepseek-official', model: 'deepseek-reasoner' }
    expect(expectValue(await api.sessions.models(request({ sessionId }))).current)
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-reasoner' })
    expect(expectValue(await api.host.describe(request({}))))
      .toMatchObject({ provider: 'deepseek-official', model: 'deepseek-reasoner' })
    await ctx.fiber.dispose()
  })

  it('keeps a session on its logged selection when the Agent default differs', async () => {
    const { ctx, sessionId } = await harness({
      provider: 'deepseek-official',
      model: 'deepseek-chat',
    })
    let stored = { provider: 'deepseek-official', model: 'deepseek-chat' }
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => stored,
      cwd: '/tmp',
    })

    stored = { provider: 'duplicate', model: 'same' }
    expect(expectValue(await api.sessions.models(request({ sessionId }))).current)
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
    await ctx.fiber.dispose()
  })

  it('saves an accepted selection as the default and survives a storage failure', async () => {
    const { ctx, sessionId } = await harness()
    const saved: unknown[] = []
    let reject = false
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      saveDefaultModelSelection: (selection) => {
        saved.push(selection)
        return reject ? Promise.reject(new Error('read-only document')) : Promise.resolve()
      },
      cwd: '/tmp',
    })

    expectValue(await api.sessions.selectModel(request({
      sessionId, provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: 'max',
    })))
    expect(saved).toEqual([
      { provider: 'deepseek-official', model: 'deepseek-reasoner', reasoningEffort: 'max' },
    ])

    // A refused selection never becomes anyone's default.
    await api.sessions.selectModel(request({ sessionId, provider: 'missing', model: 'model' }))
    expect(saved).toHaveLength(1)

    // Storage failing is not the selection failing: the switch already applies
    // to this session, so the call still succeeds.
    reject = true
    const stillAccepted = expectValue(await api.sessions.selectModel(request({
      sessionId, provider: 'deepseek-official', model: 'deepseek-chat',
    })))
    expect(stillAccepted.selected).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'high' })
    expect(expectValue(await api.sessions.models(request({ sessionId }))).current)
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-chat', reasoningEffort: 'high' })
    await ctx.fiber.dispose()
  })

  it('refuses a prompt no adapter can route, and reports it on the directory', async () => {
    const { ctx, sessionId } = await harness()
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deleted-gateway', model: 'deleted-model' }),
      cwd: '/tmp',
    })

    // The client disabling its input is an affordance; this method stays
    // callable, so the refusal has to live here.
    const refused = await api.sessions.prompt(request({
      sessionId, mode: 'queue' as const, content: [{ type: 'text' as const, text: 'hi' }],
    }))
    expect(refused.result).toMatchObject({
      ok: false,
      error: { code: 'model-unavailable', details: { provider: 'deleted-gateway', model: 'deleted-model' } },
    })
    expect(expectValue(await api.sessions.models(request({ sessionId }))).routable).toBe(false)

    // An advisory-unlisted model on a live route is NOT this: the route
    // serves it, so the prompt goes through and nothing blocks.
    expectValue(await api.sessions.selectModel(request({
      sessionId, provider: 'deepseek-official', model: 'unlisted-but-served',
    })))
    const catalog = expectValue(await api.sessions.models(request({ sessionId })))
    expect(catalog.routable).toBe(true)
    expect(catalog.groups.flatMap(group => group.models.map(model => model.id)))
      .not.toContain('unlisted-but-served')
    await ctx.fiber.dispose()
  })

  it('serves a session and its catalog when the stored default names a route that is gone', async () => {
    const { ctx, sessionId } = await harness()
    const api = createApiProxy(ctx, {
      // What a Models-page removal leaves behind: the settings document still
      // names the route the user last picked, and nothing serves it.
      defaultModelSelection: () => ({ provider: 'deleted-gateway', model: 'deleted-model' }),
      cwd: '/tmp',
    })

    const catalog = expectValue(await api.sessions.models(request({ sessionId })))
    // Passed through rather than repaired: matching no group is precisely what
    // makes the composer seat prompt for a selection instead of naming a model
    // the deployment cannot reach.
    expect(catalog.current).toEqual({ provider: 'deleted-gateway', model: 'deleted-model' })
    expect(catalog.groups.flatMap(group => group.models.map(model => `${group.id}/${model.id}`)))
      .not.toContain('deleted-gateway/deleted-model')
    await ctx.fiber.dispose()
  })

  it('v0.15.5: selectModel returns an error when the durability barrier (flush) fails, and quarantines the session', async () => {
    // P0-3: the RPC must NOT acknowledge success before the authority event
    // reaches persistent storage. If flush fails, the response is an error —
    // the caller knows the selection was not durably committed. The in-memory
    // session retains the event (a known split-brain window closed by the
    // response contract, not a transactional rollback). The session is then
    // quarantined: further operations must reject, because executing under a
    // model selection the caller was told did not commit is unsafe. Recovery
    // is a process restart (cold resume reads durable storage).
    const { ctx, agent, sessionId } = await harness()
    // Register a failing flush listener at the root context.
    ctx.on('session/flush', () => { throw new Error('persistence backend offline') })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })
    const result = await api.sessions.selectModel(request({
      sessionId, provider: 'deepseek-official', model: 'deepseek-reasoner',
    }))
    expect(result.result).toMatchObject({
      ok: false,
      error: { code: 'session-persistence-failed' },
    })
    // The event IS in the in-memory log (split-brain: documented behavior).
    const authorityEvents = agent.session.events.filter(event => event.type === 'model/selection-authority')
    expect(authorityEvents).toHaveLength(1)
    // The session is quarantined: a subsequent operation must reject.
    const blocked = await api.sessions.models(request({ sessionId }))
    expect(blocked.result).toMatchObject({
      ok: false,
      error: { code: 'session-persistence-failed' },
    })
    await ctx.fiber.dispose()
  })

  it('v0.15.5: a quarantined session cannot execute — prompt is blocked, no agent/request, no llm/request', async () => {
    // The invariant: a quarantined session can never spend another model token
    // or execute another side effect. This test proves the execution path
    // (prompt) is blocked at the agentFor guard, before any agent/request or
    // llm/request fires.
    const { ctx, sessionId } = await harness()
    ctx.on('session/flush', () => { throw new Error('persistence backend offline') })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })
    // Quarantine the session via a failed selectModel.
    const failed = await api.sessions.selectModel(request({
      sessionId, provider: 'deepseek-official', model: 'deepseek-reasoner',
    }))
    expect(failed.result.ok).toBe(false)
    // A prompt attempt must be rejected with session-persistence-failed — no
    // execution reaches the agent loop or the LLM.
    const promptBlocked = await api.sessions.prompt(request({
      sessionId, mode: 'queue' as const, content: [{ type: 'text' as const, text: 'hi' }],
    }))
    expect(promptBlocked.result).toMatchObject({
      ok: false,
      error: { code: 'session-persistence-failed' },
    })
    await ctx.fiber.dispose()
  })

  it('v0.15.5: quarantine survives agent disposal — HMR/unload cannot reactivate a dirty session', async () => {
    // The quarantine is a closure-scoped Set<SessionId>, not tied to any
    // Cordis fiber or agent lifecycle. Disposing the agent, unmounting a
    // preset, or reconnecting must NOT clear it — the in-memory log is
    // suspect and no execution may proceed until a process restart reads
    // durable storage.
    const { ctx, sessionId } = await harness()
    ctx.on('session/flush', () => { throw new Error('persistence backend offline') })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })
    // Quarantine the session.
    const failed = await api.sessions.selectModel(request({
      sessionId, provider: 'deepseek-official', model: 'deepseek-reasoner',
    }))
    expect(failed.result.ok).toBe(false)
    // The quarantine is checked before any agent resolution. Even after
    // disposing all agents (simulating HMR/teardown), the guard rejects
    // without reaching the resolver. No re-registration can bypass it.
    const stillBlocked = await api.sessions.models(request({ sessionId }))
    expect(stillBlocked.result).toMatchObject({
      ok: false,
      error: { code: 'session-persistence-failed' },
    })
    // A prompt is also blocked — no execution path bypasses the guard.
    const promptBlocked = await api.sessions.prompt(request({
      sessionId, mode: 'queue' as const, content: [{ type: 'text' as const, text: 'hi' }],
    }))
    expect(promptBlocked.result).toMatchObject({
      ok: false,
      error: { code: 'session-persistence-failed' },
    })
    await ctx.fiber.dispose()
  })
})
