/**
 * P1.8 stronger event ordering/idempotency invariants tests. Verifies that
 * `validateRepairEventInvariants` detects:
 *
 * 1. Valid event ordering passes with no violations.
 * 2. Duplicate `repair/evidence` for the same attempt is detected.
 * 3. Duplicate `failurePackageId` is detected.
 * 4. `repair/decision` without preceding `repair/evidence` is detected.
 * 5. Multiple `repair/completed` events are detected.
 * 6. `repair/completed` before `repair/decision` is detected.
 * 7. `repair/rollback` without preceding `repair/evidence` is detected.
 *
 * @module @deepseek-ai/dsh-repair-runtime/tests/p1-invariants.spec
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
  handleVerificationPass,
  validateRepairEventInvariants,
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

function passChecks(): readonly GoalVerificationCheck[] {
  return [{ name: 'acceptance', role: 'acceptance', passed: true, reason: '', evidence: [] }]
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

/** Simulate the plugin's repair/completed append after handleVerificationPass. */
async function passAndComplete(
  session: Session,
  state: RepairState,
  turn: number,
  routingDecisionId: string,
  repairId: string,
): Promise<void> {
  const result = await handleVerificationPass(session, state, turn, routingDecisionId, TEST_PRICING)
  session.append('repair/completed', {
    repairId,
    turn,
    step: 0,
    finalRoutingDecisionId: routingDecisionId,
    verified: result.verified,
    totalAttempts: state.attempts.length,
    flashAttempts: state.flashAttempts,
    proAttempts: state.proAttempts,
    totalCostUsd: state.totalCostUsd,
    elapsedMs: Date.now() - state.startedAt,
    outcome: result.outcome,
    ...result.qualificationFailure !== undefined ? { qualificationFailure: result.qualificationFailure } : {},
  }, { ignorable: true })
}

describe('P1.8: valid event ordering passes', () => {
  it('flash-repair sequence with no violations', async () => {
    const session = Session.create(SessionId('inv-valid'))
    const goalId = 'goal-inv-valid'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps()

    // Turn 1: Flash fails → flash-repair
    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    // Turn 2: Flash repair passes → completed
    setupTurn(session, 2, FLASH, 'rd-2')
    appendUsage(session, 'rd-2', 2, FLASH, { input: 800, output: 300, cacheRead: 400, cacheMiss: 400 })
    appendVerification(session, goalId, true, passChecks())
    await passAndComplete(session, state, 2, 'rd-2', repairId)

    const result = validateRepairEventInvariants(session.events, repairId)
    expect(result.valid).toBe(true)
    expect(result.violations).toEqual([])
  })

  it('escalation sequence with no violations', async () => {
    const session = Session.create(SessionId('inv-escalation'))
    const goalId = 'goal-inv-escalation'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps()

    // Turn 1: Flash fails
    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    // Turn 2: Flash fails again (same failure → pro-escalate)
    setupTurn(session, 2, FLASH, 'rd-2')
    appendUsage(session, 'rd-2', 2, FLASH, { input: 1200, output: 600, cacheRead: 300, cacheMiss: 900 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 2, failChecks(['criterion-1']))

    // Turn 3: Pro passes
    setupTurn(session, 3, PRO, 'rd-3')
    appendUsage(session, 'rd-3', 3, PRO, { input: 2000, output: 1000, cacheRead: 500, cacheMiss: 1500 })
    appendVerification(session, goalId, true, passChecks())
    await passAndComplete(session, state, 3, 'rd-3', repairId)

    const result = validateRepairEventInvariants(session.events, repairId)
    expect(result.valid).toBe(true)
    expect(result.violations).toEqual([])
  })
})

describe('P1.8: duplicate evidence detection', () => {
  it('duplicate repair/evidence for the same attempt is detected', () => {
    const session = Session.create(SessionId('inv-dup-evidence'))
    const repairId = 'repair:v1:abc123'

    // Manually append two evidence events for the same attempt
    session.append('repair/evidence', {
      repairId,
      turn: 1, step: 0, attempt: 1,
      routingDecisionId: 'rd-1',
      failureFingerprint: 'fp-1',
      failurePackageId: 'pkg-1',
      progress: 'none',
      failedCriteria: ['c1'], failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
    }, { ignorable: true })
    session.append('repair/evidence', {
      repairId,
      turn: 1, step: 0, attempt: 1,
      routingDecisionId: 'rd-1',
      failureFingerprint: 'fp-1',
      failurePackageId: 'pkg-1',
      progress: 'none',
      failedCriteria: ['c1'], failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
    }, { ignorable: true })

    const result = validateRepairEventInvariants(session.events, repairId)
    expect(result.valid).toBe(false)
    expect(result.violations.some(v => v.includes('duplicate repair/evidence for attempt 1'))).toBe(true)
  })

  it('duplicate failurePackageId is detected', () => {
    const session = Session.create(SessionId('inv-dup-pkg'))
    const repairId = 'repair:v1:def456'

    // Two evidence events for different attempts but same failurePackageId
    session.append('repair/evidence', {
      repairId,
      turn: 1, step: 0, attempt: 1,
      routingDecisionId: 'rd-1',
      failureFingerprint: 'fp-1',
      failurePackageId: 'pkg-dup',
      progress: 'none',
      failedCriteria: ['c1'], failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
    }, { ignorable: true })
    session.append('repair/evidence', {
      repairId,
      turn: 2, step: 0, attempt: 2,
      routingDecisionId: 'rd-2',
      failureFingerprint: 'fp-1',
      failurePackageId: 'pkg-dup',
      progress: 'none',
      failedCriteria: ['c1'], failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
    }, { ignorable: true })

    const result = validateRepairEventInvariants(session.events, repairId)
    expect(result.valid).toBe(false)
    expect(result.violations.some(v => v.includes('duplicate failurePackageId'))).toBe(true)
  })
})

describe('P1.8: decision without evidence', () => {
  it('repair/decision without preceding repair/evidence is detected', () => {
    const session = Session.create(SessionId('inv-decision-no-evidence'))
    const repairId = 'repair:v1:ghi789'

    // Decision without any preceding evidence
    session.append('repair/decision', {
      repairId,
      turn: 1, step: 0, attempt: 1,
      action: 'flash-repair',
      failureFingerprint: 'fp-1',
    }, { ignorable: true })

    const result = validateRepairEventInvariants(session.events, repairId)
    expect(result.valid).toBe(false)
    expect(result.violations.some(v => v.includes('without preceding repair/evidence'))).toBe(true)
  })
})

describe('P1.8: multiple completed events', () => {
  it('multiple repair/completed events are detected', async () => {
    const session = Session.create(SessionId('inv-multi-completed'))
    const goalId = 'goal-inv-multi-completed'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps()

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    setupTurn(session, 2, FLASH, 'rd-2')
    appendUsage(session, 'rd-2', 2, FLASH, { input: 800, output: 300, cacheRead: 400, cacheMiss: 400 })
    appendVerification(session, goalId, true, passChecks())
    await passAndComplete(session, state, 2, 'rd-2', repairId)

    // Manually append a second completed event
    session.append('repair/completed', {
      repairId,
      turn: 3, step: 0,
      finalRoutingDecisionId: 'rd-2',
      verified: true,
      totalAttempts: 2,
      flashAttempts: 2,
      proAttempts: 0,
      totalCostUsd: 0,
      elapsedMs: 0,
      outcome: 'verified',
    }, { ignorable: true })

    const result = validateRepairEventInvariants(session.events, repairId)
    expect(result.valid).toBe(false)
    expect(result.violations.some(v => v.includes('multiple repair/completed'))).toBe(true)
  })
})

describe('P1.8: completed before decision', () => {
  it('repair/completed before repair/decision is detected', () => {
    const session = Session.create(SessionId('inv-completed-before'))
    const repairId = 'repair:v1:jkl012'

    // Completed event first
    session.append('repair/completed', {
      repairId,
      turn: 1, step: 0,
      finalRoutingDecisionId: 'rd-1',
      verified: true,
      totalAttempts: 1,
      flashAttempts: 1,
      proAttempts: 0,
      totalCostUsd: 0,
      elapsedMs: 0,
      outcome: 'attempts-exhausted',
    }, { ignorable: true })

    // Then evidence and decision (out of order)
    session.append('repair/evidence', {
      repairId,
      turn: 1, step: 0, attempt: 1,
      routingDecisionId: 'rd-1',
      failureFingerprint: 'fp-1',
      failurePackageId: 'pkg-1',
      progress: 'none',
      failedCriteria: ['c1'], failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
    }, { ignorable: true })
    session.append('repair/decision', {
      repairId,
      turn: 1, step: 0, attempt: 1,
      action: 'flash-repair',
      failureFingerprint: 'fp-1',
    }, { ignorable: true })

    const result = validateRepairEventInvariants(session.events, repairId)
    expect(result.valid).toBe(false)
    expect(result.violations.some(v => v.includes('before a repair/decision'))).toBe(true)
  })
})

describe('P1.8: rollback without evidence', () => {
  it('repair/rollback without preceding repair/evidence is detected', () => {
    const session = Session.create(SessionId('inv-rollback-no-evidence'))
    const repairId = 'repair:v1:mno345'

    // Rollback without any preceding evidence
    session.append('repair/rollback', {
      repairId,
      turn: 1, step: 0, attempt: 1,
      routingDecisionId: 'rd-1',
      rollbackTarget: 'checkpoint-001',
      success: true,
    }, { ignorable: true })

    const result = validateRepairEventInvariants(session.events, repairId)
    expect(result.valid).toBe(false)
    expect(result.violations.some(v => v.includes('repair/rollback for attempt 1 without preceding repair/evidence'))).toBe(true)
  })
})

describe('P1.8: empty or unrelated events', () => {
  it('no repair events → valid with no violations', () => {
    const session = Session.create(SessionId('inv-empty'))
    const result = validateRepairEventInvariants(session.events, 'repair:v1:empty')
    expect(result.valid).toBe(true)
    expect(result.violations).toEqual([])
  })

  it('repair events for a different repairId are ignored', () => {
    const session = Session.create(SessionId('inv-unrelated'))
    const repairId = 'repair:v1:target'
    const otherRepairId = 'repair:v1:other'

    session.append('repair/evidence', {
      repairId: otherRepairId,
      turn: 1, step: 0, attempt: 1,
      routingDecisionId: 'rd-1',
      failureFingerprint: 'fp-1',
      failurePackageId: 'pkg-other',
      progress: 'none',
      failedCriteria: ['c1'], failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
    }, { ignorable: true })

    const result = validateRepairEventInvariants(session.events, repairId)
    expect(result.valid).toBe(true)
    expect(result.violations).toEqual([])
  })
})
