import assert from 'node:assert/strict'
import {
  BackpressureRejectedError,
  BoundedBackpressureGate,
  RUNTIME_PERFORMANCE_GATES,
  ResourceBudgetExceededError,
  RootResourceGovernor,
  deriveAgentKernelMetrics,
  qualifyMetrics,
} from '../packages/runtime/agent-kernel-hardening/lib/index.js'

const event = (seq, type, data, time = seq * 10) => ({ seq, type, data, time, ignorable: true })
let checks = 0
const check = (condition, message) => { assert.ok(condition, message); checks += 1 }

// A realistic healthy turn: 72% model wait, 18% external tools, 10% orchestration.
const healthyEvents = [
  event(0, 'context/composition', { totalTokens: 32000, reasoningTokens: 6400 }),
  event(1, 'context/composition', { totalTokens: 40000, reasoningTokens: 10000 }),
  event(2, 'runtime/performance-sample', { turnWallMs: 1000, modelWaitMs: 720, externalToolMs: 180 }),
]
for (let i = 0; i < 100; i += 1) healthyEvents.push(event(3 + i, 'terminal/settlement', { mode: i < 98 ? 'marker' : 'prompt', durationMs: 5 }))
healthyEvents.push(event(104, 'runtime/backpressure', { waitMs: 3, dropped: false }))
const healthy = deriveAgentKernelMetrics(healthyEvents)
check(healthy.orchestrationOverheadRatio === 0.1, 'healthy orchestration ratio should be 10%')
check(healthy.p95ReasoningContextRatio !== null && healthy.p95ReasoningContextRatio <= 0.25, 'reasoning ratio should stay bounded')
check(healthy.terminalFallbackRate === 0.02, 'PTY fallback rate should be 2%')
check(healthy.backpressureDrops === 0, 'healthy path must not drop work')
check(qualifyMetrics(healthy, RUNTIME_PERFORMANCE_GATES).passed, 'healthy runtime must pass required performance gates')

const regressed = deriveAgentKernelMetrics([
  event(0, 'context/composition', { totalTokens: 10000, reasoningTokens: 7000 }),
  event(1, 'runtime/performance-sample', { turnWallMs: 1000, modelWaitMs: 350, externalToolMs: 250 }),
  event(2, 'terminal/settlement', { mode: 'silence', durationMs: 200 }),
  event(3, 'runtime/backpressure', { waitMs: 100, dropped: true }),
])
const failedGates = qualifyMetrics(regressed, RUNTIME_PERFORMANCE_GATES)
check(!failedGates.passed, 'regressed runtime must fail qualification')
check(failedGates.gates.filter(gate => !gate.passed).length === 4, 'all four v0.14 regression gates should fail')

const governor = new RootResourceGovernor({
  maxConcurrentOneShotChildren: 2,
  maxDescendantsStarted: 4,
  maxSubagentStartsPerMinute: 4,
  maxModelCalls: 3,
  maxReasoningTokens: 1000,
  maxEventBytes: 4096,
  maxWallTimeMs: 5000,
})
const a = governor.admitSubagent('root', 'one-shot', 0); a.commit()
const b = governor.admitSubagent('root', 'one-shot', 1); b.commit()
assert.throws(() => governor.admitSubagent('root', 'one-shot', 2), error => error instanceof ResourceBudgetExceededError && error.dimension === 'concurrent-one-shot-children')
checks += 1
a.release(); b.release()
governor.recordModelUsage('root', 3, 1000)
assert.throws(() => governor.recordModelUsage('root', 1, 0), ResourceBudgetExceededError); checks += 1
governor.recordEventBytes('root', 4096)
assert.throws(() => governor.recordEventBytes('root', 1), ResourceBudgetExceededError); checks += 1
governor.recordWallTime('root', 5000)
assert.throws(() => governor.recordWallTime('root', 1), ResourceBudgetExceededError); checks += 1

const gate = new BoundedBackpressureGate({ maxConcurrent: 1, maxQueued: 1 })
const first = await gate.acquire()
const queued = gate.acquire()
await assert.rejects(gate.acquire(), error => error instanceof BackpressureRejectedError && error.reason === 'queue-full'); checks += 1
first.release()
const second = await queued
check(gate.snapshot().admitted === 2, 'FIFO gate should admit the queued request after release')
second.release()
check(gate.snapshot().active === 0, 'all backpressure leases should release cleanly')

console.log(`v0.14 runtime performance/resource qualification: ${checks}/${checks} PASS`)
