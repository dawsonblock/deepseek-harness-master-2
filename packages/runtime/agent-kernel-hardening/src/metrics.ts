import type { AgentKernelMetrics, KernelEvent, RecoveryPolicyMap } from './types.js'
import { analyzeHeaderStability } from './cache-stability.js'
import { findUnmatchedToolCalls } from './recovery.js'
import { asRecord, finiteNumber, int, mean, percentile, stringValue } from './util.js'

interface TimedKey { turn: number; step: number }
const key = ({ turn, step }: TimedKey): string => `${turn}:${step}`

export function deriveAgentKernelMetrics(
  events: readonly KernelEvent[],
  recoveryPolicies: RecoveryPolicyMap = {},
): AgentKernelMetrics {
  let turnsStarted = 0
  let turnsSucceeded = 0
  let turnsMaxTokens = 0
  let turnsBlocked = 0
  let turnsAborted = 0
  let turnsErrored = 0
  let turnsInterrupted = 0
  let stepsStarted = 0
  let stepsCompleted = 0
  let assistantMessages = 0
  let modelRequests = 0
  let toolCalls = 0
  let toolDispatches = 0
  let toolSettled = 0
  let toolResults = 0
  let toolErrors = 0
  let codeRuns = 0
  let codeSubdispatchesStarted = 0
  let codeSubdispatchesSettled = 0
  let codeSubdispatchErrors = 0
  let codeSubdispatchLogBytes = 0
  let toolReconciliations = 0
  let toolReconciliationsCompleted = 0
  let toolReconciliationsNotExecuted = 0
  let toolReconciliationsUnknown = 0
  let goalVerifications = 0
  let goalVerificationPasses = 0
  let goalVerificationFailures = 0
  let outcomeReceipts = 0
  let outcomeReceiptsWithWarnings = 0
  let durabilityCheckpoints = 0
  let recoveryReceipts = 0
  let recoveredNotStartedCalls = 0
  let recoveredRetrySafeCalls = 0
  let recoveryReconciliationRequiredCalls = 0
  let recoveryLegacyAmbiguousCalls = 0
  const recoveryTailEvents: number[] = []
  let compactionsStarted = 0
  let compactionsSucceeded = 0
  let compactionsFailed = 0
  let inputTokens = 0
  let outputTokens = 0
  let reasoningTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  const reasoningContextRatios: number[] = []
  let measuredTurnWallMs = 0
  let measuredModelWaitMs = 0
  let measuredExternalToolMs = 0
  let eventEncodeMs = 0
  let eventDecodeMs = 0
  let eventPersistMs = 0
  let projectionMs = 0
  let telemetryMs = 0
  let codeBridgeMs = 0
  let subagentWaitMs = 0
  let ptySettlementMs = 0
  let measuredCompactionMs = 0
  let measuredVerificationMs = 0
  let terminalSettlements = 0
  let terminalMarkerSettlements = 0
  let terminalPromptFallbacks = 0
  let terminalSilenceFallbacks = 0
  let terminalTimeouts = 0
  let terminalExits = 0
  let terminalResets = 0
  let backpressureEvents = 0
  let backpressureDrops = 0
  const backpressureWaits: number[] = []
  let subagentBudgetAdmissions = 0
  let subagentBudgetRejections = 0
  let subagentBudgetReleases = 0

  const stepStarts = new Map<string, number>()
  const stepLatencies: number[] = []
  const toolCallsAt = new Map<string, number>()
  const toolDispatchAt = new Map<string, number>()
  const toolSettledAt = new Map<string, number>()
  const toolExecutionLatencies: number[] = []
  const toolCommitLatencies: number[] = []
  const toolHeadOfLineDelays: number[] = []
  const codeDispatchStarts = new Map<string, number>()
  const codeSubdispatchLatencies: number[] = []
  const codeSubcallsByParent = new Map<string, number>()

  for (const event of events) {
    const data = asRecord(event.data)
    if (!data) continue
    switch (event.type) {
      case 'turn/start':
        turnsStarted += 1
        break
      case 'turn/end': {
        const reason = asRecord(data.reason)
        const kind = reason ? stringValue(reason.kind) : undefined
        if (kind === 'completed') turnsSucceeded += 1
        else if (kind === 'max-tokens') turnsMaxTokens += 1
        else if (kind === 'blocked') turnsBlocked += 1
        else if (kind === 'aborted') turnsAborted += 1
        else if (kind === 'error') turnsErrored += 1
        else if (kind === 'interrupted') turnsInterrupted += 1
        break
      }
      case 'step/start': {
        stepsStarted += 1
        const turn = int(data.turn)
        const step = int(data.step)
        if (turn !== undefined && step !== undefined) stepStarts.set(key({ turn, step }), event.time)
        break
      }
      case 'step/end': {
        stepsCompleted += 1
        const turn = int(data.turn)
        const step = int(data.step)
        if (turn !== undefined && step !== undefined) {
          const started = stepStarts.get(key({ turn, step }))
          if (started !== undefined && event.time >= started) stepLatencies.push(event.time - started)
        }
        break
      }
      case 'model/request':
        modelRequests += 1
        break
      case 'assistant/message': {
        assistantMessages += 1
        const usage = asRecord(data.usage)
        if (!usage) break
        inputTokens += finiteNumber(usage.inputTokens) ?? 0
        outputTokens += finiteNumber(usage.outputTokens) ?? 0
        reasoningTokens += finiteNumber(usage.reasoningTokens) ?? 0
        cacheReadTokens += finiteNumber(usage.cacheReadTokens) ?? 0
        cacheWriteTokens += finiteNumber(usage.cacheWriteTokens) ?? 0
        break
      }
      case 'tool/call': {
        toolCalls += 1
        const callId = stringValue(data.callId)
        if (callId !== undefined) toolCallsAt.set(callId, event.time)
        if (stringValue(data.name) === 'run_code') codeRuns += 1
        break
      }
      case 'tool/code-dispatch-start': {
        codeSubdispatchesStarted += 1
        const subCallId = stringValue(data.subCallId)
        const parentCallId = stringValue(data.parentCallId)
        if (subCallId !== undefined) codeDispatchStarts.set(subCallId, event.time)
        if (parentCallId !== undefined) codeSubcallsByParent.set(parentCallId, (codeSubcallsByParent.get(parentCallId) ?? 0) + 1)
        break
      }
      case 'tool/code-dispatch': {
        codeSubdispatchesSettled += 1
        if (data.isError === true) codeSubdispatchErrors += 1
        const subCallId = stringValue(data.subCallId)
        if (subCallId !== undefined) {
          const started = codeDispatchStarts.get(subCallId)
          if (started !== undefined && event.time >= started) codeSubdispatchLatencies.push(event.time - started)
        }
        const content = data.content
        try {
          codeSubdispatchLogBytes += new TextEncoder().encode(JSON.stringify(content ?? null)).byteLength
        } catch {
          // Analysis must remain total over malformed/legacy synthetic fixtures.
        }
        break
      }
      case 'tool/dispatch': {
        toolDispatches += 1
        const callId = stringValue(data.callId)
        if (callId !== undefined) toolDispatchAt.set(callId, event.time)
        break
      }
      case 'tool/settled': {
        toolSettled += 1
        const callId = stringValue(data.callId)
        if (callId !== undefined) {
          toolSettledAt.set(callId, event.time)
          const dispatched = toolDispatchAt.get(callId)
          if (dispatched !== undefined && event.time >= dispatched) toolExecutionLatencies.push(event.time - dispatched)
        }
        break
      }
      case 'tool/reconciliation': {
        toolReconciliations += 1
        const state = stringValue(data.state)
        if (state === 'completed') toolReconciliationsCompleted += 1
        else if (state === 'not-executed') toolReconciliationsNotExecuted += 1
        else if (state === 'unknown') toolReconciliationsUnknown += 1
        break
      }
      case 'goal/verification': {
        goalVerifications += 1
        if (data.passed === true) goalVerificationPasses += 1
        else goalVerificationFailures += 1
        break
      }
      case 'goal/outcome-receipt': {
        outcomeReceipts += 1
        if (stringValue(data.overallVerdict) === 'pass-with-warnings') outcomeReceiptsWithWarnings += 1
        break
      }
      case 'session/checkpoint':
        durabilityCheckpoints += 1
        break
      case 'session/recovery': {
        recoveryReceipts += 1
        recoveredNotStartedCalls += Array.isArray(data.notStartedCalls) ? data.notStartedCalls.length : 0
        recoveredRetrySafeCalls += Array.isArray(data.retrySafeCalls) ? data.retrySafeCalls.length : 0
        recoveryReconciliationRequiredCalls += Array.isArray(data.reconciliationRequiredCalls) ? data.reconciliationRequiredCalls.length : 0
        recoveryLegacyAmbiguousCalls += Array.isArray(data.legacyAmbiguousCalls) ? data.legacyAmbiguousCalls.length : 0
        const tail = int(data.tailEventCount)
        if (tail !== undefined) recoveryTailEvents.push(tail)
        break
      }
      case 'tool/result': {
        toolResults += 1
        if (isCanonicalToolError(data)) toolErrors += 1
        const callId = toolResultCallId(data)
        if (callId !== undefined) {
          const called = toolCallsAt.get(callId)
          if (called !== undefined && event.time >= called) toolCommitLatencies.push(event.time - called)
          const settled = toolSettledAt.get(callId)
          if (settled !== undefined && event.time >= settled) toolHeadOfLineDelays.push(event.time - settled)
        }
        break
      }
      case 'context/composition': {
        const total = finiteNumber(data.totalTokens)
        const reasoning = finiteNumber(data.reasoningTokens)
        if (total !== undefined && total > 0 && reasoning !== undefined && reasoning >= 0) {
          reasoningContextRatios.push(Math.min(1, reasoning / total))
        }
        break
      }
      case 'runtime/performance-sample': {
        measuredTurnWallMs += finiteNumber(data.turnWallMs) ?? 0
        measuredModelWaitMs += finiteNumber(data.modelWaitMs) ?? 0
        measuredExternalToolMs += finiteNumber(data.externalToolMs) ?? 0
        eventEncodeMs += finiteNumber(data.eventEncodeMs) ?? 0
        eventDecodeMs += finiteNumber(data.eventDecodeMs) ?? 0
        eventPersistMs += finiteNumber(data.eventPersistMs) ?? 0
        projectionMs += finiteNumber(data.projectionMs) ?? 0
        telemetryMs += finiteNumber(data.telemetryMs) ?? 0
        codeBridgeMs += finiteNumber(data.codeBridgeMs) ?? 0
        subagentWaitMs += finiteNumber(data.subagentWaitMs) ?? 0
        ptySettlementMs += finiteNumber(data.ptySettlementMs) ?? 0
        measuredCompactionMs += finiteNumber(data.compactionMs) ?? 0
        measuredVerificationMs += finiteNumber(data.verificationMs) ?? 0
        break
      }
      case 'terminal/settlement': {
        terminalSettlements += 1
        const mode = stringValue(data.mode)
        if (mode === 'marker') terminalMarkerSettlements += 1
        else if (mode === 'prompt') terminalPromptFallbacks += 1
        else if (mode === 'silence') terminalSilenceFallbacks += 1
        else if (mode === 'timeout') terminalTimeouts += 1
        else if (mode === 'exit') terminalExits += 1
        else if (mode === 'reset') terminalResets += 1
        break
      }
      case 'runtime/backpressure': {
        backpressureEvents += 1
        if (data.dropped === true) backpressureDrops += 1
        const waitMs = finiteNumber(data.waitMs)
        if (waitMs !== undefined && waitMs >= 0) backpressureWaits.push(waitMs)
        break
      }
      case 'subagent/resource': {
        const action = stringValue(data.action)
        if (action === 'admit') subagentBudgetAdmissions += 1
        else if (action === 'reject') subagentBudgetRejections += 1
        else if (action === 'release') subagentBudgetReleases += 1
        break
      }
      case 'compaction/start':
        compactionsStarted += 1
        break
      case 'compaction/end':
        if (data.error === undefined) compactionsSucceeded += 1
        else compactionsFailed += 1
        break
    }
  }

  const header = analyzeHeaderStability(events)
  const unmatchedToolCalls = findUnmatchedToolCalls(events, recoveryPolicies).length
  const billedInputTokens = inputTokens + cacheReadTokens + cacheWriteTokens
  return {
    turnsStarted, turnsSucceeded, turnsMaxTokens, turnsBlocked, turnsAborted, turnsErrored, turnsInterrupted,
    stepsStarted, stepsCompleted, assistantMessages, modelRequests,
    toolCalls, toolDispatches, toolSettled, toolResults, toolErrors,
    codeRuns, codeSubdispatchesStarted, codeSubdispatchesSettled, codeSubdispatchErrors, codeSubdispatchLogBytes,
    codeSubdispatchErrorRate: codeSubdispatchesSettled === 0 ? null : codeSubdispatchErrors / codeSubdispatchesSettled,
    averageCodeSubdispatchLatencyMs: mean(codeSubdispatchLatencies),
    p95CodeSubdispatchLatencyMs: percentile(codeSubdispatchLatencies, 0.95),
    averageCodeSubcallsPerRun: codeRuns === 0 ? null : [...codeSubcallsByParent.values()].reduce((sum, value) => sum + value, 0) / codeRuns,
    toolReconciliations, toolReconciliationsCompleted, toolReconciliationsNotExecuted, toolReconciliationsUnknown,
    unmatchedToolCalls, goalVerifications, goalVerificationPasses, goalVerificationFailures, outcomeReceipts, outcomeReceiptsWithWarnings,
    durabilityCheckpoints, recoveryReceipts, recoveredNotStartedCalls, recoveredRetrySafeCalls,
    recoveryReconciliationRequiredCalls, recoveryLegacyAmbiguousCalls,
    averageRecoveryTailEvents: mean(recoveryTailEvents),
    requestHeaders: header.headerCount,
    requestHeaderChanges: header.headerChanges,
    requestPrefixStableTransitions: header.stableTransitions,
    requestPrefixChangedTransitions: header.changedTransitions,
    requestPrefixStabilityRatio: header.stabilityRatio,
    compactionsStarted, compactionsSucceeded, compactionsFailed,
    inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens, billedInputTokens,
    cacheHitRatio: billedInputTokens === 0 ? null : cacheReadTokens / billedInputTokens,
    averageToolExecutionLatencyMs: mean(toolExecutionLatencies),
    p95ToolExecutionLatencyMs: percentile(toolExecutionLatencies, 0.95),
    averageToolCommitLatencyMs: mean(toolCommitLatencies),
    p95ToolCommitLatencyMs: percentile(toolCommitLatencies, 0.95),
    averageToolHeadOfLineDelayMs: mean(toolHeadOfLineDelays),
    p95ToolHeadOfLineDelayMs: percentile(toolHeadOfLineDelays, 0.95),
    averageStepLatencyMs: mean(stepLatencies),
    p95StepLatencyMs: percentile(stepLatencies, 0.95),
    contextSamples: reasoningContextRatios.length,
    averageReasoningContextRatio: mean(reasoningContextRatios),
    p95ReasoningContextRatio: percentile(reasoningContextRatios, 0.95),
    maxReasoningContextRatio: reasoningContextRatios.length === 0 ? null : Math.max(...reasoningContextRatios),
    measuredTurnWallMs, measuredModelWaitMs, measuredExternalToolMs,
    measuredOrchestrationMs: Math.max(0, measuredTurnWallMs - measuredModelWaitMs - measuredExternalToolMs),
    orchestrationOverheadRatio: measuredTurnWallMs === 0
      ? null
      : Math.max(0, measuredTurnWallMs - measuredModelWaitMs - measuredExternalToolMs) / measuredTurnWallMs,
    eventEncodeMs, eventDecodeMs, eventPersistMs, projectionMs, telemetryMs, codeBridgeMs, subagentWaitMs,
    ptySettlementMs, measuredCompactionMs, measuredVerificationMs,
    terminalSettlements, terminalMarkerSettlements, terminalPromptFallbacks, terminalSilenceFallbacks,
    terminalTimeouts, terminalExits, terminalResets,
    terminalProtocolFallbackRate: terminalSettlements === 0
      ? null
      : (terminalPromptFallbacks + terminalSilenceFallbacks) / terminalSettlements,
    terminalTimeoutRate: terminalSettlements === 0 ? null : terminalTimeouts / terminalSettlements,
    terminalExitRate: terminalSettlements === 0 ? null : terminalExits / terminalSettlements,
    terminalResetRate: terminalSettlements === 0 ? null : terminalResets / terminalSettlements,
    terminalFallbackRate: terminalSettlements === 0
      ? null
      : (terminalPromptFallbacks + terminalSilenceFallbacks) / terminalSettlements,
    backpressureEvents, backpressureDrops,
    averageBackpressureWaitMs: mean(backpressureWaits),
    p95BackpressureWaitMs: percentile(backpressureWaits, 0.95),
    subagentBudgetAdmissions, subagentBudgetRejections, subagentBudgetReleases,
  }
}

function toolResultCallId(data: Record<string, unknown>): string | undefined {
  const message = asRecord(data.message)
  if (!message) return undefined
  const source = asRecord(message.source)
  return (source ? stringValue(source.callId) : undefined) ?? stringValue(message.callId)
}

/** Canonical Harness error indicator: ToolResultMessage.content[0].isError. */
function isCanonicalToolError(data: Record<string, unknown>): boolean {
  const message = asRecord(data.message)
  const content = message?.content
  if (Array.isArray(content)) {
    const block = asRecord(content[0])
    if (block?.type === 'tool-result') return block.isError === true
  }
  // Compatibility fallback for legacy synthetic fixtures only.
  return data.error !== undefined
}
