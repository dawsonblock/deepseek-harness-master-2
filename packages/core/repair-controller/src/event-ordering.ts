/**
 * Durable event ordering and idempotency invariants for the repair
 * runtime. These functions verify that the session event log follows
 * the required sequence and that events with deterministic IDs are
 * not duplicated on restart.
 *
 * @module @deepseek-ai/dsh-repair-controller/event-ordering
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Required event ordering for a failed Flash attempt:
 *   model/routing-decision → model/request → model/usage →
 *   goal/verification → repair/evidence → repair/decision
 *
 * For escalation:
 *   repair/decision(pro-escalate) → model/escalation →
 *   model/routing-decision → model/request → ...
 */

/** Find the sequence number of the last event of a given type. */
function lastSeqOfType(events: readonly SessionEvent[], type: string): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === type) return i
  }
  return -1
}

/**
 * Verify that repair/evidence follows goal/verification for a given turn.
 * @param events - the session event log.
 * @param turn - the turn to check.
 * @returns true if evidence follows verification.
 */
export function evidenceFollowsVerification(events: readonly SessionEvent[], turn: number): boolean {
  const verificationSeq = events.findIndex(
    e => e.type === 'goal/verification' && (e.data as { turn?: number }).turn === turn,
  )
  const evidenceSeq = events.findIndex(
    e => (e.type as string) === 'repair/evidence' && (e.data as { turn?: number }).turn === turn,
  )
  if (verificationSeq === -1 || evidenceSeq === -1) return true
  return evidenceSeq > verificationSeq
}

/**
 * Verify that repair/decision follows repair/evidence for a given turn.
 * @param events - the session event log.
 * @param turn - the turn to check.
 * @returns true if decision follows evidence.
 */
export function decisionFollowsEvidence(events: readonly SessionEvent[], turn: number): boolean {
  const evidenceSeq = events.findIndex(
    e => (e.type as string) === 'repair/evidence' && (e.data as { turn?: number }).turn === turn,
  )
  const decisionSeq = events.findIndex(
    e => (e.type as string) === 'repair/decision' && (e.data as { turn?: number }).turn === turn,
  )
  if (evidenceSeq === -1 || decisionSeq === -1) return true
  return decisionSeq > evidenceSeq
}

/**
 * Verify that model/escalation follows repair/decision(pro-escalate).
 * @param events - the session event log.
 * @returns true if escalation follows the pro-escalate decision.
 */
export function escalationFollowsDecision(events: readonly SessionEvent[]): boolean {
  const decisionSeq = events.findIndex(
    e => (e.type as string) === 'repair/decision' && (e.data as { action?: string }).action === 'pro-escalate',
  )
  const escalationSeq = events.findIndex(e => (e.type as string) === 'model/escalation')
  if (decisionSeq === -1 || escalationSeq === -1) return true
  return escalationSeq > decisionSeq
}

/**
 * Verify that a new routing decision follows model/escalation.
 * @param events - the session event log.
 * @returns true if the new routing decision follows escalation.
 */
export function newRoutingFollowsEscalation(events: readonly SessionEvent[]): boolean {
  const escalationSeq = lastSeqOfType(events, 'model/escalation')
  if (escalationSeq === -1) return true
  // Find the next routing-decision after escalation
  for (let i = escalationSeq + 1; i < events.length; i++) {
    if ((events[i]?.type as string) === 'model/routing-decision') return true
  }
  return false
}

/**
 * Check for duplicate repair/evidence events with the same repairId
 * and attempt number. On restart, duplicates must not be emitted.
 * @param events - the session event log.
 * @returns array of duplicate (repairId, attempt) pairs.
 */
export function findDuplicateEvidence(events: readonly SessionEvent[]): Array<{ repairId: string; attempt: number }> {
  const seen = new Set<string>()
  const duplicates: Array<{ repairId: string; attempt: number }> = []
  for (const event of events) {
    if ((event.type as string) !== 'repair/evidence') continue
    const data = event.data as { repairId: string; attempt: number }
    const key = `${data.repairId}:${data.attempt}`
    if (seen.has(key)) {
      duplicates.push({ repairId: data.repairId, attempt: data.attempt })
    } else {
      seen.add(key)
    }
  }
  return duplicates
}

/**
 * Check for duplicate repair/decision events with the same repairId
 * and attempt number.
 * @param events - the session event log.
 * @returns array of duplicate (repairId, attempt) pairs.
 */
export function findDuplicateDecisions(events: readonly SessionEvent[]): Array<{ repairId: string; attempt: number }> {
  const seen = new Set<string>()
  const duplicates: Array<{ repairId: string; attempt: number }> = []
  for (const event of events) {
    if ((event.type as string) !== 'repair/decision') continue
    const data = event.data as { repairId: string; attempt: number }
    const key = `${data.repairId}:${data.attempt}`
    if (seen.has(key)) {
      duplicates.push({ repairId: data.repairId, attempt: data.attempt })
    } else {
      seen.add(key)
    }
  }
  return duplicates
}

/**
 * Check for duplicate model/escalation events with the same repairId.
 * @param events - the session event log.
 * @returns array of duplicate repairIds.
 */
export function findDuplicateEscalations(events: readonly SessionEvent[]): string[] {
  const seen = new Set<string>()
  const duplicates: string[] = []
  for (const event of events) {
    if ((event.type as string) !== 'model/escalation') continue
    const data = event.data as { repairId: string }
    if (seen.has(data.repairId)) {
      duplicates.push(data.repairId)
    } else {
      seen.add(data.repairId)
    }
  }
  return duplicates
}

/**
 * Verify all event ordering invariants for a repair sequence.
 * @param events - the session event log.
 * @param turn - the turn to check.
 * @returns an object with each invariant's result.
 */
export function verifyEventOrdering(events: readonly SessionEvent[], turn: number): {
  evidenceAfterVerification: boolean
  decisionAfterEvidence: boolean
  escalationAfterDecision: boolean
  routingAfterEscalation: boolean
  duplicateEvidence: Array<{ repairId: string; attempt: number }>
  duplicateDecisions: Array<{ repairId: string; attempt: number }>
  duplicateEscalations: string[]
} {
  return {
    evidenceAfterVerification: evidenceFollowsVerification(events, turn),
    decisionAfterEvidence: decisionFollowsEvidence(events, turn),
    escalationAfterDecision: escalationFollowsDecision(events),
    routingAfterEscalation: newRoutingFollowsEscalation(events),
    duplicateEvidence: findDuplicateEvidence(events),
    duplicateDecisions: findDuplicateDecisions(events),
    duplicateEscalations: findDuplicateEscalations(events),
  }
}
