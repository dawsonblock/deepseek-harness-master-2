/**
 * Event ordering and idempotency tests for the repair controller.
 * Also includes crash boundary tests that verify state reconstruction
 * at each dangerous point in the repair sequence.
 *
 * @module @deepseek-ai/dsh-repair-controller/tests/event-ordering.spec
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  evidenceFollowsVerification,
  decisionFollowsEvidence,
  escalationFollowsDecision,
  newRoutingFollowsEscalation,
  findDuplicateEvidence,
  findDuplicateDecisions,
  findDuplicateEscalations,
  verifyEventOrdering,
} from '../src/event-ordering.ts'

/** Append a goal/verification event. The turn field is test-only metadata
 *  used by event-ordering helpers that join on (e.data as { turn }).turn. */
function appendVerification(session: Session, turn: number, passed: boolean): void {
  session.append('goal/verification', {
    kind: 'goal/verification',
    version: 2,
    goal: { id: 'goal-1' as never, revision: 1 },
    passed,
    verifiedAt: Date.now(),
    basisSeq: 0,
    registryFingerprint: 'vf-1',
    checks: [],
    turn,
  } as never, { ignorable: true })
}

/** Append a repair/evidence event. */
function appendEvidence(session: Session, repairId: string, turn: number, attempt: number): void {
  session.append('repair/evidence', {
    repairId, turn, step: 0, attempt,
    routingDecisionId: `rd-${attempt}`,
    failureFingerprint: 'fp-1234',
    progress: 'none',
    failedCriteria: ['criterion-1'],
    failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
  }, { ignorable: true })
}

/** Append a repair/decision event. */
function appendDecision(
  session: Session,
  repairId: string,
  turn: number,
  attempt: number,
  action: 'flash-repair' | 'pro-escalate' | 'complete' | 'stop',
): void {
  session.append('repair/decision', {
    repairId, turn, step: 0, attempt, action,
    failureFingerprint: 'fp-1234',
  }, { ignorable: true })
}

/** Append a model/escalation event. */
function appendEscalation(session: Session, repairId: string, turn: number): void {
  session.append('model/escalation', {
    repairId, turn, step: 0,
    fromRoutingDecisionId: 'rd-2',
    toRoutingDecisionId: 'pro-1',
    repairOf: 'rd-2',
    fromModel: 'deepseek-v4-flash',
    toModel: 'deepseek-v4-pro',
    reason: 'same-failure-no-progress',
    failureFingerprint: 'fp-1234',
    flashAttempts: 2,
  }, { ignorable: true })
}

/** Append a model/routing-decision event. */
function appendRoutingDecision(session: Session, turn: number, id: string): void {
  session.append('model/routing-decision', {
    routingDecisionId: id,
    turn,
    selected: { provider: 'deepseek', model: 'deepseek-v4-flash' },
  } as never, { ignorable: true })
}

describe('event ordering invariants', () => {
  it('repair/evidence follows goal/verification', () => {
    const session = Session.create(SessionId('order-test-1'))
    appendRoutingDecision(session, 1, 'rd-1')
    appendVerification(session, 1, false)
    appendEvidence(session, 'repair-1', 1, 1)
    expect(evidenceFollowsVerification(session.events, 1)).toBe(true)
  })

  it('repair/evidence before goal/verification violates invariant', () => {
    const session = Session.create(SessionId('order-test-2'))
    appendEvidence(session, 'repair-1', 1, 1)
    appendVerification(session, 1, false)
    expect(evidenceFollowsVerification(session.events, 1)).toBe(false)
  })

  it('repair/decision follows repair/evidence', () => {
    const session = Session.create(SessionId('order-test-3'))
    appendVerification(session, 1, false)
    appendEvidence(session, 'repair-1', 1, 1)
    appendDecision(session, 'repair-1', 1, 1, 'flash-repair')
    expect(decisionFollowsEvidence(session.events, 1)).toBe(true)
  })

  it('repair/decision before repair/evidence violates invariant', () => {
    const session = Session.create(SessionId('order-test-4'))
    appendVerification(session, 1, false)
    appendDecision(session, 'repair-1', 1, 1, 'flash-repair')
    appendEvidence(session, 'repair-1', 1, 1)
    expect(decisionFollowsEvidence(session.events, 1)).toBe(false)
  })

  it('model/escalation follows repair/decision(pro-escalate)', () => {
    const session = Session.create(SessionId('order-test-5'))
    appendVerification(session, 1, false)
    appendEvidence(session, 'repair-1', 1, 1)
    appendDecision(session, 'repair-1', 1, 1, 'pro-escalate')
    appendEscalation(session, 'repair-1', 1)
    expect(escalationFollowsDecision(session.events)).toBe(true)
  })

  it('new routing-decision follows model/escalation', () => {
    const session = Session.create(SessionId('order-test-6'))
    appendRoutingDecision(session, 1, 'rd-1')
    appendVerification(session, 1, false)
    appendEvidence(session, 'repair-1', 1, 1)
    appendDecision(session, 'repair-1', 1, 1, 'pro-escalate')
    appendEscalation(session, 'repair-1', 1)
    appendRoutingDecision(session, 2, 'rd-pro-1')
    expect(newRoutingFollowsEscalation(session.events)).toBe(true)
  })
})

describe('event idempotency', () => {
  it('detects duplicate repair/evidence events', () => {
    const session = Session.create(SessionId('dup-test-1'))
    appendEvidence(session, 'repair-1', 1, 1)
    appendEvidence(session, 'repair-1', 1, 1) // duplicate
    const dups = findDuplicateEvidence(session.events)
    expect(dups).toHaveLength(1)
    expect(dups[0]!.repairId).toBe('repair-1')
    expect(dups[0]!.attempt).toBe(1)
  })

  it('detects duplicate repair/decision events', () => {
    const session = Session.create(SessionId('dup-test-2'))
    appendDecision(session, 'repair-1', 1, 1, 'flash-repair')
    appendDecision(session, 'repair-1', 1, 1, 'flash-repair') // duplicate
    const dups = findDuplicateDecisions(session.events)
    expect(dups).toHaveLength(1)
  })

  it('detects duplicate model/escalation events', () => {
    const session = Session.create(SessionId('dup-test-3'))
    appendEscalation(session, 'repair-1', 1)
    appendEscalation(session, 'repair-1', 1) // duplicate
    const dups = findDuplicateEscalations(session.events)
    expect(dups).toHaveLength(1)
    expect(dups[0]).toBe('repair-1')
  })

  it('no duplicates in a clean sequence', () => {
    const session = Session.create(SessionId('dup-test-4'))
    appendEvidence(session, 'repair-1', 1, 1)
    appendDecision(session, 'repair-1', 1, 1, 'flash-repair')
    appendEvidence(session, 'repair-1', 1, 2)
    appendDecision(session, 'repair-1', 1, 2, 'pro-escalate')
    appendEscalation(session, 'repair-1', 1)
    expect(findDuplicateEvidence(session.events)).toHaveLength(0)
    expect(findDuplicateDecisions(session.events)).toHaveLength(0)
    expect(findDuplicateEscalations(session.events)).toHaveLength(0)
  })
})

describe('verifyEventOrdering — comprehensive check', () => {
  it('all invariants pass for a well-ordered sequence', () => {
    const session = Session.create(SessionId('comp-test-1'))
    appendRoutingDecision(session, 1, 'rd-1')
    appendVerification(session, 1, false)
    appendEvidence(session, 'repair-1', 1, 1)
    appendDecision(session, 'repair-1', 1, 1, 'pro-escalate')
    appendEscalation(session, 'repair-1', 1)
    appendRoutingDecision(session, 2, 'rd-pro-1')

    const result = verifyEventOrdering(session.events, 1)
    expect(result.evidenceAfterVerification).toBe(true)
    expect(result.decisionAfterEvidence).toBe(true)
    expect(result.escalationAfterDecision).toBe(true)
    expect(result.routingAfterEscalation).toBe(true)
    expect(result.duplicateEvidence).toHaveLength(0)
    expect(result.duplicateDecisions).toHaveLength(0)
    expect(result.duplicateEscalations).toHaveLength(0)
  })
})

describe('crash boundary tests', () => {
  it('crash after verification FAIL, before repair/evidence → restart creates evidence once', () => {
    const session = Session.create(SessionId('crash-boundary-1'))
    appendRoutingDecision(session, 1, 'rd-1')
    appendVerification(session, 1, false)
    // Crash: no repair/evidence yet
    // Restart: should create evidence once
    appendEvidence(session, 'repair-1', 1, 1)
    expect(findDuplicateEvidence(session.events)).toHaveLength(0)
  })

  it('crash after repair/evidence, before repair/decision → restart decides once', () => {
    const session = Session.create(SessionId('crash-boundary-2'))
    appendEvidence(session, 'repair-1', 1, 1)
    // Crash: no repair/decision yet
    // Restart: should decide once
    appendDecision(session, 'repair-1', 1, 1, 'flash-repair')
    expect(findDuplicateDecisions(session.events)).toHaveLength(0)
  })

  it('crash after repair/decision=PRO_ESCALATE, before model/escalation → restart escalates once', () => {
    const session = Session.create(SessionId('crash-boundary-3'))
    appendEvidence(session, 'repair-1', 1, 1)
    appendEvidence(session, 'repair-1', 1, 2)
    appendDecision(session, 'repair-1', 1, 2, 'pro-escalate')
    // Crash: no model/escalation yet
    // Restart: should escalate once
    appendEscalation(session, 'repair-1', 1)
    expect(findDuplicateEscalations(session.events)).toHaveLength(0)
  })

  it('crash after model/escalation, before Pro request → restart runs Pro once', () => {
    const session = Session.create(SessionId('crash-boundary-4'))
    appendEscalation(session, 'repair-1', 1)
    // Crash: no Pro routing-decision yet
    // Restart: should create one new routing-decision
    appendRoutingDecision(session, 2, 'rd-pro-1')
    expect(newRoutingFollowsEscalation(session.events)).toBe(true)
  })

  it('crash after Pro request/usage, before verification → restart must not rebill', () => {
    // The session log has model/usage for the Pro attempt but no
    // goal/verification yet. On restart, the runtime should verify
    // the existing workspace state rather than making another Pro call.
    const session = Session.create(SessionId('crash-boundary-5'))
    appendEscalation(session, 'repair-1', 1)
    appendRoutingDecision(session, 2, 'rd-pro-1')
    session.append('model/usage', {
      turn: 2, step: 0, attempt: 2, provider: 'deepseek', model: 'deepseek-v4-pro',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 0,
        totalTokens: 150,
        cacheReadTokens: 0,
        cacheMissTokens: 100,
      },
    } as never, { ignorable: true })
    // No goal/verification yet — crash happened before verification
    // Restart should verify, not make another Pro call
    appendVerification(session, 2, true)
    expect(evidenceFollowsVerification(session.events, 2)).toBe(true)
  })
})
