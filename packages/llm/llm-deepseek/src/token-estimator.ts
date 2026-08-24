/**
 * DeepSeek-specific token estimator using an offline tokenizer backend.
 *
 * The estimator implements `ProviderTokenEstimator` and registers with the
 * `TokenEstimatorResolver` rather than owning the `tokenEstimator` service
 * name. Only a real `TokenizerBackend` earns `precision: 'tokenizer'`; an
 * arbitrary callback does not.
 *
 * The tokenizer estimate remains an estimate until compared with returned
 * `prompt_tokens`. Actual provider-returned usage is authoritative for
 * billing and economics.
 *
 * @module @deepseek-ai/dsh-llm-deepseek/token-estimator
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  GenerateOptions,
  TokenEstimate,
  EstimatorIdentity,
  EstimatePrecision,
  ProviderTokenEstimator,
  TokenizerBackend,
} from '@deepseek-ai/dsh-llm'

/** Estimator identity for the DeepSeek tokenizer estimator. */
const DEEPSEEK_TOKENIZER_IDENTITY: EstimatorIdentity = {
  id: 'deepseek-tokenizer',
  version: '1',
}

/** DeepSeek models supported by this estimator. */
const SUPPORTED_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro'])

/**
 * DeepSeek token estimator backed by a real tokenizer.
 *
 * When a `TokenizerBackend` is supplied, the estimator reports
 * `precision: 'tokenizer'` and counts input tokens by tokenizing the
 * assembled request text. When no backend is supplied, `estimateInput`
 * throws so the resolver falls back to the generic heuristic estimator.
 *
 * Model capacity is not hardcoded here; the caller passes the context window
 * from the model registry.
 */
export class DeepSeekTokenizerEstimator implements ProviderTokenEstimator {
  readonly provider = 'deepseek-official'
  readonly identity = DEEPSEEK_TOKENIZER_IDENTITY
  readonly precision: EstimatePrecision = 'tokenizer'

  private readonly backend: TokenizerBackend | undefined

  constructor(backend?: TokenizerBackend) {
    this.backend = backend
  }

  supports(model: string): boolean {
    return SUPPORTED_MODELS.has(model)
  }

  async estimateInput(request: GenerateOptions): Promise<TokenEstimate> {
    if (this.backend === undefined) {
      throw new Error('deepseek-tokenizer: no tokenizer backend available')
    }
    const text = serializeRequestText(request)
    const tokens = await this.backend.countTokens(text)
    return {
      tokens,
      source: 'estimated',
      estimator: this.identity,
      precision: this.precision,
    }
  }
}

/**
 * Serialize a request into one text string for tokenizer input.
 *
 * Concatenates system prompt, message content, reasoning content, tool calls,
 * tool results, and tool schema JSON. This does not reproduce DeepSeek's
 * exact prompt framing; the tokenizer count is an estimate of input tokens,
 * not a guarantee of the provider's `prompt_tokens`.
 */
function serializeRequestText(request: GenerateOptions): string {
  const parts: string[] = []
  if (request.system !== undefined) parts.push(request.system)
  for (const message of request.messages) {
    if (typeof message.content === 'string') {
      parts.push(message.content)
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'text') parts.push(block.text)
        else if (block.type === 'reasoning') parts.push(block.text)
        else if (block.type === 'tool-call') parts.push(block.arguments)
        else if (block.type === 'tool-result') {
          for (const inner of block.content) {
            if (inner.type === 'text') parts.push(inner.text)
          }
        }
      }
    }
  }
  if (request.tools !== undefined) {
    for (const tool of request.tools) parts.push(JSON.stringify(tool))
  }
  return parts.join('\n')
}

/**
 * Register a DeepSeek tokenizer estimator with the `TokenEstimatorResolver`
 * on the Context. When no backend is supplied, no provider estimator is
 * registered and the generic fallback remains active.
 *
 * @param ctx - the Cordis Context carrying the `tokenEstimator` resolver.
 * @param backend - optional tokenizer backend for precise estimation.
 * @returns the registered estimator, or `undefined` when no backend is supplied.
 */
export function registerDeepSeekTokenizerEstimator(
  ctx: Context,
  backend?: TokenizerBackend,
): DeepSeekTokenizerEstimator | undefined {
  if (backend === undefined) return undefined
  const estimator = new DeepSeekTokenizerEstimator(backend)
  const resolver = ctx.tokenEstimator
  if (resolver instanceof Object && 'registerProvider' in resolver) {
    ;(resolver as { registerProvider: (e: ProviderTokenEstimator) => () => void }).registerProvider(estimator)
  }
  return estimator
}
