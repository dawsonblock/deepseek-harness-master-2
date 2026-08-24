/**
 * Translate DeepSeek SSE payloads with one stateful harness block per content, reasoning, or tool
 * call index. An empty initial reasoning delta does not open a block. Finish reason and the latest
 * usage are deferred until `[DONE]`, covering both finish-attached and trailing usage-only shapes
 * while ensuring no chunk follows `finish`.
 *
 * Translate DeepSeek wire chunks into the harness `StreamChunk` protocol.
 * @module dsh-llm-deepseek/translate
 */

import { CallId, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage, UsageDiagnostic } from '@deepseek-ai/dsh-llm'
import { DONE } from './sse.ts'
import type { WireChunk, WireUsage } from './types.ts'

/** One open block under assembly. */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  /** tool-call only */
  callId?: string
  name?: string
}

/**
 * Map the wire finish_reason vocabulary to the harness FinishReason.
 * @param reason - the wire `finish_reason` string.
 * @returns the mapped reason; unrecognized values (content_filter, …) become `{kind: 'error'}` with the uppercased value as `code`.
 */
export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default:
      // content_filter, insufficient_system_resource, future additions.
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
      }
  }
}

/** Stable diagnostic code emitted when provider usage fields are internally inconsistent. */
export const TOKEN_USAGE_INCONSISTENT = 'TOKEN_USAGE_INCONSISTENT'

/**
 * Validate provider-side invariants without rewriting the provider's values.
 * Collects structured diagnostics when DeepSeek's reported buckets do not sum
 * correctly. Raw values are preserved in the returned `TokenUsage` regardless
 * — provider billing data wins over inferred arithmetic.
 *
 * Invariants checked:
 * - `prompt_cache_hit_tokens + prompt_cache_miss_tokens === prompt_tokens`
 * - `prompt_tokens + completion_tokens === total_tokens`
 * - `inputTokens === cacheMissTokens` (canonical disjoint invariant)
 */
function validateUsageInvariants(usage: WireUsage, inputTokens: number, cacheMiss: number | undefined): UsageDiagnostic[] {
  const diagnostics: UsageDiagnostic[] = []
  const hit = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
  if (hit !== undefined && cacheMiss !== undefined && hit + cacheMiss !== usage.prompt_tokens) {
    diagnostics.push({
      code: TOKEN_USAGE_INCONSISTENT,
      invariant: 'prompt-cache-decomposition',
      message: `prompt_cache_hit_tokens (${hit}) + prompt_cache_miss_tokens (${cacheMiss}) !== prompt_tokens (${usage.prompt_tokens})`,
      observed: { hit, cacheMiss, promptTokens: usage.prompt_tokens },
    })
  }
  if (usage.total_tokens !== undefined && usage.prompt_tokens + usage.completion_tokens !== usage.total_tokens) {
    diagnostics.push({
      code: TOKEN_USAGE_INCONSISTENT,
      invariant: 'total-token-arithmetic',
      message: `prompt_tokens (${usage.prompt_tokens}) + completion_tokens (${usage.completion_tokens}) !== total_tokens (${usage.total_tokens})`,
      observed: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens },
    })
  }
  if (cacheMiss !== undefined && inputTokens !== cacheMiss) {
    diagnostics.push({
      code: TOKEN_USAGE_INCONSISTENT,
      invariant: 'canonical-cache-miss',
      message: `canonical inputTokens (${inputTokens}) !== cacheMissTokens (${cacheMiss})`,
      observed: { inputTokens, cacheMissTokens: cacheMiss },
    })
  }
  return diagnostics
}

/**
 * Map wire usage fields. DeepSeek's `prompt_tokens` INCLUDES cache hits
 * (`prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`,
 * api/create-chat-completion); the harness TokenUsage convention is
 * DISJOINT counts, so cache reads are subtracted out of `inputTokens`.
 * `cacheMissTokens` makes the disjoint split explicit: it equals `inputTokens`
 * when the provider reports cache hit/miss separately. Provider invariants are
 * validated without rewriting the provider's values; raw numbers are preserved
 * even when an invariant fails.
 * @param usage - wire usage from the finish chunk or the trailing usage-only chunk.
 * @param requestId - provider response id from the carrying chunk, when present.
 * @returns disjoint harness counts; cache/reasoning/total/provenance fields present only when the wire reported them.
 */
/** Result of mapping wire usage to canonical TokenUsage with diagnostics. */
export interface MappedUsage {
  usage: TokenUsage
  diagnostics: readonly UsageDiagnostic[]
}

export function mapUsage(usage: WireUsage, requestId?: string): MappedUsage {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
  const cacheMiss = usage.prompt_cache_miss_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  const inputTokens = usage.prompt_tokens - (cacheRead ?? 0)
  const diagnostics = validateUsageInvariants(usage, inputTokens, cacheMiss)
  return {
    usage: {
      inputTokens,
      outputTokens: usage.completion_tokens,
      source: 'provider',
      ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
      ...cacheMiss !== undefined ? { cacheMissTokens: cacheMiss } : {},
      ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
      ...usage.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {},
      ...requestId !== undefined ? { requestId } : {},
    },
    diagnostics,
  }
}

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: CallId(block.callId ?? ''),
      name: block.name ?? '',
      arguments: block.text,
    }
  }
}

/**
 * Consume SSE data payloads (ending with `[DONE]`) and yield StreamChunks.
 * Malformed JSON payloads abort the stream with `MALFORMED_RESPONSE`.
 * @param payloads - SSE data payloads from {@link parseSse}, `[DONE]`-terminated.
 * @returns deltas as they arrive; `block-end`s, `usage`, and `finish` are all deferred to the `[DONE]` sentinel.
 *   A `stop` (or absent) finish with no opened blocks is a degenerate provider completion and maps to an
 *   `EMPTY_RESPONSE` error finish instead of a successful empty message.
 */
export async function* translate(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  let pendingFinish: FinishReason | undefined
  let pendingUsage: TokenUsage | undefined
  let pendingDiagnostics: readonly UsageDiagnostic[] = []

  function open(kind: OpenBlock['kind']): OpenBlock {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }

  for await (const payload of payloads) {
    if (payload === DONE) {
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      if (pendingUsage) yield { type: 'usage', usage: pendingUsage, ...pendingDiagnostics.length > 0 ? { diagnostics: pendingDiagnostics } : {} }
      const reason = pendingFinish ?? { kind: 'stop' as const }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? {
            kind: 'error',
            failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
          }
          : reason,
      }
      return
    }

    let chunk: WireChunk
    try {
      chunk = JSON.parse(payload) as WireChunk
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta

      // Reasoning first: thinking mode interleaves it before text. The
      // empty-string first chunk must not open a block.
      const reasoning = delta?.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }

      const content = delta?.content
      if (typeof content === 'string' && content.length > 0) {
        if (!textBlock) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }

      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index)
        if (!block) {
          block = open('tool-call')
          toolBlocks.set(call.index, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        if (call.id !== undefined) block.callId = call.id
        if (call.function?.name !== undefined) block.name = call.function.name
        const fragment = call.function?.arguments ?? ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: CallId(block.callId ?? ''),
          ...block.name !== undefined ? { name: block.name } : {},
          argumentsDelta: fragment,
        }
      }

      if (typeof choice.finish_reason === 'string') {
        pendingFinish = mapFinishReason(choice.finish_reason)
      }
    }

    // Usage may arrive attached to the finish chunk or as a trailing
    // usage-only chunk — keep the latest. The chunk id is the provider
    // response id, carried as requestId for billing correlation.
    if (chunk.usage) {
      const mapped = mapUsage(chunk.usage, chunk.id)
      pendingUsage = mapped.usage
      pendingDiagnostics = mapped.diagnostics
    }
  }

  // parseSse guarantees the [DONE] sentinel (or throws); reaching here means
  // the payload source violated that contract.
  throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED')
}
