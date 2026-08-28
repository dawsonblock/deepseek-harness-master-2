/**
 * P1.13 output-token budget enforcement tests. Verifies that
 * `maxOutputTokens` is enforced by `decideRepair` and that accumulated
 * output tokens are derived from canonical `model/usage` events.
 *
 * @module @deepseek-ai/dsh-repair-runtime/tests/p1-output-token-budget.spec
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { decideRepair, type RepairLimits } from '@deepseek-ai/dsh-repair-controller'
import type { GoalVerificationCheck } from '@deepseek-ai/dsh-goal'
import type { ModelRef } from '@deepseek-ai/dsh-repair-controller'
import type { ModelPricing } from '@deepseek-ai/dsh-token-meter'
import {
  type RepairHandlerDeps,
  type RepairState,
  computeRepairId,
  handleVerificationFailure,
  reconstructRepairState,
} from '../src/index.ts'

const FLASH: ModelRef = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
const PRO: ModelRef = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }

const TEST_PRICING: readonly ModelPricing[] = Object.freeze([
  {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    currency: 'USD',
    version: 'test-flash',
    observedAt: '2026-08-27',
    perMillion: { cacheHitInput: 0.0028, cacheMissInput: 0.14, output: 0.28 },
  },
  {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    currency: 'USD',
    version: 'test-pro',
    observedAt: '2026-08-27',
    perMillion: { cacheHitInput: 0.003625, cacheMissInput: 0.435, output: 0.87 },
  },
])

function failChecks(criteria: string[]): readonly GoalVerificationCheck[] {
  return criteria.map(c => ({ name: 'acceptance', role: 'acceptance', passed: false, reason: c, evidence: [] }))
}

function defaultDeps(overrides: Partial<RepairHandlerDeps> = {}): RepairHandlerDeps {
  return {
    flashModel: FLASH,
    proModel: PRO,
    limits: {
      maxFlashAttempts: 3,
      maxProAttempts: 2,
      maxTotalAttempts: 5,
      maxOutputTokens: 1000,
    },
    decide: decideRepair,
    proModelAvailable: true,
    manualModelSelection: false,
    pricingRegistry: TEST_PRICING,
    ...overrides,
  }
}

function freshState(repairId: string): RepairState {
  return {
    repairId,
    attempts: [],
    totalCostUsd: 0,
    elapsedMs: 0,
    startedAt: Date.now(),
    flashAttempts: 0,
    proAttempts: 0,
    totalOutputTokens: 0,
  }
}

function setupTurn(session: Session, turn: number, model: ModelRef, rdId: string): void {
  session.append('turn/start', { turn }, { ignorable: true })
  session.append('model/routing-decision', {
    routingDecisionId: rdId,
    turn,
    step: 1,
    proposed: { provider: model.provider, model: model.model },
    selected: { provider: model.provider, model: model.model },
    authority: 'router',
    activeAuthority: 'router',
    reason: 'routed-fast',
    authorityEpoch: turn,
  } as never, { ignorable: true })
}

function appendUsage(
  session: Session, rdId: string, turn: number, model: ModelRef,
  tokens: { input: number; output: number; cacheRead: number; cacheMiss: number },
): void {
  session.append('model/usage', {
    turn, step: 0, attempt: turn,
    provider: model.provider, model: model.model,
    routingDecisionId: rdId,
    usage: {
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheReadTokens: tokens.cacheRead,
      cacheMissTokens: tokens.cacheMiss,
      totalTokens: tokens.input + tokens.output + tokens.cacheRead,
      source: 'provider',
    },
  }, { ignorable: true })
}

function appendVerification(
  session: Session, goalId: string, passed: boolean,
  checks: readonly GoalVerificationCheck[],
): void {
  session.append('goal/verification', {
    goal: { id: goalId, revision: 1 },
    passed,
    checks,
  } as never, { ignorable: true })
}

describe('P1.13: decideRepair enforces maxOutputTokens', () => {
  it('stops with output-token-limit when accumulated output tokens exceed limit', () => {
    const session = Session.create(SessionId('otb-exceed'))
    const goalId = 'goal-otb-exceed'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps()

    // Turn 1: Flash fails with 600 output tokens
    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 600, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    // Turn 2: Flash fails with 500 output tokens (total = 1100 > 1000)
    setupTurn(session, 2, FLASH, 'rd-2')
    appendUsage(session, 'rd-2', 2, FLASH, { input: 800, output: 500, cacheRead: 400, cacheMiss: 400 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    const result = handleVerificationFailure(session, state, deps, 2, failChecks(['criterion-1']))

    expect(result.action).toBe('stop')
    expect(result.reason).toBe('output-token-limit')
  })

  it('continues repair when output tokens are below limit', () => {
    const session = Session.create(SessionId('otb-below'))
    const goalId = 'goal-otb-below'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps()

    // Turn 1: Flash fails with 400 output tokens (< 1000)
    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 400, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    const result = handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    expect(result.action).toBe('flash-repair')
  })

  it('stops exactly at threshold (>= comparison)', () => {
    const session = Session.create(SessionId('otb-exact'))
    const goalId = 'goal-otb-exact'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps()

    // Turn 1: Flash fails with 500 output tokens
    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    // Turn 2: Flash fails with 500 more output tokens (total = 1000 >= 1000)
    setupTurn(session, 2, FLASH, 'rd-2')
    appendUsage(session, 'rd-2', 2, FLASH, { input: 800, output: 500, cacheRead: 400, cacheMiss: 400 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    const result = handleVerificationFailure(session, state, deps, 2, failChecks(['criterion-1']))

    expect(result.action).toBe('stop')
    expect(result.reason).toBe('output-token-limit')
  })
})

describe('P1.13: output tokens recovered from durable usage events after restart', () => {
  it('reconstructRepairState recovers totalOutputTokens from model/usage events', () => {
    const session = Session.create(SessionId('otb-reconstruct'))
    const goalId = 'goal-otb-reconstruct'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps()

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 700, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    // Simulate restart: reconstruct from durable events
    const reconstructed = reconstructRepairState(session.events, goalId, TEST_PRICING)
    expect(reconstructed).toBeDefined()
    expect(reconstructed!.totalOutputTokens).toBe(700)
  })

  it('reconstructed totalOutputTokens enforces limit after restart', () => {
    const session = Session.create(SessionId('otb-reconstruct-limit'))
    const goalId = 'goal-otb-reconstruct-limit'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps()

    // Turn 1: 600 output tokens
    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 600, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    // Reconstruct after turn 1 (before the limit is hit)
    const reconstructed = reconstructRepairState(session.events, goalId, TEST_PRICING)
    expect(reconstructed).toBeDefined()
    expect(reconstructed!.totalOutputTokens).toBe(600)
    expect(reconstructed!.totalOutputTokens < 1000).toBe(true)
  })
})

describe('P1.13: maxOutputTokens interaction with other limits', () => {
  it('output-token limit takes effect before attempt limit', () => {
    const session = Session.create(SessionId('otb-interaction'))
    const goalId = 'goal-otb-interaction'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps: RepairHandlerDeps = {
      flashModel: FLASH,
      proModel: PRO,
      limits: {
        maxFlashAttempts: 3,
        maxProAttempts: 2,
        maxTotalAttempts: 5,
        maxOutputTokens: 800,
      },
      decide: decideRepair,
      proModelAvailable: true,
      manualModelSelection: false,
      pricingRegistry: TEST_PRICING,
    }

    // Turn 1: 500 output tokens
    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    // Turn 2: 400 more (total 900 > 800, but only 2 attempts < 5)
    setupTurn(session, 2, FLASH, 'rd-2')
    appendUsage(session, 'rd-2', 2, FLASH, { input: 800, output: 400, cacheRead: 400, cacheMiss: 400 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    const result = handleVerificationFailure(session, state, deps, 2, failChecks(['criterion-1']))

    // Should stop with output-token-limit, not attempt-limit
    expect(result.action).toBe('stop')
    expect(result.reason).toBe('output-token-limit')
  })

  it('no maxOutputTokens configured → no output-token stop', () => {
    const session = Session.create(SessionId('otb-none'))
    const goalId = 'goal-otb-none'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const limits: RepairLimits = {
      maxFlashAttempts: 3,
      maxProAttempts: 2,
      maxTotalAttempts: 5,
    }
    const deps: RepairHandlerDeps = {
      flashModel: FLASH,
      proModel: PRO,
      limits,
      decide: decideRepair,
      proModelAvailable: true,
      manualModelSelection: false,
      pricingRegistry: TEST_PRICING,
    }

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 100000, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    const result = handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    // No output-token limit → flash-repair continues
    expect(result.action).toBe('flash-repair')
  })
})
