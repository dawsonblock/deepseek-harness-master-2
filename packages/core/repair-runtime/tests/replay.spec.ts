/**
 * Crash/replay durability tests for the repair runtime. Verifies that repair
 * state reconstructs deterministically from the session log after a simulated
 * process kill and restart.
 *
 * Attempts are reconstructed from real execution events
 * (`model/routing-decision` → `goal/verification` FAIL), with
 * `repair/evidence` overlaying the full `FailurePackage`. A later
 * `pro-escalate` decision must not retroactively change an earlier Flash
 * attempt's model.
 *
 * @module @deepseek-ai/dsh-repair-runtime/tests/replay.spec
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { reconstructRepairState } from '../src/index.ts'

const FLASH = { provider: 'deepseek', model: 'deepseek-v4-flash' }
const PRO = { provider: 'deepseek', model: 'deepseek-v4-pro' }

/** Append a model/routing-decision event. */
function appendRoutingDecision(
  session: Session,
  turn: number,
  routingDecisionId: string,
  selected: { provider: string; model: string },
): void {
  session.append('model/routing-decision', {
    turn,
    step: 1,
    routingDecisionId,
    proposed: selected,
    selected,
    authority: 'router',
    activeAuthority: 'router',
    reason: 'routed-fast',
    authorityEpoch: 1,
  } as never, { ignorable: true })
}

/** Append a goal/verification FAIL event. */
function appendVerificationFail(
  session: Session,
  goalId: string,
): void {
  session.append('goal/verification', {
    goal: { id: goalId, revision: 1 },
    passed: false,
    checks: [],
  } as never)
}

/** Append a repair/evidence event to the session log. */
function appendEvidence(
  session: Session,
  repairId: string,
  turn: number,
  attempt: number,
  routingDecisionId: string,
  fingerprint: string,
  progress: 'none' | 'partial' | 'regression',
  failedCriteria: string[] = ['criterion-1'],
): void {
  session.append('repair/evidence', {
    repairId,
    turn,
    step: 0,
    attempt,
    routingDecisionId,
    failureFingerprint: fingerprint,
    failurePackageId: `fpid-${attempt}`,
    progress,
    failedCriteria,
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

/** Build a full Flash attempt: routing-decision → verification-fail → evidence. */
function appendFlashAttempt(
  session: Session,
  goalId: string,
  repairId: string,
  turn: number,
  attempt: number,
  routingDecisionId: string,
  fingerprint: string,
  progress: 'none' | 'partial' | 'regression',
  failedCriteria: string[] = ['criterion-1'],
): void {
  appendRoutingDecision(session, turn, routingDecisionId, FLASH)
  appendVerificationFail(session, goalId)
  appendEvidence(session, repairId, turn, attempt, routingDecisionId, fingerprint, progress, failedCriteria)
}

/** Build a full Pro attempt: routing-decision → verification-fail → evidence. */
function appendProAttempt(
  session: Session,
  goalId: string,
  repairId: string,
  turn: number,
  attempt: number,
  routingDecisionId: string,
  fingerprint: string,
  progress: 'none' | 'partial' | 'regression',
  failedCriteria: string[] = ['criterion-1'],
): void {
  appendRoutingDecision(session, turn, routingDecisionId, PRO)
  appendVerificationFail(session, goalId)
  appendEvidence(session, repairId, turn, attempt, routingDecisionId, fingerprint, progress, failedCriteria)
}

describe('reconstructRepairState — crash/replay durability', () => {
  it('process killed after repair/decision → restart → state reconstructs', () => {
    const session = Session.create(SessionId('crash-test-7'))
    const goalId = 'goal-test-7'
    const repairId = `repair-${goalId}-1700000000000`

    appendFlashAttempt(session, goalId, repairId, 1, 1, 'rd-1', 'fp-aaaa', 'none')
    appendDecision(session, repairId, 1, 1, 'flash-repair')

    const state = reconstructRepairState(session.events, goalId)

    expect(state).toBeDefined()
    expect(state!.repairId).toBe(repairId)
    expect(state!.attempts).toHaveLength(1)
    expect(state!.attempts[0]!.attempt).toBe(1)
    expect(state!.attempts[0]!.failureFingerprint).toBe('fp-aaaa')
    expect(state!.attempts[0]!.verified).toBe(false)
    expect(state!.attempts[0]!.model.model).toBe('deepseek-v4-flash')
    expect(state!.attempts[0]!.failurePackage).toBeDefined()
    expect(state!.attempts[0]!.failurePackage!.failedCriteria).toEqual(['criterion-1'])
    expect(state!.flashAttempts).toBe(1)
    expect(state!.proAttempts).toBe(0)
  })

  it('process killed after model/escalation → restart → no duplicate Pro escalation', () => {
    const session = Session.create(SessionId('crash-test-8'))
    const goalId = 'goal-test-8'
    const repairId = `repair-${goalId}-1700000000001`

    // Flash #1 fail → flash-repair decision
    appendFlashAttempt(session, goalId, repairId, 1, 1, 'rd-1', 'fp-aaaa', 'none')
    appendDecision(session, repairId, 1, 1, 'flash-repair')
    // Flash #2 fail → pro-escalate decision
    appendFlashAttempt(session, goalId, repairId, 1, 2, 'rd-2', 'fp-aaaa', 'none')
    appendDecision(session, repairId, 1, 2, 'pro-escalate', 'same-failure-no-progress')
    appendEscalation(session, repairId, 1, 'rd-2', 'rd-pro-1', 2)

    const state = reconstructRepairState(session.events, goalId)

    expect(state).toBeDefined()
    expect(state!.repairId).toBe(repairId)
    expect(state!.attempts).toHaveLength(2)
    expect(state!.flashAttempts).toBe(1)
    expect(state!.proAttempts).toBe(1)
    // Both reconstructed attempts remain Flash — the pro-escalate decision
    // does not retroactively change the model of a prior attempt.
    expect(state!.attempts[0]!.model.model).toBe('deepseek-v4-flash')
    expect(state!.attempts[1]!.model.model).toBe('deepseek-v4-flash')
  })

  it('returns undefined when repair/completed exists (repair is finished)', () => {
    const session = Session.create(SessionId('crash-test-completed'))
    const goalId = 'goal-completed'
    const repairId = `repair-${goalId}-1700000000002`

    appendFlashAttempt(session, goalId, repairId, 1, 1, 'rd-1', 'fp-aaaa', 'none')
    appendDecision(session, repairId, 1, 1, 'flash-repair')
    appendFlashAttempt(session, goalId, repairId, 1, 2, 'rd-2', 'fp-bbbb', 'partial')
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

    appendFlashAttempt(session, goalId, repairId, 1, 1, 'rd-1', 'fp-aaaa', 'none', ['A', 'B', 'C', 'D'])
    appendDecision(session, repairId, 1, 1, 'flash-repair')
    appendFlashAttempt(session, goalId, repairId, 1, 2, 'rd-2', 'fp-bbbb', 'partial', ['A', 'B'])
    appendDecision(session, repairId, 1, 2, 'flash-repair')

    const state = reconstructRepairState(session.events, goalId)

    expect(state).toBeDefined()
    expect(state!.attempts).toHaveLength(2)
    expect(state!.attempts[0]!.failureFingerprint).toBe('fp-aaaa')
    expect(state!.attempts[1]!.failureFingerprint).toBe('fp-bbbb')
    expect(state!.attempts[1]!.progress).toBe('partial')
    expect(state!.attempts[0]!.failurePackage).toBeDefined()
    expect(state!.attempts[1]!.failurePackage).toBeDefined()
    expect(state!.attempts[0]!.failurePackage!.failedCriteria).toEqual(['A', 'B', 'C', 'D'])
    expect(state!.attempts[1]!.failurePackage!.failedCriteria).toEqual(['A', 'B'])
    expect(state!.flashAttempts).toBe(2)
    expect(state!.proAttempts).toBe(0)
  })

  it('reconstructs full trajectory: Flash ×2 → Pro → crash', () => {
    const session = Session.create(SessionId('crash-test-full'))
    const goalId = 'goal-full'
    const repairId = `repair-${goalId}-1700000000004`

    // Flash #1 fail → flash-repair
    appendFlashAttempt(session, goalId, repairId, 1, 1, 'rd-1', 'fp-aaaa', 'none')
    appendDecision(session, repairId, 1, 1, 'flash-repair')
    // Flash #2 fail → pro-escalate
    appendFlashAttempt(session, goalId, repairId, 1, 2, 'rd-2', 'fp-aaaa', 'none')
    appendDecision(session, repairId, 1, 2, 'pro-escalate', 'same-failure-no-progress')
    appendEscalation(session, repairId, 1, 'rd-2', 'rd-pro-1', 2)
    // Pro #1 fail → pro-escalate (Pro #2)
    appendProAttempt(session, goalId, repairId, 1, 3, 'rd-pro-1', 'fp-aaaa', 'none')
    appendDecision(session, repairId, 1, 3, 'pro-escalate', 'flash-limit-exhausted')

    const state = reconstructRepairState(session.events, goalId)

    expect(state).toBeDefined()
    expect(state!.attempts).toHaveLength(3)
    expect(state!.flashAttempts).toBe(1)
    expect(state!.proAttempts).toBe(2)
    // Attempts 1 and 2 remain Flash; attempt 3 is Pro (from its own routing decision)
    expect(state!.attempts[0]!.model.model).toBe('deepseek-v4-flash')
    expect(state!.attempts[1]!.model.model).toBe('deepseek-v4-flash')
    expect(state!.attempts[2]!.model.model).toBe('deepseek-v4-pro')
  })

  it('reconstruction is deterministic — same log produces same state', () => {
    const session = Session.create(SessionId('crash-test-det'))
    const goalId = 'goal-det'
    const repairId = `repair-${goalId}-1700000000005`

    appendFlashAttempt(session, goalId, repairId, 1, 1, 'rd-1', 'fp-aaaa', 'none')
    appendDecision(session, repairId, 1, 1, 'flash-repair')
    appendFlashAttempt(session, goalId, repairId, 1, 2, 'rd-2', 'fp-bbbb', 'partial')
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

    appendFlashAttempt(session, goalId, repairId, 1, 1, 'rd-1', 'fp-aaaa', 'none')
    appendDecision(session, repairId, 1, 1, 'flash-repair')

    const state = reconstructRepairState(session.events, otherGoalId)
    expect(state).toBeUndefined()
  })

  it('reconstructed FailurePackage enables progress-aware decision after restart', () => {
    // Flash #1: failures A B C D
    // Flash #2: failures A B (partial progress)
    // CRASH → restart
    // The reconstructed state must carry full FailurePackage objects so
    // classifyProgress(priorFailure, currentFailure) returns 'partial', not 'none'.
    // This means the controller should decide flash-repair (continue Flash),
    // not pro-escalate.
    const session = Session.create(SessionId('crash-test-progress'))
    const goalId = 'goal-progress'
    const repairId = `repair-${goalId}-1700000000007`

    appendFlashAttempt(session, goalId, repairId, 1, 1, 'rd-1', 'fp-aaaa', 'none', ['A', 'B', 'C', 'D'])
    appendDecision(session, repairId, 1, 1, 'flash-repair')
    appendFlashAttempt(session, goalId, repairId, 1, 2, 'rd-2', 'fp-bbbb', 'partial', ['A', 'B'])
    appendDecision(session, repairId, 1, 2, 'flash-repair')

    const state = reconstructRepairState(session.events, goalId)

    expect(state).toBeDefined()
    expect(state!.attempts).toHaveLength(2)
    // The critical assertion: the reconstructed prior attempt carries a
    // full FailurePackage, not just a fingerprint. Without it,
    // classifyProgress would return 'none' and the controller would
    // escalate to Pro instead of continuing Flash repair.
    const priorAttempt = state!.attempts[1]
    expect(priorAttempt!.failurePackage).toBeDefined()
    expect(priorAttempt!.failurePackage!.failedCriteria).toEqual(['A', 'B'])
  })

  it('historical Flash attempts remain Flash after Pro escalation decision', () => {
    // A pro-escalate decision must never retroactively convert a Flash
    // attempt into Pro. The attempt's model comes from its own
    // model/routing-decision event, not from a later repair decision.
    const session = Session.create(SessionId('crash-test-no-mutation'))
    const goalId = 'goal-no-mutation'
    const repairId = `repair-${goalId}-1700000000008`

    appendFlashAttempt(session, goalId, repairId, 1, 1, 'rd-1', 'fp-aaaa', 'none')
    appendDecision(session, repairId, 1, 1, 'flash-repair')
    appendFlashAttempt(session, goalId, repairId, 1, 2, 'rd-2', 'fp-aaaa', 'none')
    appendDecision(session, repairId, 1, 2, 'pro-escalate', 'same-failure-no-progress')
    appendEscalation(session, repairId, 1, 'rd-2', 'rd-pro-1', 2)

    const state = reconstructRepairState(session.events, goalId)

    expect(state).toBeDefined()
    expect(state!.attempts).toHaveLength(2)
    expect(state!.attempts[0]!.model.model).toBe('deepseek-v4-flash')
    expect(state!.attempts[1]!.model.model).toBe('deepseek-v4-flash')
  })
})
