/**
 * P1.6 workspace SHA-256 provenance tests. Verifies that:
 *
 * 1. When a `workspaceProvenanceProvider` is configured, the computed
 *    hash is included in `repair/evidence` events and `RepairAttempt`.
 * 2. When no provider is configured, no `workspaceHash` field appears.
 * 3. The workspace hash survives replay reconstruction.
 * 4. Different workspace states produce different hashes.
 *
 * @module @deepseek-ai/dsh-repair-runtime/tests/p1-provenance.spec
 */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { DEFAULT_REPAIR_LIMITS, decideRepair } from '@deepseek-ai/dsh-repair-controller'
import type { GoalVerificationCheck } from '@deepseek-ai/dsh-goal'
import type { ModelRef } from '@deepseek-ai/dsh-repair-controller'
import type { ModelPricing } from '@deepseek-ai/dsh-token-meter'
import {
  type RepairHandlerDeps,
  type RepairState,
  type WorkspaceProvenanceProvider,
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

/** Simple provenance provider that hashes the changed file paths. */
const hashFilePaths: WorkspaceProvenanceProvider = ctx =>
  createHash('sha256').update(ctx.changedFiles.join(':')).digest('hex')

describe('P1.6: workspace hash included in repair/evidence when provider is configured', () => {
  it('repair/evidence event contains workspaceHash from the provider', () => {
    const session = Session.create(SessionId('prov-hash'))
    const goalId = 'goal-prov-hash'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps({ workspaceProvenanceProvider: hashFilePaths })

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    const evidenceEvent = session.events.find(e => e.type === 'repair/evidence')
    expect(evidenceEvent).toBeDefined()
    const data = evidenceEvent!.data as { workspaceHash?: string; changedFiles: readonly string[] }
    expect(data.workspaceHash).toBeDefined()
    const expectedHash = createHash('sha256').update(data.changedFiles.join(':')).digest('hex')
    expect(data.workspaceHash).toBe(expectedHash)
  })

  it('RepairAttempt contains workspaceHash from the provider', () => {
    const session = Session.create(SessionId('prov-attempt'))
    const goalId = 'goal-prov-attempt'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps({ workspaceProvenanceProvider: hashFilePaths })

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    expect(state.attempts[0]!.workspaceHash).toBeDefined()
  })
})

describe('P1.6: no workspaceHash when provider is not configured', () => {
  it('repair/evidence event has no workspaceHash field', () => {
    const session = Session.create(SessionId('prov-none'))
    const goalId = 'goal-prov-none'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps() // no workspaceProvenanceProvider

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    const evidenceEvent = session.events.find(e => e.type === 'repair/evidence')
    expect(evidenceEvent).toBeDefined()
    const data = evidenceEvent!.data as { workspaceHash?: string }
    expect(data.workspaceHash).toBeUndefined()
  })

  it('RepairAttempt has no workspaceHash field', () => {
    const session = Session.create(SessionId('prov-none-attempt'))
    const goalId = 'goal-prov-none-attempt'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps()

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    expect(state.attempts[0]!.workspaceHash).toBeUndefined()
  })
})

describe('P1.6: workspace hash survives replay reconstruction', () => {
  it('reconstructed attempt has the same workspaceHash as the live attempt', () => {
    const session = Session.create(SessionId('prov-replay'))
    const goalId = 'goal-prov-replay'
    const repairId = computeRepairId(session.id, goalId, 1, 'rd-1')
    const state = freshState(repairId)
    const deps = defaultDeps({ workspaceProvenanceProvider: hashFilePaths })

    setupTurn(session, 1, FLASH, 'rd-1')
    appendUsage(session, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session, goalId, false, failChecks(['criterion-1']))
    handleVerificationFailure(session, state, deps, 1, failChecks(['criterion-1']))

    const liveHash = state.attempts[0]!.workspaceHash
    expect(liveHash).toBeDefined()

    // Reconstruct from durable events
    const reconstructed = reconstructRepairState(session.events, goalId, TEST_PRICING)
    expect(reconstructed).toBeDefined()
    expect(reconstructed!.attempts[0]!.workspaceHash).toBe(liveHash)
  })
})

describe('P1.6: different workspace states produce different hashes', () => {
  it('different changed files produce different workspace hashes', () => {
    const session1 = Session.create(SessionId('prov-diff-1'))
    const goalId1 = 'goal-prov-diff-1'
    const repairId1 = computeRepairId(session1.id, goalId1, 1, 'rd-1')
    const state1 = freshState(repairId1)
    const deps = defaultDeps({ workspaceProvenanceProvider: hashFilePaths })

    // First attempt: changes file A
    setupTurn(session1, 1, FLASH, 'rd-1')
    appendUsage(session1, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session1, goalId1, false, failChecks(['criterion-1']))
    // Simulate changed files by appending a tool/call event
    session1.append('tool/call', {
      callId: 'call-1', name: 'write_file', arguments: JSON.stringify({ file_path: 'src/a.ts' }),
      turn: 1, recoveryMode: 'idempotent',
    } as never, { ignorable: true })
    handleVerificationFailure(session1, state1, deps, 1, failChecks(['criterion-1']))

    const hash1 = state1.attempts[0]!.workspaceHash

    // Second attempt: changes file B
    const session2 = Session.create(SessionId('prov-diff-2'))
    const goalId2 = 'goal-prov-diff-2'
    const repairId2 = computeRepairId(session2.id, goalId2, 1, 'rd-1')
    const state2 = freshState(repairId2)

    setupTurn(session2, 1, FLASH, 'rd-1')
    appendUsage(session2, 'rd-1', 1, FLASH, { input: 1000, output: 500, cacheRead: 200, cacheMiss: 800 })
    appendVerification(session2, goalId2, false, failChecks(['criterion-1']))
    session2.append('tool/call', {
      callId: 'call-2', name: 'write_file', arguments: JSON.stringify({ file_path: 'src/b.ts' }),
      turn: 1, recoveryMode: 'idempotent',
    } as never, { ignorable: true })
    handleVerificationFailure(session2, state2, deps, 1, failChecks(['criterion-1']))

    const hash2 = state2.attempts[0]!.workspaceHash

    expect(hash1).toBeDefined()
    expect(hash2).toBeDefined()
    expect(hash1).not.toBe(hash2)
  })
})
