/**
 * Crash/replay durability tests for the repair runtime. Verifies that repair
 * state reconstructs deterministically from the session log after a simulated
 * process kill and restart.
 *
 * @module @deepseek-ai/dsh-repair-runtime/tests/replay.spec
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { reconstructRepairState } from '../src/index.ts'

/** Append a repair/evidence event to the session log. */
function appendEvidence(
  session: Session,
  repairId: string,
  turn: number,
  attempt: number,
  fingerprint: string,
  progress: 'none' | 'partial' | 'regression',
): void {
  session.append('repair/evidence', {
    repairId,
    turn,
    step: 0,
    attempt,
    routingDecisionId: `rd-${attempt}`,
    failureFingerprint: fingerprint,
    progress,
    failedCriteria: ['criterion-1'],
    failingTests: [],
    typeErrors: [],
    buildErrors: [],
    changedFiles: [],
  }, { ignorable: true })
}

/** Append a repair/decision event to the session log. */
function appendDecision(
  session: Session,
  repairId: string,
  turn: number,
  attempt: number,
  action: 'flash-repair' | 'pro-escalate' | 'complete' | 'stop',
  reason?: 'same-failure-no-progress' | 'flash-limit-exhausted' | 'regression-detected' | 'attempt-limit' | 'cost-limit' | 'time-limit' | 'verification-impossible' | 'pro-exhausted',
): void {
  session.append('repair/decision', {
    repairId,
    turn,
    step: 0,
    attempt,
    action,
    ...(reason !== undefined ? { reason } : {}),
    failureFingerprint: 'fp-1234',
  }, { ignorable: true })
}

/** Append a model/escalation event to the session log. */
function appendEscalation(
  session: Session,
  repairId: string,
  turn: number,
  fromRoutingDecisionId: string,
  toRoutingDecisionId: string,
  flashAttempts: number,
): void {
  session.append('model/escalation', {
    repairId,
    turn,
    step: 0,
    fromRoutingDecisionId,
    toRoutingDecisionId,
    repairOf: fromRoutingDecisionId,
    fromModel: 'deepseek-v4-flash',
    toModel: 'deepseek-v4-pro',
    reason: 'same-failure-no-progress',
    failureFingerprint: 'fp-1234',
    flashAttempts,
  }, { ignorable: true })
}

/** Append a repair/completed event to the session log. */
function appendCompleted(
  session: Session,
  repairId: string,
  turn: number,
  verified: boolean,
  flashAttempts: number,
  proAttempts: number,
): void {
  session.append('repair/completed', {
    repairId,
    turn,
    step: 0,
    finalRoutingDecisionId: 'rd-final',
    verified,
    totalAttempts: flashAttempts + proAttempts,
    flashAttempts,
    proAttempts,
    totalCostUsd: 0.05,
    elapsedMs: 5000,
  }, { ignorable: true })
}

describe('reconstructRepairState — crash/replay durability', () => {
  it('Test 7: process killed after repair/decision → restart → state reconstructs', () => {
    const session = Session.create(SessionId('crash-test-7'))
    const goalId = 'goal-test-7'
    const repairId = `repair-${goalId}-1700000000000`

    // Simulate: Flash failed, repair/decision was flash-repair, then crash
    appendEvidence(session, repairId, 1, 1, 'fp-aaaa', 'none')
    appendDecision(session, repairId, 1, 1, 'flash-repair')
    // No repair/completed — crash happened before completion

    // Restart: reconstruct state from the log
    const state = reconstructRepairState(session.events, goalId)

    expect(state).toBeDefined()
    expect(state!.repairId).toBe(repairId)
    expect(state!.attempts).toHaveLength(1)
    expect(state!.attempts[0]!.attempt).toBe(1)
    expect(state!.attempts[0]!.failureFingerprint).toBe('fp-aaaa')
    expect(state!.attempts[0]!.verified).toBe(false)
    expect(state!.flashAttempts).toBe(1)
    expect(state!.proAttempts).toBe(0)
  })

  it('Test 8: process killed after model/escalation → restart → no duplicate Pro escalation', () => {
    const session = Session.create(SessionId('crash-test-8'))
    const goalId = 'goal-test-8'
    const repairId = `repair-${goalId}-1700000000001`

    // Simulate: Flash failed twice, escalated to Pro, then crash
    appendEvidence(session, repairId, 1, 1, 'fp-aaaa', 'none')
    appendDecision(session, repairId, 1, 1, 'flash-repair')
    appendEvidence(session, repairId, 1, 2, 'fp-aaaa', 'none')
    appendDecision(session, repairId, 1, 2, 'pro-escalate', 'same-failure-no-progress')
    appendEscalation(session, repairId, 1, 'rd-2', 'pro-1', 2)
    // No repair/completed — crash happened after escalation

    // Restart: reconstruct state from the log
    const state = reconstructRepairState(session.events, goalId)

    expect(state).toBeDefined()
    expect(state!.repairId).toBe(repairId)
    expect(state!.attempts).toHaveLength(2)
    expect(state!.flashAttempts).toBe(1)
    expect(state!.proAttempts).toBe(1)
    // The last attempt should be marked as Pro (escalated)
    expect(state!.attempts[1]!.model.model).toBe('deepseek-v4-pro')
    // Pro escalation already happened — the caller should not re-escalate
    // The state shows proAttempts=1, so the controller will not duplicate it
  })

  it('returns undefined when repair/completed exists (repair is finished)', () => {
    const session = Session.create(SessionId('crash-test-completed'))
    const goalId = 'goal-completed'
    const repairId = `repair-${goalId}-1700000000002`

    appendEvidence(session, repairId, 1, 1, 'fp-aaaa', 'none')
    appendDecision(session, repairId, 1, 1, 'flash-repair')
    appendEvidence(session, repairId, 1, 2, 'fp-bbbb', 'partial')
    appendDecision(session, repairId, 1, 2, 'complete')
    appendCompleted(session, repairId, 1, true, 2, 0)

    const state = reconstructRepairState(session.events, goalId)
    expect(state).toBeUndefined()
  })

  it('returns undefined when no repair events exist', () => {
    const session = Session.create(SessionId('crash-test-empty'))
    const state = reconstructRepairState(session.events, 'goal-nonexistent')
    expect(state).toBeUndefined()
  })

  it('reconstructs partial-progress Flash repair state correctly', () => {
    const session = Session.create(SessionId('crash-test-partial'))
    const goalId = 'goal-partial'
    const repairId = `repair-${goalId}-1700000000003`

    // Flash #1 failed, Flash #2 with partial progress, then crash
    appendEvidence(session, repairId, 1, 1, 'fp-aaaa', 'none')
    appendDecision(session, repairId, 1, 1, 'flash-repair')
    appendEvidence(session, repairId, 1, 2, 'fp-bbbb', 'partial')
    appendDecision(session, repairId, 1, 2, 'flash-repair')

    const state = reconstructRepairState(session.events, goalId)

    expect(state).toBeDefined()
    expect(state!.attempts).toHaveLength(2)
    expect(state!.attempts[0]!.failureFingerprint).toBe('fp-aaaa')
    expect(state!.attempts[1]!.failureFingerprint).toBe('fp-bbbb')
    expect(state!.attempts[1]!.progress).toBe('partial')
    expect(state!.flashAttempts).toBe(2)
    expect(state!.proAttempts).toBe(0)
  })

  it('reconstructs full trajectory: Flash ×2 → Pro → crash', () => {
    const session = Session.create(SessionId('crash-test-full'))
    const goalId = 'goal-full'
    const repairId = `repair-${goalId}-1700000000004`

    // Full trajectory up to Pro #1 failure, then crash
    appendEvidence(session, repairId, 1, 1, 'fp-aaaa', 'none')
    appendDecision(session, repairId, 1, 1, 'flash-repair')
    appendEvidence(session, repairId, 1, 2, 'fp-aaaa', 'none')
    appendDecision(session, repairId, 1, 2, 'pro-escalate', 'same-failure-no-progress')
    appendEscalation(session, repairId, 1, 'rd-2', 'pro-1', 2)
    appendEvidence(session, repairId, 1, 3, 'fp-aaaa', 'none')
    appendDecision(session, repairId, 1, 3, 'pro-escalate', 'flash-limit-exhausted')

    const state = reconstructRepairState(session.events, goalId)

    expect(state).toBeDefined()
    expect(state!.attempts).toHaveLength(3)
    expect(state!.flashAttempts).toBe(1)
    expect(state!.proAttempts).toBe(2)
    // Attempt 3 should be Pro
    expect(state!.attempts[2]!.model.model).toBe('deepseek-v4-pro')
  })

  it('reconstruction is deterministic — same log produces same state', () => {
    const session = Session.create(SessionId('crash-test-det'))
    const goalId = 'goal-det'
    const repairId = `repair-${goalId}-1700000000005`

    appendEvidence(session, repairId, 1, 1, 'fp-aaaa', 'none')
    appendDecision(session, repairId, 1, 1, 'flash-repair')
    appendEvidence(session, repairId, 1, 2, 'fp-bbbb', 'partial')
    appendDecision(session, repairId, 1, 2, 'flash-repair')

    const state1 = reconstructRepairState(session.events, goalId)
    const state2 = reconstructRepairState(session.events, goalId)

    expect(state1).toEqual(state2)
  })

  it('does not reconstruct state for a different goal', () => {
    const session = Session.create(SessionId('crash-test-other'))
    const goalId = 'goal-a'
    const otherGoalId = 'goal-b'
    const repairId = `repair-${goalId}-1700000000006`

    appendEvidence(session, repairId, 1, 1, 'fp-aaaa', 'none')
    appendDecision(session, repairId, 1, 1, 'flash-repair')

    const state = reconstructRepairState(session.events, otherGoalId)
    expect(state).toBeUndefined()
  })
})
