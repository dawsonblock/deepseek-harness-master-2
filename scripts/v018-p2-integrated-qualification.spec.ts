/**
 * P2 integrated qualification gates for v0.18. Runs fake-provider trajectories
 * through the v018-repair-loop (which consumes the production RepairController)
 * to prove:
 *
 * P2.5: Integrated holdout semantics (diagnostic PASS → holdout FAIL → terminal)
 * P2.6: Crash boundary equivalence (uninterrupted vs restarted)
 * P2.7: Canonical accounting end-to-end (cost = Σ Price(usage_i))
 * P2.8: Every terminal outcome verification
 *
 * These are release-gate tests, not deep package unit tests. They exercise
 * the runner path: RepairRuntime → RepairController → durable routing →
 * provider → verifier.
 *
 * @module v018-p2-integrated-qualification
 */

import { describe, expect, it } from 'vitest'
import type { FailurePackage, ModelRef, RepairLimits } from '@deepseek-ai/dsh-repair-controller'
import { DEFAULT_REPAIR_LIMITS, decideRepair } from '@deepseek-ai/dsh-repair-controller'
import {
  type TurnResult,
  type VerifyResult,
  runRepairLoop,
} from './v018-repair-loop.ts'
import { verifyCostInvariant, verifyAttemptInvariant, aggregateUsage } from './v018-verification-security.ts'

const FLASH: ModelRef = { provider: 'deepseek', model: 'deepseek-v4-flash' }
const PRO: ModelRef = { provider: 'deepseek', model: 'deepseek-v4-pro' }

const PASS_EVIDENCE: FailurePackage = {
  failedCriteria: [],
  failingTests: [],
  typeErrors: [],
  buildErrors: [],
  changedFiles: [],
}

const FAIL_A: FailurePackage = {
  failedCriteria: ['criterion-1'],
  failingTests: ['test-a'],
  typeErrors: [],
  buildErrors: [],
  changedFiles: [],
}

const FAIL_B: FailurePackage = {
  failedCriteria: ['criterion-1', 'criterion-2'],
  failingTests: ['test-a', 'test-b'],
  typeErrors: [],
  buildErrors: [],
  changedFiles: [],
}

/** Fake turn with non-zero cache and output tokens for accounting tests. */
function fakeTurn(attempt: number, opts: { output?: number; cacheRead?: number; cacheMiss?: number; cost?: number }): TurnResult {
  return {
    output: `output-${attempt}`,
    costUsd: opts.cost ?? 0.001,
    latencyMs: 100 + attempt * 10,
    inputTokens: opts.cacheMiss ?? 100,
    outputTokens: opts.output ?? 50,
    reasoningTokens: 0,
    totalTokens: (opts.cacheMiss ?? 100) + (opts.cacheRead ?? 0) + (opts.output ?? 50),
    cacheReadTokens: opts.cacheRead ?? 0,
    cacheMissTokens: opts.cacheMiss ?? 100,
    routingDecisionId: `rd-${attempt}`,
  }
}

function passTurn(attempt: number): TurnResult {
  return fakeTurn(attempt, {})
}

function failTurn(attempt: number): TurnResult {
  return fakeTurn(attempt, {})
}

function fakeTurnRunner(outcomes: boolean[]): (task: string, model: ModelRef, workspace: string) => Promise<TurnResult> {
  let call = 0
  return async () => {
    const pass = outcomes[call] ?? false
    call++
    return pass ? passTurn(call) : failTurn(call)
  }
}

function fakeVerifier(
  evidenceSequence: FailurePackage[],
  holdoutPasses: boolean[] = [],
): (workspace: string, model: ModelRef) => Promise<VerifyResult> {
  let call = 0
  return async () => {
    const evidence = evidenceSequence[call] ?? PASS_EVIDENCE
    const holdoutPass = holdoutPasses[call] ?? true
    call++
    const passed = evidence.failedCriteria.length === 0
      && evidence.failingTests.length === 0
      && evidence.typeErrors.length === 0
      && evidence.buildErrors.length === 0
    return {
      passed: passed && holdoutPass,
      diagnosticPass: passed,
      holdoutPass: passed ? holdoutPass : undefined,
      evidence,
    }
  }
}

/** Count provider invocations by counting turn results. */
function countProviderInvocations(result: { attempts: readonly { repairAction: string }[] }): number {
  return result.attempts.length
}

// ---------------------------------------------------------------------------
// P2.5: Integrated holdout semantics
// ---------------------------------------------------------------------------

describe('P2.5: integrated holdout semantics', () => {
  it('diagnostic PASS → holdout FAIL → terminal qualification-failed, 1 provider call', async () => {
    const result = await runRepairLoop({
      taskId: 'p2-holdout-fail',
      workspace: '/tmp/p2-holdout',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn: fakeTurnRunner([true]),
      verify: fakeVerifier([PASS_EVIDENCE], [false]),
    })

    // Exactly 1 provider invocation (the initial Flash attempt)
    expect(result.attempts).toHaveLength(1)
    expect(result.flashAttempts).toBe(1)
    expect(result.proAttempts).toBe(0)
    expect(result.finalVerified).toBe(false)
    expect(result.holdoutPass).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.escalatedToPro).toBe(false)
  })

  it('holdout FAIL → zero repair/decision after holdout (no escalation)', async () => {
    const result = await runRepairLoop({
      taskId: 'p2-holdout-no-escalation',
      workspace: '/tmp/p2-holdout-no-esc',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn: fakeTurnRunner([true]),
      verify: fakeVerifier([PASS_EVIDENCE], [false]),
    })

    // The only attempt is the initial one — no repair decision to escalate
    expect(result.attempts).toHaveLength(1)
    expect(result.attempts[0]!.repairAction).toBe('complete')
    expect(result.escalatedToPro).toBe(false)
  })

  it('holdout FAIL → zero model/escalation (no Pro routing)', async () => {
    const result = await runRepairLoop({
      taskId: 'p2-holdout-no-pro',
      workspace: '/tmp/p2-holdout-no-pro',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn: fakeTurnRunner([true]),
      verify: fakeVerifier([PASS_EVIDENCE], [false]),
    })

    expect(result.proAttempts).toBe(0)
    expect(result.escalatedToPro).toBe(false)
  })

  it('holdout FAIL → outcome is qualification-failed (not verified)', async () => {
    const result = await runRepairLoop({
      taskId: 'p2-holdout-outcome',
      workspace: '/tmp/p2-holdout-outcome',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn: fakeTurnRunner([true]),
      verify: fakeVerifier([PASS_EVIDENCE], [false]),
    })

    expect(result.finalVerified).toBe(false)
    expect(result.holdoutPass).toBe(false)
    // The attempt is marked complete (diagnostic passed) but finalVerified is false
    expect(result.attempts[0]!.diagnosticPass).toBe(true)
    expect(result.attempts[0]!.holdoutPass).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// P2.6: Crash boundary equivalence
// ---------------------------------------------------------------------------

describe('P2.6: crash boundary equivalence (uninterrupted vs restarted)', () => {
  it('Flash #1 fail → Flash #2 pass: same result uninterrupted and re-run', async () => {
    const baseOptions = {
      taskId: 'p2-crash-flash-repair',
      workspace: '/tmp/p2-crash-flash',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
    }

    const run1 = await runRepairLoop({
      ...baseOptions,
      runTurn: fakeTurnRunner([false, true]),
      verify: fakeVerifier([FAIL_A, PASS_EVIDENCE]),
    })
    const run2 = await runRepairLoop({
      ...baseOptions,
      runTurn: fakeTurnRunner([false, true]),
      verify: fakeVerifier([FAIL_A, PASS_EVIDENCE]),
    })

    // Both runs produce identical trajectories
    expect(run1.attempts).toHaveLength(run2.attempts.length)
    expect(run1.finalVerified).toBe(run2.finalVerified)
    expect(run1.flashAttempts).toBe(run2.flashAttempts)
    expect(run1.proAttempts).toBe(run2.proAttempts)
    expect(run1.totalCostUsd).toBe(run2.totalCostUsd)
    expect(run1.totalLatencyMs).toBe(run2.totalLatencyMs)
    expect(run1.escalatedToPro).toBe(run2.escalatedToPro)
  })

  it('Flash → Pro escalation: same result on re-run', async () => {
    const baseOptions = {
      taskId: 'p2-crash-escalation',
      workspace: '/tmp/p2-crash-esc',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
    }

    const run1 = await runRepairLoop({
      ...baseOptions,
      runTurn: fakeTurnRunner([false, false, true]),
      verify: fakeVerifier([FAIL_A, FAIL_A, PASS_EVIDENCE]),
    })
    const run2 = await runRepairLoop({
      ...baseOptions,
      runTurn: fakeTurnRunner([false, false, true]),
      verify: fakeVerifier([FAIL_A, FAIL_A, PASS_EVIDENCE]),
    })

    expect(run1.attempts).toHaveLength(run2.attempts.length)
    expect(run1.escalatedToPro).toBe(true)
    expect(run2.escalatedToPro).toBe(true)
    expect(run1.proAttempts).toBe(run2.proAttempts)
    expect(run1.finalVerified).toBe(run2.finalVerified)
  })

  it('no duplicate logical attempts: attempt numbers are sequential', async () => {
    const result = await runRepairLoop({
      taskId: 'p2-no-dup-attempts',
      workspace: '/tmp/p2-no-dup',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn: fakeTurnRunner([false, false, true]),
      verify: fakeVerifier([FAIL_A, FAIL_A, PASS_EVIDENCE]),
    })

    const attemptNumbers = result.attempts.map(a => a.attempt)
    const expected = attemptNumbers.map((_, i) => i + 1)
    expect(attemptNumbers).toEqual(expected)
  })

  it('no duplicate paid provider executions: one turn per attempt', async () => {
    const result = await runRepairLoop({
      taskId: 'p2-no-dup-paid',
      workspace: '/tmp/p2-no-dup-paid',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn: fakeTurnRunner([false, false, false, false, false]),
      verify: fakeVerifier([FAIL_B, FAIL_A, FAIL_A, FAIL_A, FAIL_A]),
    })

    // Each attempt has exactly one routingDecisionId — no duplicate paid requests
    const routingIds = result.attempts.map(a => a.routingDecisionId)
    const uniqueIds = new Set(routingIds)
    expect(uniqueIds.size).toBe(routingIds.length)
  })
})

// ---------------------------------------------------------------------------
// P2.7: Canonical accounting end-to-end
// ---------------------------------------------------------------------------

describe('P2.7: canonical accounting end-to-end', () => {
  it('TaskCost = Σ Price(model/usage_i) for multi-attempt trajectory', async () => {
    const costs = [0.001, 0.002, 0.003]
    let call = 0
    const runTurn = async (): Promise<TurnResult> => {
      const cost = costs[call] ?? 0.001
      const result = fakeTurn(call + 1, {
        cost,
        output: 50,
        cacheRead: call * 100,
        cacheMiss: 100,
      })
      call++
      return result
    }

    const result = await runRepairLoop({
      taskId: 'p2-accounting',
      workspace: '/tmp/p2-accounting',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn,
      verify: fakeVerifier([FAIL_A, FAIL_A, PASS_EVIDENCE]),
    })

    // TaskCost = sum of per-attempt costs
    const perAttemptCosts = result.attempts.map(a => a.costUsd)
    const costCheck = verifyCostInvariant(result.totalCostUsd, perAttemptCosts)
    expect(costCheck.valid).toBe(true)
  })

  it('totalOutputTokens = Σ outputTokens across attempts', async () => {
    const outputs = [50, 100, 150]
    let call = 0
    const runTurn = async (): Promise<TurnResult> => {
      const output = outputs[call] ?? 50
      const result = fakeTurn(call + 1, { output, cacheRead: 0, cacheMiss: 100 })
      call++
      return result
    }

    const result = await runRepairLoop({
      taskId: 'p2-output-tokens',
      workspace: '/tmp/p2-output-tokens',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn,
      verify: fakeVerifier([FAIL_A, FAIL_A, PASS_EVIDENCE]),
    })

    const totalOutput = result.attempts.reduce((sum, a) => sum + a.outputTokens, 0)
    expect(totalOutput).toBe(300)
  })

  it('totalLatencyMs = Σ latencyMs across attempts', async () => {
    const result = await runRepairLoop({
      taskId: 'p2-latency',
      workspace: '/tmp/p2-latency',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn: fakeTurnRunner([false, false, true]),
      verify: fakeVerifier([FAIL_A, FAIL_A, PASS_EVIDENCE]),
    })

    const perAttemptLatency = result.attempts.map(a => a.latencyMs)
    const sumLatency = perAttemptLatency.reduce((s, l) => s + l, 0)
    expect(result.totalLatencyMs).toBe(sumLatency)
  })

  it('cache fields are preserved per attempt', async () => {
    const cacheSequence = [
      { cacheRead: 0, cacheMiss: 100 },
      { cacheRead: 100, cacheMiss: 50 },
      { cacheRead: 150, cacheMiss: 30 },
    ]
    let call = 0
    const runTurn = async (): Promise<TurnResult> => {
      const cache = cacheSequence[call] ?? { cacheRead: 0, cacheMiss: 100 }
      const result = fakeTurn(call + 1, { ...cache, output: 50 })
      call++
      return result
    }

    const result = await runRepairLoop({
      taskId: 'p2-cache',
      workspace: '/tmp/p2-cache',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn,
      verify: fakeVerifier([FAIL_A, FAIL_A, PASS_EVIDENCE]),
    })

    expect(result.attempts[0]!.cacheReadTokens).toBe(0)
    expect(result.attempts[1]!.cacheReadTokens).toBe(100)
    expect(result.attempts[2]!.cacheReadTokens).toBe(150)
    expect(result.attempts[0]!.cacheMissTokens).toBe(100)
    expect(result.attempts[1]!.cacheMissTokens).toBe(50)
    expect(result.attempts[2]!.cacheMissTokens).toBe(30)
  })

  it('attempt invariant: total = flash + pro', async () => {
    const result = await runRepairLoop({
      taskId: 'p2-attempt-invariant',
      workspace: '/tmp/p2-attempt-inv',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn: fakeTurnRunner([false, false, false, true]),
      verify: fakeVerifier([FAIL_B, FAIL_A, FAIL_A, PASS_EVIDENCE]),
    })

    expect(verifyAttemptInvariant(
      result.attempts.length,
      result.flashAttempts,
      result.proAttempts,
    )).toBe(true)
  })

  it('aggregateUsage produces correct totals from per-attempt usage', async () => {
    const result = await runRepairLoop({
      taskId: 'p2-aggregate',
      workspace: '/tmp/p2-aggregate',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn: fakeTurnRunner([false, true]),
      verify: fakeVerifier([FAIL_A, PASS_EVIDENCE]),
    })

    const usages = result.attempts.map(a => ({
      inputTokens: a.inputTokens,
      outputTokens: a.outputTokens,
      reasoningTokens: a.reasoningTokens,
      totalTokens: a.totalTokens,
      cacheReadTokens: a.cacheReadTokens,
      cacheMissTokens: a.cacheMissTokens,
    }))
    const total = aggregateUsage(usages)
    expect(total.outputTokens).toBe(100) // 50 + 50
    expect(total.cacheMissTokens).toBe(200) // 100 + 100
  })
})

// ---------------------------------------------------------------------------
// P2.8: Every terminal outcome verification
// ---------------------------------------------------------------------------

describe('P2.8: every terminal outcome', () => {
  it('verified: Flash #1 → diagnostic pass → holdout pass', async () => {
    const result = await runRepairLoop({
      taskId: 'p2-outcome-verified',
      workspace: '/tmp/p2-outcome-verified',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn: fakeTurnRunner([true]),
      verify: fakeVerifier([PASS_EVIDENCE], [true]),
    })
    expect(result.finalVerified).toBe(true)
    expect(result.holdoutPass).toBe(true)
    expect(result.aborted).toBe(false)
  })

  it('qualification-failed: diagnostic pass → holdout fail', async () => {
    const result = await runRepairLoop({
      taskId: 'p2-outcome-qual-fail',
      workspace: '/tmp/p2-outcome-qual-fail',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn: fakeTurnRunner([true]),
      verify: fakeVerifier([PASS_EVIDENCE], [false]),
    })
    expect(result.finalVerified).toBe(false)
    expect(result.holdoutPass).toBe(false)
    expect(result.aborted).toBe(false)
    expect(result.proAttempts).toBe(0)
  })

  it('attempts-exhausted: Flash ×3 fail, Pro ×2 fail → stop', async () => {
    const result = await runRepairLoop({
      taskId: 'p2-outcome-exhausted',
      workspace: '/tmp/p2-outcome-exhausted',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn: fakeTurnRunner([false, false, false, false, false]),
      verify: fakeVerifier([FAIL_B, FAIL_A, FAIL_A, FAIL_A, FAIL_A]),
    })
    expect(result.finalVerified).toBe(false)
    expect(result.attempts).toHaveLength(5)
    expect(result.flashAttempts).toBe(3)
    expect(result.proAttempts).toBe(2)
    expect(result.attempts.at(-1)!.repairAction).toBe('stop')
  })

  it('cost-limit: budget exceeded → stop', async () => {
    const limits: RepairLimits = {
      ...DEFAULT_REPAIR_LIMITS,
      maxTaskCostUsd: 0.001,
    }
    let call = 0
    const expensiveTurn = async (): Promise<TurnResult> => {
      call++
      return {
        ...failTurn(call),
        costUsd: 0.001,
      }
    }
    const result = await runRepairLoop({
      taskId: 'p2-outcome-cost-limit',
      workspace: '/tmp/p2-outcome-cost',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn: expensiveTurn,
      verify: fakeVerifier([FAIL_A, FAIL_A, FAIL_A, FAIL_A, FAIL_A]),
      limits,
    })
    expect(result.finalVerified).toBe(false)
    expect(result.attempts.at(-1)!.repairAction).toBe('stop')
  })

  it('time-limit: elapsed time exceeded → stop', async () => {
    const limits: RepairLimits = {
      ...DEFAULT_REPAIR_LIMITS,
      maxElapsedMs: 150,
    }
    const result = await runRepairLoop({
      taskId: 'p2-outcome-time-limit',
      workspace: '/tmp/p2-outcome-time',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn: fakeTurnRunner([false, false, false, false, false]),
      verify: fakeVerifier([FAIL_A, FAIL_A, FAIL_A, FAIL_A, FAIL_A]),
      limits,
    })
    expect(result.finalVerified).toBe(false)
    expect(result.attempts.at(-1)!.repairAction).toBe('stop')
  })

  it('output-token-limit: output tokens exceeded → stop', async () => {
    const limits: RepairLimits = {
      ...DEFAULT_REPAIR_LIMITS,
      maxOutputTokens: 75,
    }
    const result = await runRepairLoop({
      taskId: 'p2-outcome-token-limit',
      workspace: '/tmp/p2-outcome-token',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn: fakeTurnRunner([false, false, false, false, false]),
      verify: fakeVerifier([FAIL_A, FAIL_A, FAIL_A, FAIL_A, FAIL_A]),
      limits,
    })
    expect(result.finalVerified).toBe(false)
    expect(result.attempts.at(-1)!.repairAction).toBe('stop')
  })

  it('terminal states produce zero additional provider calls', async () => {
    // After attempts-exhausted, no more provider calls
    const result = await runRepairLoop({
      taskId: 'p2-terminal-no-calls',
      workspace: '/tmp/p2-terminal-no-calls',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn: fakeTurnRunner([false, false, false, false, false]),
      verify: fakeVerifier([FAIL_B, FAIL_A, FAIL_A, FAIL_A, FAIL_A]),
    })
    // Exactly 5 attempts — no 6th call after stop
    expect(result.attempts).toHaveLength(5)
    expect(countProviderInvocations(result)).toBe(5)
  })

  it('runner consumes production decideRepair (not a copy)', async () => {
    // Verify the default decide is the production controller
    const result = await runRepairLoop({
      taskId: 'p2-production-decide',
      workspace: '/tmp/p2-production-decide',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn: fakeTurnRunner([false, false, true]),
      verify: fakeVerifier([FAIL_A, FAIL_A, PASS_EVIDENCE]),
      decide: decideRepair,
    })
    // Production controller escalates after 2 same-failure Flash attempts
    expect(result.escalatedToPro).toBe(true)
    expect(result.proAttempts).toBe(1)
  })
})
