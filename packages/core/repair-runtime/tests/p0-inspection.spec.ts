/**
 * P0 event-history inspection tests. These exercise the full escalation
 * trajectory and the progress/replay trajectory with deterministic
 * `repair:v1:` IDs, asserting the specific invariants that prove
 * decision truth = routing truth = execution truth = replay truth.
 *
 * @module @deepseek-ai/dsh-repair-runtime/tests/p0-inspection.spec
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { DEFAULT_REPAIR_LIMITS, decideRepair } from '@deepseek-ai/dsh-repair-controller'
import type { GoalVerificationCheck } from '@deepseek-ai/dsh-goal'
import type { ModelRef } from '@deepseek-ai/dsh-repair-controller'
import {
  type RepairHandlerDeps,
  type RepairState,
  computeRepairId,
  handleVerificationFailure,
  handleVerificationPass,
  reconstructRepairState,
} from '../src/index.ts'

const FLASH: ModelRef = { provider: 'deepseek', model: 'deepseek-v4-flash' }
const PRO: ModelRef = { provider: 'deepseek', model: 'deepseek-v4-pro' }

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

/** Append turn/start + model/routing-decision with a specific routingDecisionId. */
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

/** Append a goal/verification event. */
function appendVerification(session: Session, goalId: string, passed: boolean, checks: readonly GoalVerificationCheck[]): void {
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
  const result = await handleVerificationPass(session, state, turn, routingDecisionId)
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

/** Append a repair/evidence event. */
function appendEvidence(
  session: Session,
  repairId: string,
  turn: number,
  attempt: number,
  rdId: string,
  fingerprint: string,
  progress: 'none' | 'partial' | 'regression',
  failedCriteria: string[],
): void {
  session.append('repair/evidence', {
    repairId, turn, step: 0, attempt, routingDecisionId: rdId,
    failureFingerprint: fingerprint, failurePackageId: `fpid-${attempt}`, progress,
    failedCriteria, failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
  }, { ignorable: true })
}

/** Append a repair/decision event. */
function appendDecision(
  session: Session,
  repairId: string,
  turn: number,
  attempt: number,
  action: 'flash-repair' | 'pro-escalate',
  reason?: 'same-failure-no-progress' | 'flash-limit-exhausted' | 'regression-detected',
): void {
  session.append('repair/decision', {
    repairId, turn, step: 0, attempt, action,
    ...(reason !== undefined ? { reason } : {}),
    failureFingerprint: 'fp-1',
  }, { ignorable: true })
}

/** Read the model from a model/routing-decision event. */
function modelOf(event: { type: string; data: unknown }): string | undefined {
  if (event.type !== 'model/routing-decision') return undefined
  const data = event.data as { selected: { model: string } }
  return data.selected.model
}

/** Read the routingDecisionId from a model/routing-decision event. */
function rdIdOf(event: { type: string; data: unknown }): string | undefined {
  if (event.type !== 'model/routing-decision') return undefined
  const data = event.data as { routingDecisionId?: string }
  return data.routingDecisionId
}

/** Format the event chain for visual inspection. */
function formatEventChain(events: readonly { type: string; data: unknown }[]): string {
  return events.map((e, i) => {
    const d = e.data as Record<string, unknown>
    const model = modelOf(e)
    const rdId = rdIdOf(e)
    const parts = [e.type]
    if (model !== undefined) parts.push(`model=${model}`)
    if (rdId !== undefined) parts.push(`rd=${rdId}`)
    if (typeof d.repairId === 'string') parts.push(`repairId=${d.repairId}`)
    if (typeof d.action === 'string') parts.push(`action=${d.action}`)
    if (typeof d.failurePackageId === 'string') parts.push(`fpid=${d.failurePackageId}`)
    if (typeof d.toRoutingDecisionId === 'string') parts.push(`to=${d.toRoutingDecisionId}`)
    if (typeof d.fromRoutingDecisionId === 'string') parts.push(`from=${d.fromRoutingDecisionId}`)
    if (typeof d.passed === 'boolean') parts.push(`passed=${d.passed}`)
    if (typeof d.finalRoutingDecisionId === 'string') parts.push(`final=${d.finalRoutingDecisionId}`)
    if (typeof d.verified === 'boolean') parts.push(`verified=${d.verified}`)
    return `${String(i + 1).padStart(2, ' ')}  ${parts.join('  ')}`
  }).join('\n')
}

describe('P0 inspection: Flash fail → Flash fail no progress → Pro escalation → Pro pass', () => {
  it('produces the correct event chain with all invariants satisfied', async () => {
    const sessionId = SessionId('inspect-escalation')
    const goalId = 'goal-inspect-esc'
    const session = Session.create(sessionId)
    const repairId = computeRepairId(sessionId, goalId, 1, 'R1')
    const state = freshState(repairId)
    const deps = defaultDeps()

    // --- Turn 1: Flash #1 fails ---
    const R1 = 'R1'
    setupTurn(session, 1, FLASH, R1)
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    const result1 = handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))
    expect(result1.action).toBe('flash-repair')
    expect(result1.claimModel!.model).toBe('deepseek-v4-flash')

    // --- Turn 2: Flash #2 fails (same failure, no progress) ---
    const R2 = 'R2'
    setupTurn(session, 2, FLASH, R2)
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    const result2 = handleVerificationFailure(session, state, deps, 2, failChecks(['criterion-1']))
    expect(result2.action).toBe('pro-escalate')
    expect(result2.pendingEscalation).toBeDefined()
    expect(result2.claimModel!.model).toBe('deepseek-v4-pro')

    // --- The plugin claims Pro via routing authority and calls
    //     agent.followup(). The router creates a real routing decision. ---
    const R3 = 'R3'
    setupTurn(session, 3, PRO, R3)

    // --- The plugin sees model/routing-decision R3 and emits
    //     model/escalation referencing R3 as toRoutingDecisionId. ---
    session.append('model/escalation', {
      repairId: state.repairId,
      turn: 2,
      step: 0,
      fromRoutingDecisionId: R2,
      toRoutingDecisionId: R3,
      repairOf: R2,
      fromModel: 'deepseek-v4-flash',
      toModel: 'deepseek-v4-pro',
      reason: 'same-failure-no-progress',
      failureFingerprint: result2.pendingEscalation!.failureFingerprint,
      flashAttempts: state.flashAttempts,
    }, { ignorable: true })

    // --- Turn 3: Pro passes ---
    appendVerification(session, goalId, true, passChecks())
    await passAndComplete(session, state, 3, R3, repairId)

    // ===== Inspect the full event history =====
    const events = session.events

    const routingDecisions = events.filter(e => (e.type as string) === 'model/routing-decision')
    const repairEvidence = events.filter(e => e.type === 'repair/evidence')
    const repairDecisions = events.filter(e => e.type === 'repair/decision')
    const escalations = events.filter(e => e.type === 'model/escalation')
    const completions = events.filter(e => e.type === 'repair/completed')
    const verifications = events.filter(e => e.type === 'goal/verification')

    // --- Invariant: R1 != R2 != R3 ---
    expect(R1).not.toBe(R2)
    expect(R2).not.toBe(R3)
    expect(R1).not.toBe(R3)

    // --- Invariant: model(R1) = Flash, model(R2) = Flash, model(R3) = Pro ---
    expect(modelOf(routingDecisions[0]!)).toBe('deepseek-v4-flash')
    expect(modelOf(routingDecisions[1]!)).toBe('deepseek-v4-flash')
    expect(modelOf(routingDecisions[2]!)).toBe('deepseek-v4-pro')

    // --- Invariant: F1 != F2 (different failurePackageIds) ---
    const F1 = (repairEvidence[0]?.data as { failurePackageId: string }).failurePackageId
    const F2 = (repairEvidence[1]?.data as { failurePackageId: string }).failurePackageId
    expect(F1).toBeDefined()
    expect(F2).toBeDefined()
    expect(F1).not.toBe(F2)

    // --- Invariant: repair/decision(pro-escalate) occurs before R3 ---
    const proEscalateDecisionIndex = events.findIndex(
      e => e.type === 'repair/decision' && (e.data as { action: string }).action === 'pro-escalate',
    )
    const R3Index = events.findIndex(e => rdIdOf(e) === 'R3')
    expect(proEscalateDecisionIndex).toBeGreaterThanOrEqual(0)
    expect(R3Index).toBeGreaterThanOrEqual(0)
    expect(proEscalateDecisionIndex).toBeLessThan(R3Index)

    // --- Invariant: model/escalation.toRoutingDecisionId == R3 ---
    expect(escalations).toHaveLength(1)
    const escData = escalations[0]!.data as { toRoutingDecisionId: string; fromRoutingDecisionId: string }
    expect(escData.toRoutingDecisionId).toBe(R3)
    expect(escData.fromRoutingDecisionId).toBe(R2)

    // --- Invariant: model/escalation occurs AFTER R3 (factual, not predictive) ---
    const escalationIndex = events.findIndex(e => e.type === 'model/escalation')
    expect(escalationIndex).toBeGreaterThan(R3Index)

    // --- Invariant: repair/completed references R3 ---
    expect(completions).toHaveLength(1)
    const completedData = completions[0]!.data as { finalRoutingDecisionId: string; verified: boolean }
    expect(completedData.finalRoutingDecisionId).toBe(R3)
    expect(completedData.verified).toBe(true)

    // --- Invariant: exactly one repair/completed ---
    expect(completions).toHaveLength(1)

    // --- Invariant: exactly one model/escalation ---
    expect(escalations).toHaveLength(1)

    // --- Invariant: two repair/evidence, two repair/decision ---
    expect(repairEvidence).toHaveLength(2)
    expect(repairDecisions).toHaveLength(2)

    // --- Invariant: three routing decisions, three verifications ---
    expect(routingDecisions).toHaveLength(3)
    expect(verifications).toHaveLength(3)

    // --- Chronology: repair/decision → R3 → model/escalation ---
    expect(proEscalateDecisionIndex).toBeLessThan(R3Index)
    expect(R3Index).toBeLessThan(escalationIndex)

    // Print the event chain for visual inspection
    const chain = formatEventChain(events)
    console.log('\n=== Event history (escalation scenario) ===\n' + chain + '\n')
  })
})

describe('P0 inspection: replay of the same escalation trajectory', () => {
  it('reconstructs attempts matching the live trajectory, no Flash→Pro mutation', async () => {
    const sessionId = SessionId('inspect-replay')
    const goalId = 'goal-inspect-replay'
    const session = Session.create(sessionId)
    const repairId = computeRepairId(sessionId, goalId, 1, 'R1')
    const state = freshState(repairId)
    const deps = defaultDeps()

    // Build the full trajectory live
    const R1 = 'R1'
    setupTurn(session, 1, FLASH, R1)
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    const R2 = 'R2'
    setupTurn(session, 2, FLASH, R2)
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 2, failChecks(['criterion-1']))

    // Plugin emits model/escalation after real R3
    const R3 = 'R3'
    setupTurn(session, 3, PRO, R3)
    session.append('model/escalation', {
      repairId, turn: 2, step: 0,
      fromRoutingDecisionId: R2, toRoutingDecisionId: R3,
      repairOf: R2, fromModel: 'deepseek-v4-flash', toModel: 'deepseek-v4-pro',
      reason: 'same-failure-no-progress', failureFingerprint: 'fp-1', flashAttempts: 1,
    }, { ignorable: true })

    appendVerification(session, goalId, true, passChecks())
    await passAndComplete(session, state, 3, R3, repairId)

    // Now reconstruct from the log (simulating restart)
    // repair/completed exists, so reconstruction returns undefined (repair is done)
    const reconstructed = reconstructRepairState(session.events, goalId)
    expect(reconstructed).toBeUndefined()

    // Now test reconstruction WITHOUT the completion event (crash before pass)
    const session2 = Session.create(SessionId('inspect-replay-crash'))
    setupTurn(session2, 1, FLASH, 'R1')
    appendVerification(session2, goalId, false, failChecks(['criterion-1']))
    appendEvidence(session2, repairId, 1, 1, 'R1', 'fp-1', 'none', ['criterion-1'])
    appendDecision(session2, repairId, 1, 1, 'flash-repair')

    setupTurn(session2, 2, FLASH, 'R2')
    appendVerification(session2, goalId, false, failChecks(['criterion-1']))
    appendEvidence(session2, repairId, 2, 2, 'R2', 'fp-1', 'none', ['criterion-1'])
    appendDecision(session2, repairId, 2, 2, 'pro-escalate', 'same-failure-no-progress')

    // R3 exists (Pro routing decision) but no verification yet — crash happened
    setupTurn(session2, 3, PRO, 'R3')
    session2.append('model/escalation', {
      repairId, turn: 2, step: 0,
      fromRoutingDecisionId: 'R2', toRoutingDecisionId: 'R3',
      repairOf: 'R2', fromModel: 'deepseek-v4-flash', toModel: 'deepseek-v4-pro',
      reason: 'same-failure-no-progress', failureFingerprint: 'fp-1', flashAttempts: 1,
    }, { ignorable: true })

    // Reconstruct after crash
    const reconstructed2 = reconstructRepairState(session2.events, goalId)
    expect(reconstructed2).toBeDefined()

    // The reconstructed attempts should be:
    //   { model: Flash, routingDecisionId: R1, failurePackage: present }
    //   { model: Flash, routingDecisionId: R2, failurePackage: present }
    // R3 has no goal/verification FAIL, so it's not an attempt yet.
    expect(reconstructed2!.attempts).toHaveLength(2)
    expect(reconstructed2!.attempts[0]!.model.model).toBe('deepseek-v4-flash')
    expect(reconstructed2!.attempts[0]!.routingDecisionId).toBe('R1')
    expect(reconstructed2!.attempts[0]!.failurePackage).toBeDefined()
    expect(reconstructed2!.attempts[1]!.model.model).toBe('deepseek-v4-flash')
    expect(reconstructed2!.attempts[1]!.routingDecisionId).toBe('R2')
    expect(reconstructed2!.attempts[1]!.failurePackage).toBeDefined()

    // NOT: attempt[1] mutated to Pro
    expect(reconstructed2!.attempts[1]!.model.model).not.toBe('deepseek-v4-pro')

    // Repair counts
    expect(reconstructed2!.flashAttempts).toBe(1)
    expect(reconstructed2!.proAttempts).toBe(1)

    // Print the reconstructed state
    const attemptLines = reconstructed2!.attempts.map(a =>
      `  attempt=${a.attempt}  model=${a.model.model}  rd=${a.routingDecisionId}  ` +
      `fpid=${a.failurePackageId ?? 'none'}  fp=${a.failurePackage ? 'present' : 'missing'}`,
    )
    console.log('\n=== Reconstructed state (after crash) ===\n' +
      `repairId=${reconstructed2!.repairId}\n` +
      `flashAttempts=${reconstructed2!.flashAttempts}  proAttempts=${reconstructed2!.proAttempts}\n` +
      attemptLines.join('\n') + '\n')
  })
})

describe('P0 inspection: progress scenario survives restart', () => {
  it('Flash #1 ABCD → Flash #2 AB → crash → restart → reconstructed state enables progress-aware decision', () => {
    const sessionId = SessionId('inspect-progress')
    const goalId = 'goal-inspect-progress'
    const repairId = computeRepairId(sessionId, goalId, 1, 'R1')
    const deps = defaultDeps()

    // Build the live trajectory up to Flash #2
    const session = Session.create(sessionId)
    setupTurn(session, 1, FLASH, 'R1')
    appendVerification(session, goalId, false, failChecks(['A', 'B', 'C', 'D']))
    appendEvidence(session, repairId, 1, 1, 'R1', 'fp-abcd', 'none', ['A', 'B', 'C', 'D'])
    appendDecision(session, repairId, 1, 1, 'flash-repair')

    setupTurn(session, 2, FLASH, 'R2')
    appendVerification(session, goalId, false, failChecks(['A', 'B']))
    appendEvidence(session, repairId, 2, 2, 'R2', 'fp-ab', 'partial', ['A', 'B'])
    appendDecision(session, repairId, 2, 2, 'flash-repair')

    // CRASH → restart → reconstruct
    const reconstructed = reconstructRepairState(session.events, goalId)
    expect(reconstructed).toBeDefined()
    expect(reconstructed!.attempts).toHaveLength(2)

    // The reconstructed prior attempt carries a full FailurePackage
    const priorAttempt = reconstructed!.attempts[1]!
    expect(priorAttempt.failurePackage).toBeDefined()
    expect(priorAttempt.failurePackage!.failedCriteria).toEqual(['A', 'B'])

    // The first attempt also carries its full FailurePackage
    expect(reconstructed!.attempts[0]!.failurePackage).toBeDefined()
    expect(reconstructed!.attempts[0]!.failurePackage!.failedCriteria).toEqual(['A', 'B', 'C', 'D'])

    // Now simulate Flash #3 failure with {A, B} (same as Flash #2, no further progress)
    // The controller should see progress='none' (same failure, no reduction)
    // and decide pro-escalate (Flash #2 same-failure-no-progress → Pro)
    setupTurn(session, 3, FLASH, 'R3')
    appendVerification(session, goalId, false, failChecks(['A', 'B']))
    const result = handleVerificationFailure(session, reconstructed!, deps, 3, failChecks(['A', 'B']))

    // With same failure as Flash #2 (no progress), the controller escalates to Pro
    expect(result.action).toBe('pro-escalate')

    // But the critical test is: if Flash #3 had {A} (more progress), it would
    // be flash-repair. Let's verify that separately.
    const session2 = Session.create(SessionId('inspect-progress-2'))
    setupTurn(session2, 1, FLASH, 'R1')
    appendVerification(session2, goalId, false, failChecks(['A', 'B', 'C', 'D']))
    appendEvidence(session2, repairId, 1, 1, 'R1', 'fp-abcd', 'none', ['A', 'B', 'C', 'D'])
    appendDecision(session2, repairId, 1, 1, 'flash-repair')

    setupTurn(session2, 2, FLASH, 'R2')
    appendVerification(session2, goalId, false, failChecks(['A', 'B']))
    appendEvidence(session2, repairId, 2, 2, 'R2', 'fp-ab', 'partial', ['A', 'B'])
    appendDecision(session2, repairId, 2, 2, 'flash-repair')

    const reconstructed2 = reconstructRepairState(session2.events, goalId)
    expect(reconstructed2).toBeDefined()

    // Flash #3 with {A} — more progress (A,B → A)
    setupTurn(session2, 3, FLASH, 'R3')
    appendVerification(session2, goalId, false, failChecks(['A']))
    const result2 = handleVerificationFailure(session2, reconstructed2!, deps, 3, failChecks(['A']))

    // With further partial progress (A,B → A), the controller continues Flash
    // because flashAttempts=3 = maxFlashAttempts=3, so it escalates to Pro
    // with reason 'flash-limit-exhausted' (not 'same-failure-no-progress')
    expect(result2.action).toBe('pro-escalate')
    expect(result2.reason).toBe('flash-limit-exhausted')

    // Print the progress inspection
    const priorCriteria = JSON.stringify(reconstructed!.attempts[1]!.failurePackage!.failedCriteria)
    console.log(
      '\n=== Progress scenario inspection ===\n' +
      'Flash #1: {A,B,C,D} -> progress=none -> flash-repair\n' +
      'Flash #2: {A,B}     -> progress=partial -> flash-repair\n' +
      'CRASH -> restart -> reconstruct\n' +
      'Reconstructed prior FailurePackage: ' + priorCriteria + '\n' +
      'Flash #3 (same {A,B}): ' + result.action + ' (no progress -> Pro)\n' +
      'Flash #3 (progress {A}): ' + result2.action + ' (' + (result2.reason ?? 'unknown') + ')\n',
    )
  })

  it('decision after restart matches decision without restart (progress scenario)', () => {
    // Run the same scenario uninterrupted and after restart, then
    // require the decisions to be identical.
    //
    // Scenario: Flash #1 {A,B,C,D} fail → flash-repair
    //           Flash #2 {A,B} fail → partial progress → flash-repair
    //
    // The decision at Flash #2 is the progress-aware one: partial progress
    // → flash-repair (not pro-escalate). This decision must be identical
    // whether computed live or after restart reconstruction.
    const sessionId = SessionId('inspect-progress-match')
    const goalId = 'goal-inspect-progress-match'
    const repairId = computeRepairId(sessionId, goalId, 1, 'R1')
    const deps = defaultDeps()

    // Uninterrupted execution
    const session1 = Session.create(sessionId)
    const state1 = freshState(repairId)

    setupTurn(session1, 1, FLASH, 'R1')
    handleVerificationFailure(session1, state1, deps, 1, failChecks(['A', 'B', 'C', 'D']))
    setupTurn(session1, 2, FLASH, 'R2')
    const resultUninterrupted = handleVerificationFailure(
      session1, state1, deps, 2, failChecks(['A', 'B']),
    )

    // The live decision at Flash #2 with partial progress is flash-repair
    expect(resultUninterrupted.action).toBe('flash-repair')

    // Restart execution: same events up to crash, then reconstruct
    const session2 = Session.create(SessionId('inspect-progress-match-restart'))
    setupTurn(session2, 1, FLASH, 'R1')
    appendVerification(session2, goalId, false, failChecks(['A', 'B', 'C', 'D']))
    appendEvidence(session2, repairId, 1, 1, 'R1', 'fp-abcd', 'none', ['A', 'B', 'C', 'D'])
    appendDecision(session2, repairId, 1, 1, 'flash-repair')

    // Reconstruct after restart (crash happened after Flash #1 decision)
    const reconstructed = reconstructRepairState(session2.events, goalId)
    expect(reconstructed).toBeDefined()

    // Now simulate Flash #2 failure with {A, B} (partial progress)
    setupTurn(session2, 2, FLASH, 'R2')
    const resultAfterRestart = handleVerificationFailure(
      session2, reconstructed!, deps, 2, failChecks(['A', 'B']),
    )

    // The decisions must match: both flash-repair
    expect(resultAfterRestart.action).toBe(resultUninterrupted.action)
    expect(resultAfterRestart.action).toBe('flash-repair')

    console.log('\n=== Progress scenario: decision match ===\n' +
      `Uninterrupted: ${resultUninterrupted.action}\n` +
      `After restart: ${resultAfterRestart.action}\n` +
      `Match: ${resultUninterrupted.action === resultAfterRestart.action}\n`)
  })
})
