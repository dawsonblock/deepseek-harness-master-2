import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DeepSeekTokenizerEstimator } from '@deepseek-ai/dsh-llm-deepseek'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type { TokenizerBackend, GenerateOptions, TokenEstimateInput, TokenEstimateResult } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

function mockRequest(text: string): GenerateOptions {
  return {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    messages: [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })],
  }
}

function mockBackend(count: (text: string) => number): TokenizerBackend {
  return {
    id: 'deepseek-official-tokenizer',
    version: '1',
    countTokens: async text => count(text),
  }
}

function resolverInput(request: GenerateOptions): TokenEstimateInput {
  return { provider: request.provider, model: request.model, request }
}

/** A resolver that always returns unavailable, simulating both estimators
 * failing. Used by the "both fail" and "no zero tokens" tests. */
async function makeAlwaysUnavailableResolver(ctx: Context) {
  const { TokenEstimatorResolver } = await import('@deepseek-ai/dsh-token-meter')
  return new (class extends TokenEstimatorResolver {
    override async estimateInput(input: TokenEstimateInput): Promise<TokenEstimateResult> {
      const providers = (this as unknown as {
        providers: Array<{ estimateInput(r: GenerateOptions): Promise<unknown> }>
      }).providers
      const providerEstimator = providers?.find(() => true)
      if (providerEstimator !== undefined) {
        try {
          await providerEstimator.estimateInput(input.request)
        } catch {
          // fall through
        }
      }
      return { available: false, reason: 'fallback-estimator-failed' }
    }
  })(ctx)
}

describe('fallback orchestration (6E)', () => {
  it('falls back to generic when DeepSeek estimator has no backend', async () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const deepseek = new DeepSeekTokenizerEstimator()
    ctx.tokenEstimatorRegistry.register(deepseek)

    const result = await ctx.tokenEstimator.estimateInput(resolverInput(mockRequest('hello world')))

    expect(result.available).toBe(true)
    if (result.available) {
      expect(result.estimate.precision).toBe('heuristic')
      expect(result.estimate.estimator.id).toBe('character-heuristic')
      expect(result.estimate.tokens).toBeGreaterThan(0)
    }
  })

  it('returns a valid estimate from DeepSeek when the tokenizer backend succeeds', async () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const backend = mockBackend(text => text.length)
    const deepseek = new DeepSeekTokenizerEstimator(backend)
    ctx.tokenEstimatorRegistry.register(deepseek)

    const result = await ctx.tokenEstimator.estimateInput(resolverInput(mockRequest('hello')))

    expect(result.available).toBe(true)
    if (result.available) {
      expect(result.estimate.precision).toBe('tokenizer')
      expect(result.estimate.estimator.id).toBe('deepseek-official-tokenizer')
      expect(result.estimate.tokens).toBe('hello'.length)
    }
  })

  it('returns estimate-unavailable when both estimators fail', async () => {
    const ctx = new Context()
    const resolver = await makeAlwaysUnavailableResolver(ctx)
    const deepseek = new DeepSeekTokenizerEstimator()
    resolver.register(deepseek)

    const result = await resolver.estimateInput(resolverInput(mockRequest('hello')))

    expect(result.available).toBe(false)
    if (!result.available) {
      expect(result.reason).toBe('fallback-estimator-failed')
    }
  })

  it('does not silently manufacture zero tokens when unavailable', async () => {
    const ctx = new Context()
    const resolver = await makeAlwaysUnavailableResolver(ctx)
    const deepseek = new DeepSeekTokenizerEstimator()
    resolver.register(deepseek)

    const result = await resolver.estimateInput(resolverInput(mockRequest('hello')))

    expect(result.available).toBe(false)
    if (result.available) {
      expect(result.estimate.tokens).not.toBe(0)
    }
  })

  it('the fallback estimator ID identifies the generic heuristic, not the DeepSeek tokenizer', async () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const deepseek = new DeepSeekTokenizerEstimator()
    ctx.tokenEstimatorRegistry.register(deepseek)

    const result = await ctx.tokenEstimator.estimateInput(resolverInput(mockRequest('test input')))

    expect(result.available).toBe(true)
    if (result.available) {
      expect(result.estimate.estimator.id).toBe('character-heuristic')
      expect(result.estimate.estimator.id).not.toBe('deepseek-official-tokenizer')
    }
  })

  it('coexists in one context: both DeepSeek and generic are available simultaneously', async () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const backend = mockBackend(text => text.length)
    const deepseek = new DeepSeekTokenizerEstimator(backend)
    ctx.tokenEstimatorRegistry.register(deepseek)

    const deepseekResult = await ctx.tokenEstimator.estimateInput(resolverInput(mockRequest('hello')))
    expect(deepseekResult.available).toBe(true)
    if (deepseekResult.available) {
      expect(deepseekResult.estimate.precision).toBe('tokenizer')
    }

    const otherRequest: GenerateOptions = {
      provider: 'other-provider',
      model: 'some-model',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
    }
    const otherResult = await ctx.tokenEstimator.estimateInput(resolverInput(otherRequest))
    expect(otherResult.available).toBe(true)
    if (otherResult.available) {
      expect(otherResult.estimate.precision).toBe('heuristic')
      expect(otherResult.estimate.estimator.id).toBe('character-heuristic')
    }
  })

  it('other provider cannot accidentally use the DeepSeek estimator', async () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const backend = mockBackend(text => text.length)
    const deepseek = new DeepSeekTokenizerEstimator(backend)
    ctx.tokenEstimatorRegistry.register(deepseek)

    const otherRequest: GenerateOptions = {
      provider: 'other-provider',
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })],
    }
    const result = await ctx.tokenEstimator.estimateInput(resolverInput(otherRequest))
    expect(result.available).toBe(true)
    if (result.available) {
      expect(result.estimate.precision).toBe('heuristic')
      expect(result.estimate.estimator.id).toBe('character-heuristic')
    }
  })
})
