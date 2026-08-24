import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { DeepSeekTokenizerEstimator, registerDeepSeekTokenizerEstimator, createDeepSeekTokenizerBackend } from '@deepseek-ai/dsh-llm-deepseek'
import type { TokenizerBackend } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'

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

describe('DeepSeekTokenizerEstimator', () => {
  it('reports precision: tokenizer when a tokenizer backend is supplied', async () => {
    const backend = mockBackend(text => text.length)
    const estimator = new DeepSeekTokenizerEstimator(backend)

    const estimate = await estimator.estimateInput(mockRequest('hello world'))
    expect(estimate.precision).toBe('tokenizer')
    expect(estimate.source).toBe('estimated')
    expect(estimate.estimator.id).toBe('deepseek-official-tokenizer')
    expect(estimate.estimator.version).toBe('1')
    expect(estimate.tokens).toBe('hello world'.length)
  })

  it('throws when no tokenizer backend is available so callers fall back to generic', async () => {
    const estimator = new DeepSeekTokenizerEstimator()

    await expect(estimator.estimateInput(mockRequest('hello'))).rejects.toThrow(
      'deepseek-tokenizer: no tokenizer backend available',
    )
  })

  it('does not hardcode model capacity; capacity comes from the registry', async () => {
    const backend = mockBackend(() => 100)
    const estimator = new DeepSeekTokenizerEstimator(backend)

    const estimate = await estimator.estimateInput(mockRequest('test'))
    expect(estimate.tokens).toBe(100)
    expect((estimate as unknown as Record<string, unknown>).contextWindow).toBeUndefined()
  })

  it('supports only deepseek-v4-flash and deepseek-v4-pro', () => {
    const backend = mockBackend(text => text.length)
    const estimator = new DeepSeekTokenizerEstimator(backend)
    expect(estimator.supports('deepseek-v4-flash')).toBe(true)
    expect(estimator.supports('deepseek-v4-pro')).toBe(true)
    expect(estimator.supports('deepseek-v4-flash-vision-exp')).toBe(false)
    expect(estimator.supports('gpt-4')).toBe(false)
  })

  it('registerDeepSeekTokenizerEstimator returns undefined when no backend is supplied', () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const result = registerDeepSeekTokenizerEstimator(ctx)
    expect(result).toBeUndefined()
  })

  it('registerDeepSeekTokenizerEstimator registers the DeepSeek estimator with the resolver', async () => {
    const ctx = new Context()
    new TokenMeter(ctx)
    const backend = mockBackend(text => text.length * 2)
    const estimator = registerDeepSeekTokenizerEstimator(ctx, backend)
    expect(estimator).toBeDefined()

    const req = mockRequest('abc')
    const result = await ctx.tokenEstimator.estimateInput({
      provider: req.provider,
      model: req.model,
      request: req,
    })
    expect(result.available).toBe(true)
    if (result.available) {
      expect(result.estimate.precision).toBe('tokenizer')
      expect(result.estimate.estimator.id).toBe('deepseek-official-tokenizer')
      expect(result.estimate.tokens).toBe(6)
    }
  })

  it('createDeepSeekTokenizerBackend returns undefined when the tokenizer package is not installed', async () => {
    const backend = await createDeepSeekTokenizerBackend()
    expect(backend).toBeUndefined()
  })
})
