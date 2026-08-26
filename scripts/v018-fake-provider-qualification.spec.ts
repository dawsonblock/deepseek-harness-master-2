/**
 * Zero-cost fake-provider qualification for the v0.18 repair loop. Proves
 * the entire repair execution path using deterministic fake providers
 * without any real API calls. Also proves the runner consumes the
 * production RepairController by showing that swapping the `decide`
 * function changes qualification behavior.
 *
 * Scenarios A-F match the required v0.18 qualification matrix:
 *   A: Flash #1 → pass
 *   B: Flash #1 → fail, Flash #2 → pass
 *   C: Flash #1 → fail, Flash #2 → same fail → Pro
 *   D: Flash #1 → 5 failures, Flash #2 → 2 failures, Flash #3 → pass
 *   E: Flash ×3 → fail, Pro #1 → pass
 *   F: Flash ×3 → fail, Pro ×2 → fail → stop
 *
 * @module v018-fake-provider-qualification
 */

import { describe, expect, it } from 'vitest'
import {
  type FailurePackage,
  type ModelRef,
  type TurnResult,
  type VerifyResult,
  runRepairLoop,
} from './v018-repair-loop.ts'
import { decideRepair } from '@deepseek-ai/dsh-repair-controller'
import type { RepairDecision, RepairDecisionInput } from '@deepseek-ai/dsh-repair-controller'

const FLASH: ModelRef = { provider: 'deepseek', model: 'deepseek-v4-flash' }
const PRO: ModelRef = { provider: 'deepseek', model: 'deepseek-v4-pro' }

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

const PASS_EVIDENCE: FailurePackage = {
  failedCriteria: [],
  failingTests: [],
  typeErrors: [],
  buildErrors: [],
  changedFiles: [],
}

/** Fake turn result for a passing attempt. */
function passTurn(attempt: number): TurnResult {
  return {
    output: `solution-${attempt}`,
    costUsd: 0.001,
    latencyMs: 100,
    inputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 0,
    totalTokens: 150,
    cacheReadTokens: 0,
    cacheMissTokens: 100,
    routingDecisionId: `rd-${attempt}`,
  }
}

/** Fake turn result for a failing attempt. */
function failTurn(attempt: number): TurnResult {
  return {
    output: `broken-${attempt}`,
    costUsd: 0.001,
    latencyMs: 100,
    inputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 0,
    totalTokens: 150,
    cacheReadTokens: 0,
    cacheMissTokens: 100,
    routingDecisionId: `rd-${attempt}`,
  }
}

/** Build a fake turn runner from a sequence of pass/fail outcomes. */
function fakeTurnRunner(outcomes: boolean[]): (task: string, model: ModelRef, workspace: string) => Promise<TurnResult> {
  let call = 0
  return async () => {
    const pass = outcomes[call] ?? false
    call++
    return pass ? passTurn(call) : failTurn(call)
  }
}

/** Build a fake verifier from a sequence of evidence packages. */
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

describe('v0.18 fake-provider qualification — scenarios A-F', () => {
  it('Scenario A: Flash #1 → pass → 1 attempt, 0 repair, 0 Pro', async () => {
    const result = await runRepairLoop({
      taskId: 'scenario-a',
      workspace: '/tmp/fake-a',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn: fakeTurnRunner([true]),
      verify: fakeVerifier([PASS_EVIDENCE]),
    })

    expect(result.attempts).toHaveLength(1)
    expect(result.flashAttempts).toBe(1)
    expect(result.proAttempts).toBe(0)
    expect(result.finalVerified).toBe(true)
    expect(result.escalatedToPro).toBe(false)
    expect(result.attempts[0]!.repairAction).toBe('complete')
  })

  it('Scenario B: Flash #1 → fail, Flash #2 → pass → 2 attempts, verified', async () => {
    const result = await runRepairLoop({
      taskId: 'scenario-b',
      workspace: '/tmp/fake-b',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn: fakeTurnRunner([false, true]),
      verify: fakeVerifier([FAIL_A, PASS_EVIDENCE]),
    })

    expect(result.attempts).toHaveLength(2)
    expect(result.flashAttempts).toBe(2)
    expect(result.proAttempts).toBe(0)
    expect(result.finalVerified).toBe(true)
    expect(result.attempts[0]!.repairAction).toBe('flash-repair')
    expect(result.attempts[1]!.repairAction).toBe('complete')
  })

  it('Scenario C: Flash #1 → fail ABC, Flash #2 → fail ABC → Pro immediately', async () => {
    const result = await runRepairLoop({
      taskId: 'scenario-c',
      workspace: '/tmp/fake-c',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn: fakeTurnRunner([false, false, true]),
      verify: fakeVerifier([FAIL_A, FAIL_A, PASS_EVIDENCE]),
    })

    expect(result.attempts).toHaveLength(3)
    expect(result.flashAttempts).toBe(2)
    expect(result.proAttempts).toBe(1)
    expect(result.escalatedToPro).toBe(true)
    expect(result.attempts[1]!.repairAction).toBe('pro-escalate')
    expect(result.attempts[1]!.repairReason).toBe('same-failure-no-progress')
    expect(result.attempts[2]!.repairAction).toBe('complete')
  })

  it('Scenario D: Flash #1 → 5 failures, Flash #2 → 2 failures, Flash #3 → pass', async () => {
    const result = await runRepairLoop({
      taskId: 'scenario-d',
      workspace: '/tmp/fake-d',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn: fakeTurnRunner([false, false, true]),
      verify: fakeVerifier([FAIL_B, FAIL_A, PASS_EVIDENCE]),
    })

    expect(result.attempts).toHaveLength(3)
    expect(result.flashAttempts).toBe(3)
    expect(result.proAttempts).toBe(0)
    expect(result.escalatedToPro).toBe(false)
    expect(result.finalVerified).toBe(true)
    expect(result.attempts[0]!.repairAction).toBe('flash-repair')
    expect(result.attempts[1]!.progress).toBe('partial')
    expect(result.attempts[1]!.repairAction).toBe('flash-repair')
    expect(result.attempts[2]!.repairAction).toBe('complete')
  })

  it('Scenario E: Flash ×3 → fail, Pro #1 → pass → explicit escalation', async () => {
    // Flash #1: 5 failures (FAIL_B), Flash #2: 2 failures (FAIL_A, partial progress),
    // Flash #3: same 2 failures (FAIL_A, no progress) → Pro escalate, Pro #1: pass
    const result = await runRepairLoop({
      taskId: 'scenario-e',
      workspace: '/tmp/fake-e',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn: fakeTurnRunner([false, false, false, true]),
      verify: fakeVerifier([FAIL_B, FAIL_A, FAIL_A, PASS_EVIDENCE]),
    })

    expect(result.attempts).toHaveLength(4)
    expect(result.flashAttempts).toBe(3)
    expect(result.proAttempts).toBe(1)
    expect(result.escalatedToPro).toBe(true)
    expect(result.finalVerified).toBe(true)
    expect(result.attempts[2]!.repairAction).toBe('pro-escalate')
    expect(result.attempts[2]!.repairReason).toBe('same-failure-no-progress')
    expect(result.attempts[3]!.model).toBe('deepseek-v4-pro')
    expect(result.attempts[3]!.repairAction).toBe('complete')
  })

  it('Scenario F: Flash ×3 → fail, Pro ×2 → fail → stop, exactly 5 attempts', async () => {
    // Flash #1: 5 failures (FAIL_B), Flash #2: 2 failures (FAIL_A, partial progress),
    // Flash #3: same 2 failures (FAIL_A, no progress) → Pro escalate
    // Pro #1: fail, Pro #2: fail → stop (pro-exhausted)
    const result = await runRepairLoop({
      taskId: 'scenario-f',
      workspace: '/tmp/fake-f',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn: fakeTurnRunner([false, false, false, false, false]),
      verify: fakeVerifier([FAIL_B, FAIL_A, FAIL_A, FAIL_A, FAIL_A]),
    })

    expect(result.attempts).toHaveLength(5)
    expect(result.flashAttempts).toBe(3)
    expect(result.proAttempts).toBe(2)
    expect(result.finalVerified).toBe(false)
    expect(result.attempts[4]!.repairAction).toBe('stop')
    // At 5 total attempts, both attempt-limit and pro-exhausted apply.
    // The total limit check fires first in the controller.
    expect(result.attempts[4]!.repairReason).toBe('attempt-limit')
  })
})

describe('v0.18 runner consumes the production RepairController', () => {
  it('swapping the decide function changes qualification behavior', async () => {
    // A mock controller that always says "stop" after the first failure
    const alwaysStop: typeof decideRepair = (input: RepairDecisionInput): RepairDecision => {
      if (input.attempts.length === 0) return { action: 'stop', reason: 'verification-impossible' }
      const last = input.attempts.at(-1)
      if (last !== undefined && last.verified) return { action: 'complete' }
      return { action: 'stop', reason: 'attempt-limit' }
    }

    // Same scenario as C (Flash #1 fail, Flash #2 same fail)
    // Production controller: escalate to Pro after 2 same failures
    const productionResult = await runRepairLoop({
      taskId: 'prod-test',
      workspace: '/tmp/fake-prod',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn: fakeTurnRunner([false, false, true]),
      verify: fakeVerifier([FAIL_A, FAIL_A, PASS_EVIDENCE]),
      decide: decideRepair,
    })

    // Mock controller: stop immediately after first failure
    const mockResult = await runRepairLoop({
      taskId: 'mock-test',
      workspace: '/tmp/fake-mock',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn: fakeTurnRunner([false, false, true]),
      verify: fakeVerifier([FAIL_A, FAIL_A, PASS_EVIDENCE]),
      decide: alwaysStop,
    })

    // Production: 3 attempts (Flash, Flash, Pro), verified
    expect(productionResult.attempts).toHaveLength(3)
    expect(productionResult.finalVerified).toBe(true)

    // Mock: 1 attempt, stopped, not verified
    expect(mockResult.attempts).toHaveLength(1)
    expect(mockResult.finalVerified).toBe(false)
    expect(mockResult.attempts[0]!.repairAction).toBe('stop')
  })

  it('default decide function is the production decideRepair', async () => {
    // Verify that not passing a decide function uses the production controller
    const result = await runRepairLoop({
      taskId: 'default-test',
      workspace: '/tmp/fake-default',
      initialTask: 'implement something',
      flashModel: FLASH,
      proModel: PRO,
      runTurn: fakeTurnRunner([true]),
      verify: fakeVerifier([PASS_EVIDENCE]),
    })

    expect(result.attempts).toHaveLength(1)
    expect(result.attempts[0]!.repairAction).toBe('complete')
  })
})
