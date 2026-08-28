/**
 * P1.2 budget gate tests. Verifies that the existing cost and time budget
 * gates in `decideRepair` are reachable with real cost and elapsed time
 * flowing through `RepairState`, and that the `RepairRuntimeConfig` exposes
 * these limits as configurable fields.
 *
 * @module @deepseek-ai/dsh-repair-runtime/tests/p1-budget-gates.spec
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { DEFAULT_REPAIR_LIMITS, decideRepair } from '@deepseek-ai/dsh-repair-controller'
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
    limits: DEFAULT_REPAIR_LIMITS,
    decide: decideRepair,
    proModelAvailable: true,
    manualModelSelection: false,
    pricingRegistry: TEST_PRICING,
    ...overrides,
  }
}

function freshState(repairId: string, startedAt = Date.now()): RepairState {
  return {
    repairId,
    attempts: [],
    totalCostUsd: 0,
    elapsedMs: 0,
    startedAt,
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

function appendVerification(session: Session, goalId: string, passed: boolean, checks: readonly GoalVerificationCheck[]): void {
  session.append('goal/verification', {
    goal: { id: goalId, revision: 1 },
    passed,
    checks,
  } as never, { ignorable: true })
}

describe('P1.2: cost budget gate is reachable', () => {
  it('cost exceeding maxTaskCostUsd triggers stop(cost-limit)', () => {
    const session = Session.create(SessionId('budget-cost'))
    const goalId = 'goal-budget-cost'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps({
      limits: {
        maxFlashAttempts: 3,
        maxProAttempts: 2,
        maxTotalAttempts: 5,
        maxTaskCostUsd: 0.01,
      },
    })

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 100000, output: 0, cacheRead: 0, cacheMiss: 100000 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    const result = handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    expect(result.action).toBe('stop')
    expect(result.reason).toBe('cost-limit')
  })

  it('cost under maxTaskCostUsd allows flash-repair', () => {
    const session = Session.create(SessionId('budget-cost-ok'))
    const goalId = 'goal-budget-cost-ok'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps({
      limits: {
        maxFlashAttempts: 3,
        maxProAttempts: 2,
        maxTotalAttempts: 5,
        maxTaskCostUsd: 1.0,
      },
    })

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    const result = handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    expect(result.action).toBe('flash-repair')
  })
})

describe('P1.2: time budget gate is reachable', () => {
  it('elapsed time exceeding maxElapsedMs triggers stop(time-limit)', () => {
    const session = Session.create(SessionId('budget-time'))
    const goalId = 'goal-budget-time'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    // Set startedAt far in the past to simulate long elapsed time
    const state = freshState(repairId, Date.now() - 600_000) // 10 minutes ago
    const deps = defaultDeps({
      limits: {
        maxFlashAttempts: 3,
        maxProAttempts: 2,
        maxTotalAttempts: 5,
        maxElapsedMs: 300_000, // 5 minutes
      },
    })

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    const result = handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    expect(result.action).toBe('stop')
    expect(result.reason).toBe('time-limit')
  })

  it('elapsed time under maxElapsedMs allows flash-repair', () => {
    const session = Session.create(SessionId('budget-time-ok'))
    const goalId = 'goal-budget-time-ok'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId, Date.now()) // just started
    const deps = defaultDeps({
      limits: {
        maxFlashAttempts: 3,
        maxProAttempts: 2,
        maxTotalAttempts: 5,
        maxElapsedMs: 600_000, // 10 minutes
      },
    })

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    const result = handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    expect(result.action).toBe('flash-repair')
  })
})

describe('P1.2: cost gate takes priority over flash-repair', () => {
  it('cost-limit fires even when flash-repair would normally be chosen', () => {
    const session = Session.create(SessionId('budget-priority'))
    const goalId = 'goal-budget-priority'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps({
      limits: {
        maxFlashAttempts: 3,
        maxProAttempts: 2,
        maxTotalAttempts: 5,
        maxTaskCostUsd: 0.001,
      },
    })

    // Turn 1: Flash fails with enough tokens to exceed the $0.001 budget
    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 20000, output: 1000, cacheRead: 0, cacheMiss: 20000 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    const result = handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    // Cost = (20000/1M) * 0.14 + (1000/1M) * 0.28 = 0.0028 + 0.00028 = 0.00308
    // This exceeds 0.001, so cost-limit should fire
    expect(result.action).toBe('stop')
    expect(result.reason).toBe('cost-limit')
  })
})

describe('P1.2: reconstructed state preserves startedAt for budget gate', () => {
  it('reconstructed startedAt comes from the first repair/evidence event time', () => {
    const session = Session.create(SessionId('budget-replay'))
    const goalId = 'goal-budget-replay'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    session.append('repair/evidence', {
      repairId, turn: 1, step: 0, attempt: 1, routingDecisionId: 'rd-1',
      failureFingerprint: 'fp-1', failurePackageId: 'fpid-1', progress: 'none',
      failedCriteria: ['criterion-1'], failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
    }, { ignorable: true })
    session.append('repair/decision', {
      repairId, turn: 1, step: 0, attempt: 1, action: 'flash-repair', failureFingerprint: 'fp-1',
    }, { ignorable: true })

    // Get the actual time of the first repair/evidence event
    const evidenceEvent = session.events.find(e => e.type === 'repair/evidence')
    const evidenceTime = evidenceEvent!.time

    // CRASH → restart → reconstruct
    const reconstructed = reconstructRepairState(session.events, goalId, TEST_PRICING)
    expect(reconstructed).toBeDefined()

    // The reconstructed startedAt should match the first repair/evidence event's time
    expect(reconstructed!.startedAt).toBe(evidenceTime)

    // Elapsed time should be positive (started in the past relative to now)
    expect(reconstructed!.elapsedMs).toBeGreaterThanOrEqual(0)
  })
})
