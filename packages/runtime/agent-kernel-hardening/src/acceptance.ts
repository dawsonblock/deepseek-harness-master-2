import type { AgentKernelMetrics, GateResult, NumericGate, QualificationResult } from './types.js'

function numericMetric(metrics: AgentKernelMetrics, name: keyof AgentKernelMetrics): number | null {
  const value = metrics[name]
  return typeof value === 'number' ? value : null
}

export function qualifyMetrics(
  metrics: AgentKernelMetrics,
  gates: readonly NumericGate[],
): QualificationResult {
  const results: GateResult[] = gates.map(gate => {
    const actual = numericMetric(metrics, gate.metric)
    const passed = actual !== null && (
      gate.comparator === 'gte' ? actual >= gate.threshold
        : gate.comparator === 'lte' ? actual <= gate.threshold
          : actual === gate.threshold
    )
    return {
      metric: gate.metric, comparator: gate.comparator, threshold: gate.threshold,
      actual, passed, required: gate.required !== false,
    }
  })
  return { passed: results.every(result => !result.required || result.passed), gates: results }
}

export const DEFAULT_QUALITY_GATES: readonly NumericGate[] = [
  { metric: 'unmatchedToolCalls', comparator: 'eq', threshold: 0 },
  { metric: 'toolErrors', comparator: 'lte', threshold: 0 },
  { metric: 'turnsErrored', comparator: 'lte', threshold: 0 },
  { metric: 'turnsMaxTokens', comparator: 'lte', threshold: 0 },
  { metric: 'compactionsFailed', comparator: 'lte', threshold: 0 },
  { metric: 'cacheHitRatio', comparator: 'gte', threshold: 0.5, required: false },
  { metric: 'requestPrefixStabilityRatio', comparator: 'gte', threshold: 0.9, required: false },
  { metric: 'orchestrationOverheadRatio', comparator: 'lte', threshold: 0.15, required: false },
  { metric: 'p95ReasoningContextRatio', comparator: 'lte', threshold: 0.5, required: false },
  { metric: 'terminalProtocolFallbackRate', comparator: 'lte', threshold: 0.05, required: false },
  { metric: 'backpressureDrops', comparator: 'eq', threshold: 0, required: false },
]


/**
 * v0.14 performance/resource qualification gates. Unlike the compatibility-
 * oriented defaults above, these are required when a benchmark claims runtime
 * performance qualification and therefore require first-party telemetry.
 */
export const RUNTIME_PERFORMANCE_GATES: readonly NumericGate[] = [
  { metric: 'orchestrationOverheadRatio', comparator: 'lte', threshold: 0.15 },
  { metric: 'p95ReasoningContextRatio', comparator: 'lte', threshold: 0.5 },
  { metric: 'terminalProtocolFallbackRate', comparator: 'lte', threshold: 0.05 },
  { metric: 'backpressureDrops', comparator: 'eq', threshold: 0 },
]
