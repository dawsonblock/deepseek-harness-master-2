/**
 * Derived aggregation functions over durable `model/usage` records.
 *
 * These are pure folds over immutable session events — no mutable session
 * counters. Each function takes the raw `model/usage` events and produces
 * derived views by session, turn, step, model, or routing decision.
 *
 * @module @deepseek-ai/dsh-token-meter/aggregate
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ModelPricing } from './pricing.ts'
import { calculateCost, lookupPricingAt } from './pricing.ts'

/** One `model/usage` event projected to its accounting-relevant fields. */
export interface ModelUsageRecord {
  sessionId: string
  /** Provider billing instant from the durable event envelope. */
  time: number
  turn: number
  step: number
  attempt: number
  provider: string
  model: string
  requestId?: string
  routingDecisionId?: string
  usage: TokenUsage
}

/** Aggregated totals for one grouping key. */
export interface UsageTotals {
  /** Number of paid attempts in this group. */
  requests: number
  /** Sum of uncached input tokens. */
  inputTokens: number
  /** Sum of cache-hit input tokens. */
  cacheReadTokens: number
  /** Sum of cache-miss input tokens. */
  cacheMissTokens: number
  /** Sum of output tokens. */
  outputTokens: number
  /** Sum of reasoning tokens. */
  reasoningTokens: number
  /** Sum of provider-reported total tokens. */
  totalTokens: number
  /** Cache hit rate: `cacheReadTokens / (cacheReadTokens + cacheMissTokens)`, or 0 when no input. */
  cacheHitRate: number
  /** Sum of calculated costs, when pricing was available. */
  costUsd: number
  /** Number of attempts with exact cost vs conservative-estimate. */
  exactCosts: number
  estimatedCosts: number
}

/** Empty totals for fold initialization. */
const EMPTY_TOTALS: UsageTotals = {
  requests: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheMissTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  cacheHitRate: 0,
  costUsd: 0,
  exactCosts: 0,
  estimatedCosts: 0,
}

/** Extract `model/usage` records from a session event stream. */
export function extractUsageRecords(events: readonly SessionEvent[], sessionId: string): readonly ModelUsageRecord[] {
  const records: ModelUsageRecord[] = []
  for (const event of events) {
    if (event.type === 'model/usage') {
      const data = event.data
      records.push({
        sessionId,
        time: event.time,
        turn: data.turn,
        step: data.step,
        attempt: data.attempt,
        provider: data.provider,
        model: data.model,
        ...data.usage.requestId === undefined ? {} : { requestId: data.usage.requestId },
        ...data.routingDecisionId === undefined ? {} : { routingDecisionId: data.routingDecisionId },
        usage: data.usage,
      })
    }
  }
  return records
}

/** Accumulate one record's usage into a totals object. */
function accumulate(totals: UsageTotals, record: ModelUsageRecord, pricingRegistry?: readonly ModelPricing[]): void {
  const { usage } = record
  totals.requests += 1
  totals.inputTokens += usage.inputTokens
  totals.cacheReadTokens += usage.cacheReadTokens ?? 0
  totals.cacheMissTokens += usage.cacheMissTokens ?? 0
  totals.outputTokens += usage.outputTokens
  totals.reasoningTokens += usage.reasoningTokens ?? 0
  totals.totalTokens += usage.totalTokens ?? 0
  if (pricingRegistry !== undefined) {
    const pricing = lookupPricingAt(pricingRegistry, record.provider, record.model, new Date(record.time))
    if (pricing !== undefined) {
      const cost = calculateCost(usage, pricing)
      totals.costUsd += cost.amount
      if (cost.confidence === 'exact') totals.exactCosts += 1
      else totals.estimatedCosts += 1
    }
  }
}

/** Finalize cache hit rate after accumulation. */
function finalizeCacheHitRate(totals: UsageTotals): void {
  const totalInput = totals.cacheReadTokens + totals.cacheMissTokens
  totals.cacheHitRate = totalInput === 0 ? 0 : totals.cacheReadTokens / totalInput
}

/** Aggregate usage records by session (all records in one totals object). */
export function usageBySession(records: readonly ModelUsageRecord[], pricingRegistry?: readonly ModelPricing[]): UsageTotals {
  const totals = { ...EMPTY_TOTALS }
  for (const record of records) accumulate(totals, record, pricingRegistry)
  finalizeCacheHitRate(totals)
  return totals
}

/** Aggregate usage records by turn. */
export function usageByTurn(records: readonly ModelUsageRecord[], pricingRegistry?: readonly ModelPricing[]): Map<number, UsageTotals> {
  const byTurn = new Map<number, UsageTotals>()
  for (const record of records) {
    let totals = byTurn.get(record.turn)
    if (totals === undefined) {
      totals = { ...EMPTY_TOTALS }
      byTurn.set(record.turn, totals)
    }
    accumulate(totals, record, pricingRegistry)
  }
  for (const totals of byTurn.values()) finalizeCacheHitRate(totals)
  return byTurn
}

/** Aggregate usage records by model (provider/model). */
export function usageByModel(records: readonly ModelUsageRecord[], pricingRegistry?: readonly ModelPricing[]): Map<string, UsageTotals> {
  const byModel = new Map<string, UsageTotals>()
  for (const record of records) {
    const key = `${record.provider}/${record.model}`
    let totals = byModel.get(key)
    if (totals === undefined) {
      totals = { ...EMPTY_TOTALS }
      byModel.set(key, totals)
    }
    accumulate(totals, record, pricingRegistry)
  }
  for (const totals of byModel.values()) finalizeCacheHitRate(totals)
  return byModel
}

/** Aggregate usage records by routing decision id. */
export function usageByRoutingDecision(
  records: readonly ModelUsageRecord[],
  pricingRegistry?: readonly ModelPricing[],
): Map<string, UsageTotals> {
  const byDecision = new Map<string, UsageTotals>()
  for (const record of records) {
    if (record.routingDecisionId === undefined) continue
    let totals = byDecision.get(record.routingDecisionId)
    if (totals === undefined) {
      totals = { ...EMPTY_TOTALS }
      byDecision.set(record.routingDecisionId, totals)
    }
    accumulate(totals, record, pricingRegistry)
  }
  for (const totals of byDecision.values()) finalizeCacheHitRate(totals)
  return byDecision
}

/** One routing decision's full accounting view: usage + cost + model selection. */
export interface RoutingDecisionAccounting {
  routingDecisionId: string
  /** Models used across all attempts under this decision. */
  models: readonly string[]
  /** Number of paid attempts (including retries). */
  attempts: number
  /** Aggregated token usage. */
  totals: UsageTotals
}

/** Aggregate usage records by routing decision with model list. */
export function routingDecisionAccounting(
  records: readonly ModelUsageRecord[],
  pricingRegistry?: readonly ModelPricing[],
): Map<string, RoutingDecisionAccounting> {
  const byDecision = new Map<string, { models: Set<string>; totals: UsageTotals }>()
  for (const record of records) {
    if (record.routingDecisionId === undefined) continue
    let entry = byDecision.get(record.routingDecisionId)
    if (entry === undefined) {
      entry = { models: new Set<string>(), totals: { ...EMPTY_TOTALS } }
      byDecision.set(record.routingDecisionId, entry)
    }
    entry.models.add(`${record.provider}/${record.model}`)
    accumulate(entry.totals, record, pricingRegistry)
  }
  const result = new Map<string, RoutingDecisionAccounting>()
  for (const [id, entry] of byDecision) {
    finalizeCacheHitRate(entry.totals)
    result.set(id, {
      routingDecisionId: id,
      models: Object.freeze([...entry.models]),
      attempts: entry.totals.requests,
      totals: entry.totals,
    })
  }
  return result
}
