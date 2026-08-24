import type { AblationScore, AblationVariant, AblationWeights, AgentKernelMetrics } from './types.js'

const defaults: Required<AblationWeights> = {
  cacheHitRatio: 1.0,
  toolErrorRate: 4.0,
  unmatchedToolRate: 6.0,
  stepLatencyMs: 0.0005,
  successRate: 5.0,
  maxTokenRate: 2.0,
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}

/**
 * Heuristic dashboard score only. For architecture decisions use
 * summarizeVariant()/comparePairedVariants() over task-level observations.
 */
export function scoreMetrics(metrics: AgentKernelMetrics, weights: AblationWeights = {}): number {
  const w = { ...defaults, ...weights }
  const cache = metrics.cacheHitRatio ?? 0
  const toolErrorRate = rate(metrics.toolErrors, metrics.toolCalls)
  const unmatchedRate = rate(metrics.unmatchedToolCalls, metrics.toolCalls)
  const successRate = rate(metrics.turnsSucceeded, metrics.turnsStarted)
  const maxTokenRate = rate(metrics.turnsMaxTokens, metrics.turnsStarted)
  const latency = metrics.averageStepLatencyMs ?? 0
  return cache * w.cacheHitRatio
    + successRate * w.successRate
    - maxTokenRate * w.maxTokenRate
    - toolErrorRate * w.toolErrorRate
    - unmatchedRate * w.unmatchedToolRate
    - latency * w.stepLatencyMs
}

export function rankAblations(
  variants: readonly AblationVariant[],
  weights: AblationWeights = {},
): readonly AblationScore[] {
  return variants
    .map(variant => ({ name: variant.name, score: scoreMetrics(variant.metrics, weights), metrics: variant.metrics }))
    .sort((a, b) => b.score - a.score)
}
