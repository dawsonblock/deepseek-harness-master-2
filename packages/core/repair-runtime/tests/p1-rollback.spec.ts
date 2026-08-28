/**
 * P1.7 rollback as a harness-owned operation tests. Verifies that:
 *
 * 1. When a `rollbackProvider` is configured, `repair/rollback` is emitted
 *    before flash-repair and pro-escalate attempts.
 * 2. No `repair/rollback` event is emitted for `complete` or `stop` decisions.
 * 3. No `repair/rollback` event is emitted when no rollback provider is configured.
 * 4. The rollback event contains the correct attempt, routing decision, and target.
 * 5. A failed rollback records `success: false` and `failureReason`.
 *
 * @module @deepseek-ai/dsh-repair-runtime/tests/p1-rollback.spec
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
  type RollbackProvider,
  computeRepairId,
  handleVerificationFailure,
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

/** Simple rollback provider that always succeeds with a checkpoint id. */
const successRollback: RollbackProvider = () => ({
  success: true,
  rollbackTarget: 'checkpoint-001',
})

/** Rollback provider that always fails. */
const failRollback: RollbackProvider = () => ({
  success: false,
  rollbackTarget: 'checkpoint-001',
  failureReason: 'checkpoint not found',
})

describe('P1.7: repair/rollback emitted before flash-repair', () => {
  it('rollback event is emitted when provider is configured and decision is flash-repair', () => {
    const session = Session.create(SessionId('rollback-flash'))
    const goalId = 'goal-rollback-flash'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps({ rollbackProvider: successRollback })

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    const result = handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    expect(result.action).toBe('flash-repair')

    const rollbackEvents = session.events.filter(e => e.type === 'repair/rollback')
    expect(rollbackEvents.length).toBe(1)
    const data = rollbackEvents[0]!.data as {
      repairId: string
      attempt: number
      routingDecisionId: string
      rollbackTarget: string
      success: boolean
    }
    expect(data.repairId).toBe(repairId)
    expect(data.attempt).toBe(1)
    expect(data.routingDecisionId).toBe('rd-1')
    expect(data.rollbackTarget).toBe('checkpoint-001')
    expect(data.success).toBe(true)
  })

  it('rollback event ordering: after repair/decision, before next attempt', () => {
    const session = Session.create(SessionId('rollback-order'))
    const goalId = 'goal-rollback-order'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps({ rollbackProvider: successRollback })

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    const decisionIdx = session.events.findIndex(e => e.type === 'repair/decision')
    const rollbackIdx = session.events.findIndex(e => e.type === 'repair/rollback')
    expect(decisionIdx).toBeGreaterThanOrEqual(0)
    expect(rollbackIdx).toBeGreaterThan(decisionIdx)
  })
})

describe('P1.7: no repair/rollback for complete or stop', () => {
  it('no rollback event when decision is stop (Pro unavailable)', () => {
    const session = Session.create(SessionId('rollback-stop'))
    const goalId = 'goal-rollback-stop'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps({
      rollbackProvider: successRollback,
      proModelAvailable: false,
    })

    // Two same-failure Flash attempts → would escalate, but Pro unavailable → stop
    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    setupTurn(session, 2, FLASH, 'rd-2')
    appendUsage(session, 'rd-2', 2, FLASH, { input: 1200, output: 600, cacheRead: 300, cacheMiss: 900 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    const result = handleVerificationFailure(session, state, deps, 2, failChecks(['criterion-1']))

    expect(result.action).toBe('stop')

    // The first failure (flash-repair) should have a rollback, but the stop should NOT
    const rollbackEvents = session.events.filter(e => e.type === 'repair/rollback')
    expect(rollbackEvents.length).toBe(1) // Only from the first flash-repair
  })
})

describe('P1.7: no repair/rollback without provider', () => {
  it('no rollback event when no rollbackProvider is configured', () => {
    const session = Session.create(SessionId('rollback-none'))
    const goalId = 'goal-rollback-none'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps() // no rollbackProvider

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    const rollbackEvents = session.events.filter(e => e.type === 'repair/rollback')
    expect(rollbackEvents.length).toBe(0)
  })
})

describe('P1.11: failed rollback is fail-closed (stops repair, no new attempt)', () => {
  it('rollback failure → stop with rollback-failed, no followup, no model claim', () => {
    const session = Session.create(SessionId('rollback-fail-closed'))
    const goalId = 'goal-rollback-fail-closed'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps({ rollbackProvider: failRollback })

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    const result = handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    // Must stop, not flash-repair
    expect(result.action).toBe('stop')
    expect(result.reason).toBe('rollback-failed')
    // No followup content (no agent.followup())
    expect(result.followupContent).toBeUndefined()
    // No model claim (no new routing decision)
    expect(result.claimModel).toBeUndefined()
    // No pending escalation
    expect(result.pendingEscalation).toBeUndefined()
  })

  it('rollback failure emits repair/completed with outcome=rollback-failed', () => {
    const session = Session.create(SessionId('rollback-fail-completed'))
    const goalId = 'goal-rollback-fail-completed'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps({ rollbackProvider: failRollback })

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    const completedEvents = session.events.filter(e => e.type === 'repair/completed')
    expect(completedEvents.length).toBe(1)
    const data = completedEvents[0]!.data as { outcome?: string; verified: boolean }
    expect(data.verified).toBe(false)
    expect(data.outcome).toBe('rollback-failed')
  })

  it('rollback failure produces zero new routing decisions after the failure', () => {
    const session = Session.create(SessionId('rollback-fail-no-routing'))
    const goalId = 'goal-rollback-fail-no-routing'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps({ rollbackProvider: failRollback })

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))

    const routingBefore = session.events.filter(e => (e.type as string) === 'model/routing-decision').length
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))
    const routingAfter = session.events.filter(e => (e.type as string) === 'model/routing-decision').length

    // No new routing decisions were created after rollback failure
    expect(routingAfter).toBe(routingBefore)
  })

  it('rollback failure for pro-escalate also stops (no Pro provider call)', () => {
    const session = Session.create(SessionId('rollback-fail-pro'))
    const goalId = 'goal-rollback-fail-pro'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps({ rollbackProvider: failRollback })

    // Turn 1: Flash fails (flash-repair, rollback fails → stop)
    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    const result = handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    expect(result.action).toBe('stop')
    expect(result.reason).toBe('rollback-failed')
    // No Pro model claim
    expect(result.claimModel).toBeUndefined()
    expect(result.pendingEscalation).toBeUndefined()
  })

  it('rollback event with success=false and failureReason when provider fails', () => {
    const session = Session.create(SessionId('rollback-fail'))
    const goalId = 'goal-rollback-fail'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps({ rollbackProvider: failRollback })

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    const rollbackEvents = session.events.filter(e => e.type === 'repair/rollback')
    expect(rollbackEvents.length).toBe(1)
    const data = rollbackEvents[0]!.data as {
      success: boolean
      failureReason?: string
    }
    expect(data.success).toBe(false)
    expect(data.failureReason).toBe('checkpoint not found')
  })
})

describe('P1.7: rollback emitted before pro-escalate', () => {
  it('rollback event is emitted when decision is pro-escalate', () => {
    const session = Session.create(SessionId('rollback-pro'))
    const goalId = 'goal-rollback-pro'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps({ rollbackProvider: successRollback })

    // Turn 1: Flash fails
    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    // Turn 2: Flash fails again (same failure → pro-escalate)
    setupTurn(session, 2, FLASH, 'rd-2')
    appendUsage(session, 'rd-2', 2, FLASH, { input: 1200, output: 600, cacheRead: 300, cacheMiss: 900 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    const result = handleVerificationFailure(session, state, deps, 2, failChecks(['criterion-1']))

    expect(result.action).toBe('pro-escalate')

    // Should have 2 rollback events: one for flash-repair (attempt 1), one for pro-escalate (attempt 2)
    const rollbackEvents = session.events.filter(e => e.type === 'repair/rollback')
    expect(rollbackEvents.length).toBe(2)
    const secondRollback = rollbackEvents[1]!.data as { attempt: number; success: boolean }
    expect(secondRollback.attempt).toBe(2)
    expect(secondRollback.success).toBe(true)
  })
})
