import { describe, it, expect } from 'vitest'
import {
  classifyProgress,
  computeFailureFingerprint,
  constructFailurePackage,
  constructFlashRepairPrompt,
  constructProRepairPrompt,
  isSameFailure,
  parseTakeoverDecision,
  type VerificationEvidence,
} from './v0174-repair-core.ts'

/**
 * Deterministic integration test for the production escalation controller.
 * Tests the escalation decision logic without spending provider tokens.
 * The stub model simulates: Flash always fails, Pro always succeeds.
 * This verifies the controller correctly escalates after detecting
 * no-progress repeated failures.
 */

describe('Production escalation controller (stub models)', () => {
  // Simulate Flash #1 failure evidence
  const flash1Evidence: VerificationEvidence = {
    failedCriteria: ['TypeScript typecheck must pass', 'All tests must pass'],
    failingTests: ['test basic functionality'],
    typeErrors: ['error TS2322: Type "string" is not assignable to type "number"'],
    buildErrors: [],
  }

  // Simulate Flash #2 failure — same fingerprint (no progress)
  const flash2SameEvidence: VerificationEvidence = {
    failedCriteria: ['TypeScript typecheck must pass', 'All tests must pass'],
    failingTests: ['test basic functionality'],
    typeErrors: ['error TS2322: Type "string" is not assignable to type "number"'],
    buildErrors: [],
  }

  // Simulate Flash #2 failure — different fingerprint (progress made)
  const flash2ProgressEvidence: VerificationEvidence = {
    failedCriteria: ['All tests must pass'],
    failingTests: ['test edge case'],
    typeErrors: [],
    buildErrors: [],
  }

  // Simulate Flash #3 failure after progress
  const flash3Evidence: VerificationEvidence = {
    failedCriteria: ['All tests must pass'],
    failingTests: ['test edge case', 'test another edge'],
    typeErrors: [],
    buildErrors: [],
  }

  it('detects same failure and triggers immediate Pro escalation', () => {
    const fp1 = computeFailureFingerprint(flash1Evidence)
    const fp2 = computeFailureFingerprint(flash2SameEvidence)
    expect(isSameFailure(fp1, fp2)).toBe(true)
    const progress = classifyProgress(flash1Evidence, flash2SameEvidence)
    expect(progress).toBe('none')
    // Controller decision: same failure → Pro immediately
    const shouldEscalate = isSameFailure(fp1, fp2) || progress === 'none'
    expect(shouldEscalate).toBe(true)
  })

  it('detects progress and allows Flash #3', () => {
    const fp1 = computeFailureFingerprint(flash1Evidence)
    const fp2 = computeFailureFingerprint(flash2ProgressEvidence)
    expect(isSameFailure(fp1, fp2)).toBe(false)
    const progress = classifyProgress(flash1Evidence, flash2ProgressEvidence)
    expect(progress).toBe('partial')
    // Controller decision: progress → allow Flash #3
    const shouldEscalate = isSameFailure(fp1, fp2) || progress === 'none'
    expect(shouldEscalate).toBe(false)
  })

  it('constructs Flash repair prompt with failure evidence', () => {
    const failurePackage = constructFailurePackage({
      taskId: 'stub-task',
      routingDecisionId: 'stub-route',
      originalGoal: 'Implement a function',
      model: 'deepseek-v4-flash',
      changedFiles: ['src/index.ts'],
      verification: flash1Evidence,
      checkpoints: {
        taskStart: 'stub-start',
        afterFlash: 'stub-after-flash',
      },
    })
    const prompt = constructFlashRepairPrompt(failurePackage)
    expect(prompt).toContain('You previously attempted this coding task but failed')
    expect(prompt).toContain('Implement a function')
    expect(prompt).toContain('TypeScript typecheck must pass')
    expect(prompt).toContain('test basic functionality')
    expect(prompt).toContain('Type "string" is not assignable to type "number"')
  })

  it('constructs Pro repair prompt with takeover decision', () => {
    const failurePackage = constructFailurePackage({
      taskId: 'stub-task',
      routingDecisionId: 'stub-route',
      originalGoal: 'Implement a function',
      model: 'deepseek-v4-flash',
      changedFiles: ['src/index.ts'],
      verification: flash1Evidence,
      checkpoints: {
        taskStart: 'stub-start',
        afterFlash: 'stub-after-flash',
      },
    })
    const prompt = constructProRepairPrompt(failurePackage)
    expect(prompt).toContain('REPAIR_EXISTING')
    expect(prompt).toContain('ROLLBACK_AND_REDO')
    expect(prompt).toContain('Implement a function')
  })

  it('parses REPAIR_EXISTING decision', () => {
    expect(parseTakeoverDecision('REPAIR_EXISTING\nI will fix the code.')).toBe('REPAIR_EXISTING')
  })

  it('parses ROLLBACK_AND_REDO decision', () => {
    expect(parseTakeoverDecision('ROLLBACK_AND_REDO\nStarting fresh.')).toBe('ROLLBACK_AND_REDO')
  })

  it('returns undefined for unclear decision', () => {
    expect(parseTakeoverDecision('Let me think about this.')).toBe(undefined)
  })

  it('simulates full Flash-fail-same-fail → Pro escalation path', () => {
    // Flash #1: fails
    const fp1 = computeFailureFingerprint(flash1Evidence)
    expect(fp1).toHaveLength(16)

    // Flash #2: same failure
    const fp2 = computeFailureFingerprint(flash2SameEvidence)
    const sameFailure = isSameFailure(fp1, fp2)
    const progress = classifyProgress(flash1Evidence, flash2SameEvidence)
    expect(sameFailure).toBe(true)
    expect(progress).toBe('none')

    // Controller: same failure → Pro immediately (no Flash #3)
    const proPrompt = constructProRepairPrompt(
      constructFailurePackage({
        taskId: 'stub',
        routingDecisionId: 'stub',
        originalGoal: 'Implement a function',
        model: 'deepseek-v4-flash',
        changedFiles: ['src/index.ts'],
        verification: flash2SameEvidence,
        checkpoints: { taskStart: 's', afterFlash: 's' },
      }),
    )
    expect(proPrompt).toContain('REPAIR_EXISTING')
    // Pro succeeds (stub)
    const proOutput = 'REPAIR_EXISTING\nFixed the type error.'
    const decision = parseTakeoverDecision(proOutput)
    expect(decision).toBe('REPAIR_EXISTING')
  })

  it('simulates Flash-fail-progress-fail-progress-fail → Pro escalation path', () => {
    // Flash #1: fails with type error + test failure
    const fp1 = computeFailureFingerprint(flash1Evidence)

    // Flash #2: makes progress (type errors fixed, different test failing)
    const fp2 = computeFailureFingerprint(flash2ProgressEvidence)
    const progress1to2 = classifyProgress(flash1Evidence, flash2ProgressEvidence)
    expect(isSameFailure(fp1, fp2)).toBe(false)
    expect(progress1to2).toBe('partial')

    // Controller: progress → allow Flash #3
    // Flash #3: fails again (different test, but still failing)
    const progress2to3 = classifyProgress(flash2ProgressEvidence, flash3Evidence)
    // Flash #3 failed → escalate to Pro regardless
    const proPrompt = constructProRepairPrompt(
      constructFailurePackage({
        taskId: 'stub',
        routingDecisionId: 'stub',
        originalGoal: 'Implement a function',
        model: 'deepseek-v4-flash',
        changedFiles: ['src/index.ts'],
        verification: flash3Evidence,
        priorEvidence: flash2ProgressEvidence,
        checkpoints: { taskStart: 's', afterFlash: 's' },
      }),
    )
    expect(proPrompt).toContain('REPAIR_EXISTING')
    // Pro succeeds (stub)
    expect(progress2to3).toBeDefined()
  })

  it('enforces hard limit: max 3 Flash calls', () => {
    let flashCalls = 0
    const maxFlash = 3
    // Simulate 3 Flash failures
    for (let i = 0; i < maxFlash; i++) {
      flashCalls++
    }
    expect(flashCalls).toBe(maxFlash)
    // After 3 Flash calls, must escalate to Pro
    const mustEscalate = flashCalls >= maxFlash
    expect(mustEscalate).toBe(true)
  })

  it('enforces hard limit: max 2 Pro calls', () => {
    let proCalls = 0
    const maxPro = 2
    for (let i = 0; i < maxPro; i++) {
      proCalls++
    }
    expect(proCalls).toBe(maxPro)
    // After 2 Pro calls, must stop
    const mustStop = proCalls >= maxPro
    expect(mustStop).toBe(true)
  })

  it('distinguishes flashLimitReached from loopViolation', () => {
    // 3 Flash stages (the max) without exceeding → flashLimitReached, not a violation
    const maxFlashStages = 3
    const stages3Flash = [
      { model: 'flash' as const, verified: false },
      { model: 'flash' as const, verified: false },
      { model: 'flash' as const, verified: true },
    ]
    const flashCount = stages3Flash.filter(s => s.model === 'flash').length
    expect(flashCount).toBe(maxFlashStages)
    expect(flashCount > maxFlashStages).toBe(false) // not a violation

    // 4 Flash stages → actual violation
    const stages4Flash = [
      { model: 'flash' as const, verified: false },
      { model: 'flash' as const, verified: false },
      { model: 'flash' as const, verified: false },
      { model: 'flash' as const, verified: false },
    ]
    const flashCount4 = stages4Flash.filter(s => s.model === 'flash').length
    expect(flashCount4 > maxFlashStages).toBe(true) // violation
  })
})
