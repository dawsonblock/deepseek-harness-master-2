import assert from 'node:assert/strict'
import test from 'node:test'
import {
  analyzeHeaderStability,
  comparePairedVariants,
  DEFAULT_QUALITY_GATES,
  RUNTIME_PERFORMANCE_GATES,
  deriveAgentKernelMetrics,
  deriveLatestRecoveryPlan,
  eventsFromTelemetryRecords,
  findUnmatchedToolCalls,
  qualifyMetrics,
  rankAblations,
  reconcileUnmatchedToolCall,
  summarizeVariant,
  RootResourceGovernor,
  ResourceBudgetExceededError,
  BoundedBackpressureGate,
  BackpressureRejectedError,
} from '../lib/index.js'

const event = (seq, type, data, time = seq * 10, ignorable) => ({
  seq, type, data, time, ...(ignorable === true ? { ignorable: true } : {}),
})

const toolResultMessage = (callId, isError = false) => ({
  id: `m-${callId}`,
  role: 'user',
  source: { kind: 'tool', callId },
  content: [{
    type: 'tool-result', toolCallId: callId, isError,
    content: [{ type: 'text', text: isError ? 'failed' : 'ok' }],
  }],
})

function healthyEvents() {
  return [
    event(0, 'turn/start', { turn: 1 }, 0),
    event(1, 'step/start', { turn: 1, step: 1 }, 10),
    event(2, 'request/header', { reason: 'initial', header: { config: { provider: 'deepseek', model: 'x' }, system: 'stable', tools: [{ name: 'read' }] } }, 11),
    event(3, 'model/request', { turn: 1, step: 1, attempt: 1, provider: 'deepseek', model: 'x' }, 12, true),
    event(4, 'assistant/message', { turn: 1, step: 1, message: {}, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 0, reasoningTokens: 5 } }, 30),
    event(5, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}', lifecycleVersion: 1 }, 32),
    event(6, 'tool/dispatch', { turn: 1, step: 1, callId: 'c1', name: 'read', callSeq: 5 }, 33, true),
    event(7, 'tool/settled', { turn: 1, step: 1, callId: 'c1', name: 'read', dispatchSeq: 6, outcome: 'resolved' }, 40, true),
    event(8, 'tool/result', { turn: 1, step: 1, message: toolResultMessage('c1') }, 42),
    event(9, 'step/end', { turn: 1, step: 1 }, 50),
    event(10, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 55),
  ]
}

test('derives canonical cache, lifecycle, latency and success metrics', () => {
  const metrics = deriveAgentKernelMetrics(healthyEvents())
  assert.equal(metrics.turnsStarted, 1)
  assert.equal(metrics.turnsSucceeded, 1)
  assert.equal(metrics.turnsMaxTokens, 0)
  assert.equal(metrics.modelRequests, 1)
  assert.equal(metrics.toolCalls, 1)
  assert.equal(metrics.toolDispatches, 1)
  assert.equal(metrics.toolSettled, 1)
  assert.equal(metrics.toolResults, 1)
  assert.equal(metrics.toolErrors, 0)
  assert.equal(metrics.unmatchedToolCalls, 0)
  assert.equal(metrics.cacheReadTokens, 300)
  assert.equal(metrics.billedInputTokens, 400)
  assert.equal(metrics.cacheHitRatio, 0.75)
  assert.equal(metrics.averageToolExecutionLatencyMs, 7)
  assert.equal(metrics.averageToolCommitLatencyMs, 10)
  assert.equal(metrics.averageToolHeadOfLineDelayMs, 2)
  assert.equal(metrics.averageStepLatencyMs, 40)
})

test('tool errors use canonical ToolResultMessage block even when internal error metadata is absent', () => {
  const metrics = deriveAgentKernelMetrics([
    event(0, 'tool/call', { turn: 1, step: 1, callId: 'x', name: 'read', arguments: '{}', lifecycleVersion: 1 }),
    event(1, 'tool/result', { turn: 1, step: 1, message: toolResultMessage('x', true) }),
  ])
  assert.equal(metrics.toolErrors, 1)
})

test('max-tokens is not counted as successful completion', () => {
  const metrics = deriveAgentKernelMetrics([
    event(0, 'turn/start', { turn: 1 }),
    event(1, 'turn/end', { turn: 1, reason: { kind: 'max-tokens' } }),
  ])
  assert.equal(metrics.turnsSucceeded, 0)
  assert.equal(metrics.turnsMaxTokens, 1)
})

test('failed compaction is not counted as succeeded', () => {
  const metrics = deriveAgentKernelMetrics([
    event(0, 'compaction/start', { compactionId: 'c', turn: null }),
    event(1, 'compaction/end', { compactionId: 'c', turn: null, error: 'provider failed' }),
  ])
  assert.equal(metrics.compactionsStarted, 1)
  assert.equal(metrics.compactionsSucceeded, 0)
  assert.equal(metrics.compactionsFailed, 1)
})

test('header stability is measured over actual model requests, not sparse header events', () => {
  const events = [
    event(0, 'request/header', { reason: 'initial', header: { system: 's', config: { model: 'm', provider: 'p' } } }),
    event(1, 'model/request', { turn: 1, step: 1, attempt: 1, provider: 'p', model: 'm' }),
    event(2, 'model/request', { turn: 1, step: 2, attempt: 1, provider: 'p', model: 'm' }),
    event(3, 'model/request', { turn: 1, step: 3, attempt: 1, provider: 'p', model: 'm' }),
    event(4, 'request/header', { reason: 'change', header: { system: 's', config: { model: 'm2', provider: 'p' } } }),
    event(5, 'model/request', { turn: 1, step: 4, attempt: 1, provider: 'p', model: 'm2' }),
    event(6, 'model/request', { turn: 1, step: 5, attempt: 1, provider: 'p', model: 'm2' }),
  ]
  const report = analyzeHeaderStability(events)
  assert.equal(report.headerCount, 2)
  assert.equal(report.headerChanges, 1)
  assert.equal(report.requestCount, 5)
  assert.equal(report.stableTransitions, 3)
  assert.equal(report.changedTransitions, 1)
  assert.equal(report.stabilityRatio, 0.75)
})

test('old logs without model/request do not invent request stability', () => {
  const report = analyzeHeaderStability([
    event(0, 'request/header', { header: { config: { provider: 'p', model: 'm' } } }),
  ])
  assert.equal(report.requestCount, 0)
  assert.equal(report.stabilityRatio, null)
})

test('new tracked call without dispatch is not-started and safe to retry', () => {
  const unresolved = findUnmatchedToolCalls([
    event(0, 'tool/call', { turn: 1, step: 1, callId: 'w', name: 'write', arguments: '{}', lifecycleVersion: 1 }),
  ])
  assert.equal(unresolved.length, 1)
  assert.equal(unresolved[0].state, 'not-started')
  assert.equal(unresolved[0].safeToRetry, true)
})

test('legacy unmatched calls remain outcome-unknown for backward compatibility', () => {
  const unresolved = findUnmatchedToolCalls([
    event(0, 'tool/call', { turn: 1, step: 1, callId: 'legacy', name: 'write', arguments: '{}' }),
  ])
  assert.equal(unresolved[0].state, 'outcome-unknown')
  assert.equal(unresolved[0].safeToRetry, false)
})

test('dispatched side effect fails closed while an idempotent dispatched call is retryable', () => {
  const events = [
    event(0, 'tool/call', { turn: 1, step: 1, callId: 'pay', name: 'charge_card', arguments: '{}', lifecycleVersion: 1 }),
    event(1, 'tool/dispatch', { turn: 1, step: 1, callId: 'pay', name: 'charge_card', callSeq: 0 }),
    event(2, 'tool/call', { turn: 1, step: 1, callId: 'read', name: 'read_file', arguments: '{}', lifecycleVersion: 1 }),
    event(3, 'tool/dispatch', { turn: 1, step: 1, callId: 'read', name: 'read_file', callSeq: 2 }),
  ]
  const unresolved = findUnmatchedToolCalls(events, {
    charge_card: { reconcile: async () => ({ state: 'unknown' }) },
    read_file: { idempotent: true },
  })
  assert.equal(unresolved[0].state, 'outcome-unknown')
  assert.equal(unresolved[0].safeToRetry, false)
  assert.equal(unresolved[0].requiresReconciliation, true)
  assert.equal(unresolved[1].safeToRetry, true)
})

test('reconciliation can resolve an ambiguous side effect without blind retry', async () => {
  const [call] = findUnmatchedToolCalls([
    event(0, 'tool/call', { turn: 1, step: 1, callId: 'pay', name: 'charge_card', arguments: '{}', lifecycleVersion: 1 }),
    event(1, 'tool/dispatch', { turn: 1, step: 1, callId: 'pay', name: 'charge_card', callSeq: 0 }),
  ], { charge_card: { reconcile: async () => ({ state: 'completed', evidence: 'provider transaction tx-1 exists' }) } })
  const result = await reconcileUnmatchedToolCall(call, {
    charge_card: { reconcile: async () => ({ state: 'completed', evidence: 'provider transaction tx-1 exists' }) },
  })
  assert.deepEqual(result, { state: 'completed', evidence: 'provider transaction tx-1 exists' })
})

test('quality gates reject max-token completion and failed compaction', () => {
  const metrics = deriveAgentKernelMetrics([
    event(0, 'turn/start', { turn: 1 }),
    event(1, 'compaction/start', { compactionId: 'c', turn: 1 }),
    event(2, 'compaction/end', { compactionId: 'c', turn: 1, error: 'failed' }),
    event(3, 'turn/end', { turn: 1, reason: { kind: 'max-tokens' } }),
  ])
  const result = qualifyMetrics(metrics, DEFAULT_QUALITY_GATES)
  assert.equal(result.passed, false)
  assert.equal(result.gates.find(gate => gate.metric === 'turnsMaxTokens')?.passed, false)
  assert.equal(result.gates.find(gate => gate.metric === 'compactionsFailed')?.passed, false)
})

test('ablation ranking rewards actual success and penalizes max-token endings', () => {
  const good = deriveAgentKernelMetrics(healthyEvents())
  const bad = deriveAgentKernelMetrics([
    event(0, 'turn/start', { turn: 1 }, 0),
    event(1, 'step/start', { turn: 1, step: 1 }, 1),
    event(2, 'assistant/message', { turn: 1, step: 1, message: {}, usage: { inputTokens: 400, outputTokens: 10 } }, 1000),
    event(3, 'step/end', { turn: 1, step: 1 }, 3000),
    event(4, 'turn/end', { turn: 1, reason: { kind: 'max-tokens' } }, 3001),
  ])
  const ranked = rankAblations([{ name: 'good', metrics: good }, { name: 'bad', metrics: bad }])
  assert.equal(ranked[0].name, 'good')
  assert.ok(ranked[0].score > ranked[1].score)
})

test('uses the existing session-telemetry ledger stream instead of creating a second capture path', () => {
  const events = eventsFromTelemetryRecords([
    { channel: 'ops', time: 1, attributes: { 'session.id': 's' }, body: {} },
    { channel: 'ledger', time: 20, attributes: { 'session.id': 'other', 'event.type': 'turn/start', 'event.seq': 0 }, body: { turn: 1 } },
    { channel: 'ledger', time: 10, attributes: { 'session.id': 's', 'event.type': 'turn/start', 'event.seq': 0 }, body: { turn: 1 } },
  ], 's')
  assert.deepEqual(events, [{ type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } }])
})

test('paired experiment comparison preserves task-level wins/losses instead of hiding them in one score', () => {
  const baseline = [
    { taskId: 'a', success: true, wallTimeMs: 100, cost: 1 },
    { taskId: 'b', success: false, wallTimeMs: 200, cost: 2 },
    { taskId: 'c', success: true, wallTimeMs: 300, cost: 3 },
  ]
  const candidate = [
    { taskId: 'a', success: true, wallTimeMs: 90, cost: 1 },
    { taskId: 'b', success: true, wallTimeMs: 150, cost: 2 },
    { taskId: 'c', success: false, wallTimeMs: 250, cost: 3 },
  ]
  const comparison = comparePairedVariants('base', baseline, 'candidate', candidate)
  assert.equal(comparison.pairedTasks, 3)
  assert.equal(comparison.bothPassed, 1)
  assert.equal(comparison.candidateOnlyPassed, 1)
  assert.equal(comparison.baselineOnlyPassed, 1)
  assert.equal(comparison.pairedSuccessDelta, 0)
  assert.equal(summarizeVariant('base', baseline).costPerSuccess, 3)
})


test('tracks native reconciliation and independent goal verification outcomes', () => {
  const metrics = deriveAgentKernelMetrics([
    event(0, 'tool/reconciliation', { callId: 'new', priorCallId: 'old', name: 'write', operationKey: 'k', state: 'completed', evidence: 'external object exists' }),
    event(1, 'tool/reconciliation', { callId: 'new2', priorCallId: 'old2', name: 'send', operationKey: 'k2', state: 'unknown' }),
    event(2, 'goal/verification', { kind: 'goal/verification', version: 1, goal: { id: 'g', revision: 2 }, passed: true, verifiedAt: 1, checks: [] }),
    event(3, 'goal/verification', { kind: 'goal/verification', version: 1, goal: { id: 'g', revision: 3 }, passed: false, verifiedAt: 2, checks: [] }),
  ])
  assert.equal(metrics.toolReconciliations, 2)
  assert.equal(metrics.toolReconciliationsCompleted, 1)
  assert.equal(metrics.toolReconciliationsUnknown, 1)
  assert.equal(metrics.goalVerifications, 2)
  assert.equal(metrics.goalVerificationPasses, 1)
  assert.equal(metrics.goalVerificationFailures, 1)
})


test('measures Code Mode sub-dispatch efficiency without treating nested results as model-visible tool results', () => {
  const metrics = deriveAgentKernelMetrics([
    event(0, 'tool/call', { turn: 1, step: 1, callId: 'outer', name: 'run_code', arguments: '{}' }, 0),
    event(1, 'tool/code-dispatch-start', { rootCallId: 'outer', parentCallId: 'outer', subCallId: 'outer:code:1', name: 'read', arguments: { path: 'a' } }, 10, true),
    event(2, 'tool/code-dispatch-start', { rootCallId: 'outer', parentCallId: 'outer', subCallId: 'outer:code:2', name: 'grep', arguments: { pattern: 'x' } }, 12, true),
    event(3, 'tool/code-dispatch', { rootCallId: 'outer', parentCallId: 'outer', subCallId: 'outer:code:2', name: 'grep', arguments: { pattern: 'x' }, isError: false, content: [{ type: 'text', text: 'hit' }] }, 16, true),
    event(4, 'tool/code-dispatch', { rootCallId: 'outer', parentCallId: 'outer', subCallId: 'outer:code:1', name: 'read', arguments: { path: 'a' }, isError: false, content: [{ type: 'text', text: 'file contents' }] }, 20, true),
    event(5, 'tool/result', { turn: 1, step: 1, message: toolResultMessage('outer') }, 25),
  ])
  assert.equal(metrics.codeRuns, 1)
  assert.equal(metrics.codeSubdispatchesStarted, 2)
  assert.equal(metrics.codeSubdispatchesSettled, 2)
  assert.equal(metrics.codeSubdispatchErrors, 0)
  assert.equal(metrics.codeSubdispatchErrorRate, 0)
  assert.equal(metrics.averageCodeSubdispatchLatencyMs, 7)
  assert.equal(metrics.p95CodeSubdispatchLatencyMs, 10)
  assert.equal(metrics.averageCodeSubcallsPerRun, 2)
  assert.ok(metrics.codeSubdispatchLogBytes > 0)
  assert.equal(metrics.toolResults, 1)
})


test('durability checkpoints and crash recovery receipts are measurable', () => {
  const metrics = deriveAgentKernelMetrics([
    event(0, 'session/checkpoint', { version: 1, basisSeq: -1, reason: 'pre-step' }, 0, true),
    event(1, 'session/recovery', {
      version: 1, repairedTurn: 1, checkpointSeq: 0, checkpointBasisSeq: -1,
      tailStartSeq: 1, tailEventCount: 7,
      notStartedCalls: [{ callId: 'a', name: 'read' }],
      retrySafeCalls: [{ callId: 'b', name: 'web_search', operationKey: 'k1' }],
      reconciliationRequiredCalls: [{ callId: 'c', name: 'write', operationKey: 'k2' }],
      legacyAmbiguousCalls: [{ callId: 'd', name: 'shell' }],
    }, 10, true),
  ])
  assert.equal(metrics.durabilityCheckpoints, 1)
  assert.equal(metrics.recoveryReceipts, 1)
  assert.equal(metrics.recoveredNotStartedCalls, 1)
  assert.equal(metrics.recoveredRetrySafeCalls, 1)
  assert.equal(metrics.recoveryReconciliationRequiredCalls, 1)
  assert.equal(metrics.recoveryLegacyAmbiguousCalls, 1)
  assert.equal(metrics.averageRecoveryTailEvents, 7)
})


test('latest recovery plan fails closed on reconciler-required or legacy ambiguous calls', () => {
  const plan = deriveLatestRecoveryPlan([
    event(0, 'session/recovery', {
      version: 1, repairedTurn: 3, repairedStep: 2,
      checkpointSeq: 10, checkpointBasisSeq: 9, tailStartSeq: 11, tailEventCount: 5,
      notStartedCalls: [{ callId: 'a', name: 'read' }],
      retrySafeCalls: [{ callId: 'b', name: 'web_search', operationKey: 'safe' }],
      reconciliationRequiredCalls: [{ callId: 'c', name: 'write', operationKey: 'write:k' }],
      legacyAmbiguousCalls: [],
    }, 20, true),
  ])
  assert.equal(plan?.disposition, 'blocked')
  assert.equal(plan?.canAutoResume, false)
  assert.equal(plan?.checkpointSeq, 10)
  assert.equal(plan?.reconciliationRequiredCalls[0]?.operationKey, 'write:k')
})

test('latest recovery plan allows automatic resume when all pending work is definitely retryable', () => {
  const plan = deriveLatestRecoveryPlan([
    event(0, 'session/recovery', {
      version: 1, repairedTurn: 1, tailStartSeq: 0, tailEventCount: 4,
      notStartedCalls: [{ callId: 'a', name: 'read' }],
      retrySafeCalls: [{ callId: 'b', name: 'web_fetch' }],
      reconciliationRequiredCalls: [], legacyAmbiguousCalls: [],
    }, 10, true),
  ])
  assert.equal(plan?.disposition, 'retryable')
  assert.equal(plan?.canAutoResume, true)
})

test('tracks immutable outcome receipts separately from goal-verification attempts', () => {
  const metrics = deriveAgentKernelMetrics([
    event(0, 'goal/outcome-receipt', { receiptVersion: 1, overallVerdict: 'pass', receiptHash: 'a' }, 1, true),
    event(1, 'goal/outcome-receipt', { receiptVersion: 1, overallVerdict: 'pass-with-warnings', receiptHash: 'b' }, 2, true),
  ])
  assert.equal(metrics.outcomeReceipts, 2)
  assert.equal(metrics.outcomeReceiptsWithWarnings, 1)
})

test('verification experiment summary exposes FAR and FRR directly', async () => {
  const { summarizeVerificationObservations } = await import('../lib/index.js')
  const summary = summarizeVerificationObservations([
    { caseId: 'v1', pack: 'coding', groundTruth: 'valid', accepted: true, verificationMs: 4, verifierRuns: 2, evidenceRecords: 2, repairRounds: 0 },
    { caseId: 'v2', pack: 'coding', groundTruth: 'valid', accepted: false, verificationMs: 5, verifierRuns: 2, evidenceRecords: 2, repairRounds: 1 },
    { caseId: 'i1', pack: 'coding', groundTruth: 'invalid', accepted: false, verificationMs: 3, verifierRuns: 2, evidenceRecords: 2, repairRounds: 0 },
    { caseId: 'i2', pack: 'coding', groundTruth: 'invalid', accepted: true, verificationMs: 3, verifierRuns: 2, evidenceRecords: 2, repairRounds: 0 },
  ])
  assert.equal(summary.falseAcceptanceRate, 0.5)
  assert.equal(summary.falseRejectionRate, 0.5)
})

test('verification pack comparison reports candidate safety tradeoff', async () => {
  const { compareVerificationPacks } = await import('../lib/index.js')
  const baseline = [
    { caseId: 'bad', pack: 'coding', groundTruth: 'invalid', accepted: true, verificationMs: 1, verifierRuns: 1, evidenceRecords: 1, repairRounds: 0 },
  ]
  const candidate = [
    { caseId: 'bad', pack: 'coding', groundTruth: 'invalid', accepted: false, verificationMs: 2, verifierRuns: 2, evidenceRecords: 2, repairRounds: 0 },
  ]
  const comparison = compareVerificationPacks('coding@0', baseline, 'coding@1', candidate)
  assert.equal(comparison.falseAcceptanceDelta, -1)
})


test('v0.14 derives reasoning-context, orchestration, PTY and backpressure metrics', () => {
  const metrics = deriveAgentKernelMetrics([
    event(0, 'context/composition', { totalTokens: 1000, reasoningTokens: 250 }),
    event(1, 'context/composition', { totalTokens: 2000, reasoningTokens: 1000 }),
    event(2, 'runtime/performance-sample', {
      turnWallMs: 1000, modelWaitMs: 600, externalToolMs: 250,
      eventEncodeMs: 10, eventDecodeMs: 5, eventPersistMs: 15,
      projectionMs: 20, telemetryMs: 10, codeBridgeMs: 5,
      subagentWaitMs: 25, ptySettlementMs: 30, compactionMs: 20, verificationMs: 10,
    }),
    event(3, 'terminal/settlement', { mode: 'marker' }),
    event(4, 'terminal/settlement', { mode: 'prompt' }),
    event(5, 'terminal/settlement', { mode: 'silence' }),
    event(6, 'terminal/settlement', { mode: 'timeout' }),
    event(7, 'terminal/settlement', { mode: 'exit' }),
    event(8, 'terminal/settlement', { mode: 'reset' }),
    event(9, 'runtime/backpressure', { waitMs: 10, dropped: false }),
    event(10, 'runtime/backpressure', { waitMs: 30, dropped: true }),
    event(11, 'subagent/resource', { action: 'admit' }),
    event(12, 'subagent/resource', { action: 'reject' }),
    event(13, 'subagent/resource', { action: 'release' }),
  ])
  assert.equal(metrics.contextSamples, 2)
  assert.equal(metrics.averageReasoningContextRatio, 0.375)
  assert.equal(metrics.maxReasoningContextRatio, 0.5)
  assert.equal(metrics.measuredTurnWallMs, 1000)
  assert.equal(metrics.measuredModelWaitMs, 600)
  assert.equal(metrics.measuredExternalToolMs, 250)
  assert.equal(metrics.measuredOrchestrationMs, 150)
  assert.equal(metrics.orchestrationOverheadRatio, 0.15)
  assert.equal(metrics.eventEncodeMs, 10)
  assert.equal(metrics.eventPersistMs, 15)
  assert.equal(metrics.terminalSettlements, 6)
  assert.equal(metrics.terminalMarkerSettlements, 1)
  assert.equal(metrics.terminalPromptFallbacks, 1)
  assert.equal(metrics.terminalSilenceFallbacks, 1)
  assert.equal(metrics.terminalProtocolFallbackRate, 2 / 6)
  assert.equal(metrics.terminalTimeoutRate, 1 / 6)
  assert.equal(metrics.terminalExitRate, 1 / 6)
  assert.equal(metrics.terminalResetRate, 1 / 6)
  assert.equal(metrics.terminalFallbackRate, 2 / 6)
  assert.equal(metrics.backpressureEvents, 2)
  assert.equal(metrics.backpressureDrops, 1)
  assert.equal(metrics.averageBackpressureWaitMs, 20)
  assert.equal(metrics.p95BackpressureWaitMs, 30)
  assert.equal(metrics.subagentBudgetAdmissions, 1)
  assert.equal(metrics.subagentBudgetRejections, 1)
  assert.equal(metrics.subagentBudgetReleases, 1)
})

test('v0.14 root resource governor enforces descendant and concurrent-child budgets', () => {
  const governor = new RootResourceGovernor({
    maxConcurrentOneShotChildren: 2,
    maxDescendantsStarted: 3,
    maxSubagentStartsPerMinute: 3,
  })
  const first = governor.admitSubagent('root', 'one-shot', 0)
  first.commit()
  const second = governor.admitSubagent('root', 'one-shot', 1)
  second.commit()
  assert.throws(
    () => governor.admitSubagent('root', 'one-shot', 2),
    error => error instanceof ResourceBudgetExceededError && error.dimension === 'concurrent-one-shot-children',
  )
  first.release()
  const third = governor.admitSubagent('root', 'continuable', 3)
  third.commit()
  assert.equal(governor.snapshot('root').descendantsStarted, 3)
  assert.throws(
    () => governor.admitSubagent('root', 'continuable', 4),
    error => error instanceof ResourceBudgetExceededError && error.dimension === 'descendants-started',
  )
  second.release()
  third.release()
  assert.equal(governor.snapshot('root').concurrentOneShotChildren, 0)

  const rollbackGovernor = new RootResourceGovernor({ maxDescendantsStarted: 1 })
  const provisional = rollbackGovernor.admitSubagent('rollback-root', 'continuable', 0)
  provisional.rollback()
  const retried = rollbackGovernor.admitSubagent('rollback-root', 'continuable', 1)
  retried.commit()
  assert.equal(rollbackGovernor.snapshot('rollback-root').descendantsStarted, 1)
})

test('v0.14 root resource governor enforces model, reasoning, event and wall-time budgets', () => {
  const governor = new RootResourceGovernor({
    maxModelCalls: 2,
    maxReasoningTokens: 100,
    maxEventBytes: 1024,
    maxWallTimeMs: 1000,
  })
  governor.recordModelUsage('root', 1, 40)
  governor.recordModelUsage('root', 1, 60)
  assert.throws(() => governor.recordModelUsage('root', 1, 0), ResourceBudgetExceededError)
  governor.recordEventBytes('root', 1024)
  assert.throws(() => governor.recordEventBytes('root', 1), ResourceBudgetExceededError)
  governor.recordWallTime('root', 1000)
  assert.throws(() => governor.recordWallTime('root', 1), ResourceBudgetExceededError)
  const snapshot = governor.snapshot('root')
  assert.equal(snapshot.modelCalls, 2)
  assert.equal(snapshot.reasoningTokens, 100)
  assert.equal(snapshot.eventBytes, 1024)
  assert.equal(snapshot.wallTimeMs, 1000)
})


test('v0.14 bounded backpressure gate is FIFO and rejects overload before admission', async () => {
  const gate = new BoundedBackpressureGate({ maxConcurrent: 1, maxQueued: 1 })
  const first = await gate.acquire()
  const queued = gate.acquire()
  await assert.rejects(gate.acquire(), error => error instanceof BackpressureRejectedError && error.reason === 'queue-full')
  assert.deepEqual(gate.snapshot(), { active: 1, queued: 1, admitted: 1, rejected: 1, timedOut: 0, totalWaitMs: 0 })
  first.release()
  const second = await queued
  assert.equal(gate.snapshot().active, 1)
  assert.equal(gate.snapshot().queued, 0)
  assert.equal(gate.snapshot().admitted, 2)
  second.release()
  assert.equal(gate.snapshot().active, 0)
})


test('v0.14 required performance gates reject overhead, reasoning, PTY and backpressure regressions', () => {
  const healthy = deriveAgentKernelMetrics([
    event(0, 'context/composition', { totalTokens: 1000, reasoningTokens: 200 }),
    event(1, 'runtime/performance-sample', { turnWallMs: 1000, modelWaitMs: 700, externalToolMs: 200 }),
    event(2, 'terminal/settlement', { mode: 'marker', durationMs: 10 }),
  ])
  assert.equal(qualifyMetrics(healthy, RUNTIME_PERFORMANCE_GATES).passed, true)

  const unhealthy = deriveAgentKernelMetrics([
    event(0, 'context/composition', { totalTokens: 1000, reasoningTokens: 700 }),
    event(1, 'runtime/performance-sample', { turnWallMs: 1000, modelWaitMs: 400, externalToolMs: 200 }),
    event(2, 'terminal/settlement', { mode: 'prompt', durationMs: 100 }),
    event(3, 'runtime/backpressure', { waitMs: 20, dropped: true }),
  ])
  const result = qualifyMetrics(unhealthy, RUNTIME_PERFORMANCE_GATES)
  assert.equal(result.passed, false)
  assert.equal(result.gates.filter(gate => !gate.passed).length, 4)
})


test('v0.14 queued backpressure admission is abortable without leaking capacity', async () => {
  const gate = new BoundedBackpressureGate({ maxConcurrent: 1, maxQueued: 1 })
  const first = await gate.acquire()
  const controller = new AbortController()
  const queued = gate.acquire(Date.now(), controller.signal)
  controller.abort(new Error('cancel queued child'))
  await assert.rejects(queued, /cancel queued child/)
  assert.equal(gate.snapshot().queued, 0)
  assert.equal(gate.snapshot().active, 1)
  first.release()
  assert.equal(gate.snapshot().active, 0)
})

test('v0.14.1 PTY protocol gate is not polluted by timeout/exit/reset diagnostics', () => {
  const metrics = deriveAgentKernelMetrics([
    event(0, 'context/composition', { totalTokens: 1000, reasoningTokens: 200 }),
    event(1, 'runtime/performance-sample', { turnWallMs: 1000, modelWaitMs: 700, externalToolMs: 200 }),
    event(2, 'terminal/settlement', { mode: 'marker', durationMs: 10 }),
    event(3, 'terminal/settlement', { mode: 'timeout', durationMs: 10 }),
    event(4, 'terminal/settlement', { mode: 'exit', durationMs: 10 }),
    event(5, 'terminal/settlement', { mode: 'reset', durationMs: 10 }),
  ])
  assert.equal(metrics.terminalProtocolFallbackRate, 0)
  assert.equal(metrics.terminalTimeoutRate, 0.25)
  assert.equal(metrics.terminalExitRate, 0.25)
  assert.equal(metrics.terminalResetRate, 0.25)
  assert.equal(qualifyMetrics(metrics, RUNTIME_PERFORMANCE_GATES).passed, true)
})
