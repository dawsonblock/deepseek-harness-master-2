/** Minimal persisted-session envelope consumed by the hardening projections.
 *
 * Payloads deliberately remain `unknown`: the canonical payload vocabulary is
 * owned by @deepseek-ai/dsh-session. Projection code narrows the real durable
 * shapes at the point of use rather than maintaining a second event schema.
 */
export interface KernelEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly ignorable?: true
}

export type ToolRecoveryState = 'not-started' | 'outcome-unknown'

export interface UnmatchedToolCall {
  readonly callId: string
  readonly name: string
  readonly turn: number
  readonly step: number
  readonly seq: number
  readonly state: ToolRecoveryState
  readonly recoveryMode?: 'idempotent' | 'reconcile'
  readonly operationKey?: string
  readonly safeToRetry: boolean
  readonly requiresReconciliation: boolean
}

export type ReconciliationResult =
  | { readonly state: 'completed'; readonly evidence?: string }
  | { readonly state: 'not-executed'; readonly evidence?: string }
  | { readonly state: 'unknown'; readonly evidence?: string }

export interface ToolRecoveryPolicy {
  /** True only when repeating the operation has the same externally-visible effect. */
  readonly idempotent?: boolean
  /** Optional deployment-owned external-state check for ambiguous side effects. */
  readonly reconcile?: (call: UnmatchedToolCall) => Promise<ReconciliationResult>
}

export interface RecoveryPolicyMap {
  readonly [toolName: string]: ToolRecoveryPolicy | undefined
}

export interface AgentKernelMetrics {
  readonly turnsStarted: number
  readonly turnsSucceeded: number
  readonly turnsMaxTokens: number
  readonly turnsBlocked: number
  readonly turnsAborted: number
  readonly turnsErrored: number
  readonly turnsInterrupted: number
  readonly stepsStarted: number
  readonly stepsCompleted: number
  readonly assistantMessages: number
  readonly modelRequests: number
  readonly toolCalls: number
  readonly toolDispatches: number
  readonly toolSettled: number
  readonly toolResults: number
  readonly toolErrors: number
  readonly codeRuns: number
  readonly codeSubdispatchesStarted: number
  readonly codeSubdispatchesSettled: number
  readonly codeSubdispatchErrors: number
  /** Durable bytes held in nested Code Mode settle records that never enter model-visible history. */
  readonly codeSubdispatchLogBytes: number
  readonly codeSubdispatchErrorRate: number | null
  readonly averageCodeSubdispatchLatencyMs: number | null
  readonly p95CodeSubdispatchLatencyMs: number | null
  readonly averageCodeSubcallsPerRun: number | null
  readonly toolReconciliations: number
  readonly toolReconciliationsCompleted: number
  readonly toolReconciliationsNotExecuted: number
  readonly toolReconciliationsUnknown: number
  readonly unmatchedToolCalls: number
  readonly goalVerifications: number
  readonly goalVerificationPasses: number
  readonly goalVerificationFailures: number
  readonly outcomeReceipts: number
  readonly outcomeReceiptsWithWarnings: number
  readonly durabilityCheckpoints: number
  readonly recoveryReceipts: number
  readonly recoveredNotStartedCalls: number
  readonly recoveredRetrySafeCalls: number
  readonly recoveryReconciliationRequiredCalls: number
  readonly recoveryLegacyAmbiguousCalls: number
  readonly averageRecoveryTailEvents: number | null
  readonly requestHeaders: number
  readonly requestHeaderChanges: number
  readonly requestPrefixStableTransitions: number
  readonly requestPrefixChangedTransitions: number
  readonly requestPrefixStabilityRatio: number | null
  readonly compactionsStarted: number
  readonly compactionsSucceeded: number
  readonly compactionsFailed: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly billedInputTokens: number
  readonly cacheHitRatio: number | null
  /** tool/dispatch -> tool/settled: physical execution/around-dispatch latency. */
  readonly averageToolExecutionLatencyMs: number | null
  readonly p95ToolExecutionLatencyMs: number | null
  /** tool/call -> tool/result: model-visible durable completion latency. */
  readonly averageToolCommitLatencyMs: number | null
  readonly p95ToolCommitLatencyMs: number | null
  /** tool/settled -> tool/result: ordered-commit / finalization head-of-line delay. */
  readonly averageToolHeadOfLineDelayMs: number | null
  readonly p95ToolHeadOfLineDelayMs: number | null
  readonly averageStepLatencyMs: number | null
  readonly p95StepLatencyMs: number | null
  /** Context-composition samples emitted by a runtime integration. */
  readonly contextSamples: number
  readonly averageReasoningContextRatio: number | null
  readonly p95ReasoningContextRatio: number | null
  readonly maxReasoningContextRatio: number | null
  /** Sum of measured runtime wall time across performance samples. */
  readonly measuredTurnWallMs: number
  readonly measuredModelWaitMs: number
  readonly measuredExternalToolMs: number
  readonly measuredOrchestrationMs: number
  readonly orchestrationOverheadRatio: number | null
  readonly eventEncodeMs: number
  readonly eventDecodeMs: number
  readonly eventPersistMs: number
  readonly projectionMs: number
  readonly telemetryMs: number
  readonly codeBridgeMs: number
  readonly subagentWaitMs: number
  readonly ptySettlementMs: number
  readonly measuredCompactionMs: number
  readonly measuredVerificationMs: number
  readonly terminalSettlements: number
  readonly terminalMarkerSettlements: number
  readonly terminalPromptFallbacks: number
  readonly terminalSilenceFallbacks: number
  readonly terminalTimeouts: number
  readonly terminalExits: number
  readonly terminalResets: number
  /** Prompt/silence protocol fallback only; timeout/exit/reset are reported separately. */
  readonly terminalProtocolFallbackRate: number | null
  readonly terminalTimeoutRate: number | null
  readonly terminalExitRate: number | null
  readonly terminalResetRate: number | null
  /** @deprecated Alias of terminalProtocolFallbackRate for compatibility. */
  readonly terminalFallbackRate: number | null
  readonly backpressureEvents: number
  readonly backpressureDrops: number
  readonly averageBackpressureWaitMs: number | null
  readonly p95BackpressureWaitMs: number | null
  readonly subagentBudgetAdmissions: number
  readonly subagentBudgetRejections: number
  readonly subagentBudgetReleases: number
}

export interface RuntimePerformanceSample {
  readonly turnWallMs: number
  readonly modelWaitMs?: number
  readonly externalToolMs?: number
  readonly eventEncodeMs?: number
  readonly eventDecodeMs?: number
  readonly eventPersistMs?: number
  readonly projectionMs?: number
  readonly telemetryMs?: number
  readonly codeBridgeMs?: number
  readonly subagentWaitMs?: number
  readonly ptySettlementMs?: number
  readonly compactionMs?: number
  readonly verificationMs?: number
}

export interface ContextCompositionSample {
  readonly totalTokens: number
  readonly reasoningTokens: number
}

export type TerminalSettlementMode = 'marker' | 'prompt' | 'silence' | 'timeout' | 'exit' | 'reset'

export interface RootResourceBudget {
  readonly maxConcurrentOneShotChildren?: number
  readonly maxDescendantsStarted?: number
  readonly maxSubagentStartsPerMinute?: number
  readonly maxModelCalls?: number
  readonly maxReasoningTokens?: number
  readonly maxEventBytes?: number
  readonly maxWallTimeMs?: number
}

export interface RootResourceUsage {
  readonly rootId: string
  readonly descendantsStarted: number
  readonly concurrentOneShotChildren: number
  readonly modelCalls: number
  readonly reasoningTokens: number
  readonly eventBytes: number
  readonly wallTimeMs: number
  readonly rejectedAdmissions: number
}

export type ResourceBudgetDimension =
  | 'concurrent-one-shot-children'
  | 'descendants-started'
  | 'subagent-start-rate'
  | 'model-calls'
  | 'reasoning-tokens'
  | 'event-bytes'
  | 'wall-time-ms'

export interface ResourceAdmission {
  readonly rootId: string
  readonly kind: 'one-shot' | 'continuable'
  readonly admittedAt: number
  /** Mark the reserved start as published/accepted. */
  commit(): void
  /** Undo an admission whose child never published. */
  rollback(): void
  /** Release live one-shot concurrency after a committed child settles. */
  release(): void
}

export type GateComparator = 'gte' | 'lte' | 'eq'

export interface NumericGate {
  readonly metric: keyof AgentKernelMetrics
  readonly comparator: GateComparator
  readonly threshold: number
  readonly required?: boolean
}

export interface GateResult {
  readonly metric: keyof AgentKernelMetrics
  readonly comparator: GateComparator
  readonly threshold: number
  readonly actual: number | null
  readonly passed: boolean
  readonly required: boolean
}

export interface QualificationResult {
  readonly passed: boolean
  readonly gates: readonly GateResult[]
}

export interface AblationVariant {
  readonly name: string
  readonly metrics: AgentKernelMetrics
}

/** Heuristic dashboard weights. Do not use this score as a statistical decision rule. */
export interface AblationWeights {
  readonly cacheHitRatio?: number
  readonly toolErrorRate?: number
  readonly unmatchedToolRate?: number
  readonly stepLatencyMs?: number
  readonly successRate?: number
  readonly maxTokenRate?: number
}

export interface AblationScore {
  readonly name: string
  readonly score: number
  readonly metrics: AgentKernelMetrics
}

export interface TaskObservation {
  readonly taskId: string
  readonly success: boolean
  readonly wallTimeMs: number
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly cachedInputTokens?: number
  readonly modelCalls?: number
  readonly toolCalls?: number
  readonly cost?: number
}

export interface VariantSummary {
  readonly name: string
  readonly tasks: number
  readonly successes: number
  readonly successRate: number
  readonly medianWallTimeMs: number | null
  readonly p95WallTimeMs: number | null
  readonly totalCost: number | null
  readonly costPerSuccess: number | null
  readonly totalInputTokens: number
  readonly totalOutputTokens: number
  readonly totalCachedInputTokens: number
  readonly totalModelCalls: number
  readonly totalToolCalls: number
}

export interface PairedVariantComparison {
  readonly baseline: VariantSummary
  readonly candidate: VariantSummary
  readonly pairedTasks: number
  readonly bothPassed: number
  readonly bothFailed: number
  readonly candidateOnlyPassed: number
  readonly baselineOnlyPassed: number
  readonly pairedSuccessDelta: number
}

export type VerificationGroundTruth = 'valid' | 'invalid'

export interface VerificationObservation {
  readonly caseId: string
  readonly pack: string
  readonly groundTruth: VerificationGroundTruth
  readonly accepted: boolean
  readonly verificationMs: number
  readonly verifierRuns: number
  readonly evidenceRecords: number
  readonly repairRounds: number
}

export interface VerificationBenchmarkSummary {
  readonly cases: number
  readonly validCases: number
  readonly invalidCases: number
  readonly trueAccepts: number
  readonly trueRejects: number
  readonly falseAccepts: number
  readonly falseRejects: number
  readonly falseAcceptanceRate: number
  readonly falseRejectionRate: number
  readonly meanVerificationMs: number
  readonly meanVerifierRuns: number
  readonly meanEvidenceRecords: number
  readonly meanRepairRounds: number
}
