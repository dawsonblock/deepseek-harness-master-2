import { describe, expect, it } from 'vitest'
import {
  type FailurePackage,
  type LoopBounds,
  type StageAttempt,
  type TaskTrajectory,
  type VerificationEvidence,
  classifyProgress,
  computeFailureFingerprint,
  computePolicyMetrics,
  computeRepairAdvantage,
  constructEvidenceOnlyPrompt,
  constructFailurePackage,
  constructProRepairPrompt,
  constructWorkspaceOnlyPrompt,
  countFailures,
  decideEscalation,
  detectLoopViolation,
  isSameFailure,
  isSemanticSameFailure,
  normalizeFailureText,
  parseTakeoverDecision,
  semanticFailureOverlap,
} from './v0174-repair-core.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvidence(overrides: Partial<VerificationEvidence> = {}): VerificationEvidence {
  return {
    failedCriteria: [],
    failingTests: [],
    typeErrors: [],
    buildErrors: [],
    ...overrides,
  }
}

function makeStage(overrides: Partial<StageAttempt> & { model: 'flash' | 'pro' }): StageAttempt {
  return {
    routingDecisionId: 'rd-test',
    verified: false,
    costUsd: 0.001,
    latencyMs: 1000,
    usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 0, totalTokens: 150 },
    ...overrides,
  }
}

function makeTrajectory(overrides: Partial<TaskTrajectory>): TaskTrajectory {
  return {
    taskId: 'task-1',
    policy: 'flash-only',
    verified: false,
    stages: [],
    escalated: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// normalizeFailureText
// ---------------------------------------------------------------------------

describe('normalizeFailureText', () => {
  it('strips absolute file paths with line:col positions', () => {
    const result = normalizeFailureText('/home/user/src/index.ts:42:13 Type error')
    expect(result).toBe('<file:line:col> type error')
  })

  it('strips absolute file paths without positions', () => {
    const result = normalizeFailureText('Error in /home/user/src/index.ts')
    expect(result).toBe('error in <file>')
  })

  it('strips timing in milliseconds', () => {
    const result = normalizeFailureText('Test took 123ms')
    expect(result).toBe('test took <ms>')
  })

  it('collapses whitespace and lowercases', () => {
    const result = normalizeFailureText('  Multiple   Spaces  AND   Case  ')
    expect(result).toBe('multiple spaces and case')
  })

  it('strips hex addresses', () => {
    const result = normalizeFailureText('Pointer 0xdeadbeef leaked')
    expect(result).toBe('pointer <hex> leaked')
  })
})

// ---------------------------------------------------------------------------
// computeFailureFingerprint
// ---------------------------------------------------------------------------

describe('computeFailureFingerprint', () => {
  it('produces a 16-character hex string', () => {
    const fingerprint = computeFailureFingerprint(makeEvidence({
      failedCriteria: ['test criterion'],
    }))
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/)
  })

  it('is deterministic for identical evidence', () => {
    const evidence = makeEvidence({
      failedCriteria: ['criterion A', 'criterion B'],
      failingTests: ['test1', 'test2'],
    })
    expect(computeFailureFingerprint(evidence)).toBe(computeFailureFingerprint(evidence))
  })

  it('is order-independent within categories', () => {
    const evidenceA = makeEvidence({ failedCriteria: ['alpha', 'beta'] })
    const evidenceB = makeEvidence({ failedCriteria: ['beta', 'alpha'] })
    expect(computeFailureFingerprint(evidenceA)).toBe(computeFailureFingerprint(evidenceB))
  })

  it('ignores incidental path differences', () => {
    const evidenceA = makeEvidence({
      typeErrors: ['/home/user/src/index.ts:42:13 Type error'],
    })
    const evidenceB = makeEvidence({
      typeErrors: ['/tmp/worker/src/index.ts:42:13 Type error'],
    })
    expect(computeFailureFingerprint(evidenceA)).toBe(computeFailureFingerprint(evidenceB))
  })

  it('ignores timing differences', () => {
    const evidenceA = makeEvidence({ failingTests: ['test ran in 100ms'] })
    const evidenceB = makeEvidence({ failingTests: ['test ran in 200ms'] })
    expect(computeFailureFingerprint(evidenceA)).toBe(computeFailureFingerprint(evidenceB))
  })

  it('differs for different substantive failures', () => {
    const evidenceA = makeEvidence({ failedCriteria: ['wrong output format'] })
    const evidenceB = makeEvidence({ failedCriteria: ['missing type annotation'] })
    expect(computeFailureFingerprint(evidenceA)).not.toBe(computeFailureFingerprint(evidenceB))
  })

  it('produces empty fingerprint for empty evidence', () => {
    const fingerprint = computeFailureFingerprint(makeEvidence())
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/)
  })
})

// ---------------------------------------------------------------------------
// isSameFailure
// ---------------------------------------------------------------------------

describe('isSameFailure', () => {
  it('returns true for identical fingerprints', () => {
    expect(isSameFailure('abc123', 'abc123')).toBe(true)
  })

  it('returns false for different fingerprints', () => {
    expect(isSameFailure('abc123', 'def456')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// countFailures and classifyProgress
// ---------------------------------------------------------------------------

describe('countFailures', () => {
  it('counts all failure items across categories', () => {
    const evidence = makeEvidence({
      failedCriteria: ['a', 'b'],
      failingTests: ['t1'],
      typeErrors: ['e1', 'e2', 'e3'],
      buildErrors: ['b1'],
    })
    expect(countFailures(evidence)).toBe(7)
  })

  it('returns zero for empty evidence', () => {
    expect(countFailures(makeEvidence())).toBe(0)
  })
})

describe('classifyProgress', () => {
  it('returns none for the first failure', () => {
    const result = classifyProgress(undefined, makeEvidence({ failedCriteria: ['a'] }))
    expect(result).toBe('none')
  })

  it('returns none for the same substantive failure', () => {
    const prior = makeEvidence({ failedCriteria: ['criterion A'] })
    const current = makeEvidence({ failedCriteria: ['criterion A'] })
    expect(classifyProgress(prior, current)).toBe('none')
  })

  it('returns partial for fewer failures', () => {
    const prior = makeEvidence({ failedCriteria: ['a', 'b', 'c'] })
    const current = makeEvidence({ failedCriteria: ['a'] })
    expect(classifyProgress(prior, current)).toBe('partial')
  })

  it('returns partial for same count but different failures', () => {
    const prior = makeEvidence({ failedCriteria: ['a'] })
    const current = makeEvidence({ failedCriteria: ['b'] })
    expect(classifyProgress(prior, current)).toBe('partial')
  })

  it('returns regression for more failures', () => {
    const prior = makeEvidence({ failedCriteria: ['a'] })
    const current = makeEvidence({ failedCriteria: ['a', 'b', 'c'] })
    expect(classifyProgress(prior, current)).toBe('regression')
  })
})

// ---------------------------------------------------------------------------
// decideEscalation
// ---------------------------------------------------------------------------

describe('decideEscalation', () => {
  it('stops on empty stages', () => {
    expect(decideEscalation([])).toEqual({ kind: 'stop' })
  })

  it('stops when last stage passed', () => {
    const stages = [makeStage({ model: 'flash', verified: true })]
    expect(decideEscalation(stages)).toEqual({ kind: 'stop' })
  })

  it('allows flash repair after first flash failure', () => {
    const stages = [makeStage({
      model: 'flash',
      verified: false,
      failureFingerprint: 'abc123',
    })]
    expect(decideEscalation(stages)).toEqual({ kind: 'flash-repair' })
  })

  it('escalates to pro when two flash failures share the same fingerprint', () => {
    const stages = [
      makeStage({ model: 'flash', verified: false, failureFingerprint: 'same' }),
      makeStage({ model: 'flash', verified: false, failureFingerprint: 'same' }),
    ]
    expect(decideEscalation(stages)).toEqual({ kind: 'escalate-to-pro' })
  })

  it('allows flash repair when two flash failures have different fingerprints', () => {
    const bounds: LoopBounds = {
      maxFlashAttempts: 1,
      maxFlashRepairs: 2,
      maxProAttempts: 1,
      maxProRepairs: 0,
      maxTotalStages: 5,
    }
    const stages = [
      makeStage({ model: 'flash', verified: false, failureFingerprint: 'aaa' }),
      makeStage({ model: 'flash', verified: false, failureFingerprint: 'bbb' }),
    ]
    expect(decideEscalation(stages, bounds)).toEqual({ kind: 'flash-repair' })
  })

  it('escalates to pro when flash bounds are exhausted', () => {
    const bounds: LoopBounds = {
      maxFlashAttempts: 1,
      maxFlashRepairs: 1,
      maxProAttempts: 1,
      maxProRepairs: 0,
      maxTotalStages: 4,
    }
    const stages = [
      makeStage({ model: 'flash', verified: false, failureFingerprint: 'aaa' }),
      makeStage({ model: 'flash', verified: false, failureFingerprint: 'bbb' }),
    ]
    expect(decideEscalation(stages, bounds)).toEqual({ kind: 'escalate-to-pro' })
  })

  it('stops after pro failure', () => {
    const stages = [
      makeStage({ model: 'flash', verified: false, failureFingerprint: 'aaa' }),
      makeStage({ model: 'pro', verified: false, failureFingerprint: 'bbb' }),
    ]
    expect(decideEscalation(stages)).toEqual({ kind: 'stop' })
  })

  it('stops at hard stage limit', () => {
    const bounds: LoopBounds = {
      maxFlashAttempts: 1,
      maxFlashRepairs: 1,
      maxProAttempts: 1,
      maxProRepairs: 1,
      maxTotalStages: 2,
    }
    const stages = [
      makeStage({ model: 'flash', verified: false, failureFingerprint: 'aaa' }),
      makeStage({ model: 'flash', verified: false, failureFingerprint: 'bbb' }),
    ]
    expect(decideEscalation(stages, bounds)).toEqual({ kind: 'stop' })
  })
})

// ---------------------------------------------------------------------------
// detectLoopViolation
// ---------------------------------------------------------------------------

describe('detectLoopViolation', () => {
  it('returns undefined for valid trajectories', () => {
    const stages = [
      makeStage({ model: 'flash', verified: false }),
      makeStage({ model: 'pro', verified: true }),
    ]
    expect(detectLoopViolation(stages)).toBeUndefined()
  })

  it('detects total stage violation', () => {
    const bounds: LoopBounds = {
      maxFlashAttempts: 1,
      maxFlashRepairs: 0,
      maxProAttempts: 1,
      maxProRepairs: 0,
      maxTotalStages: 2,
    }
    const stages = [
      makeStage({ model: 'flash', verified: false }),
      makeStage({ model: 'flash', verified: false }),
      makeStage({ model: 'pro', verified: false }),
    ]
    expect(detectLoopViolation(stages, bounds)).toContain('total stages')
  })

  it('detects flash stage violation', () => {
    const bounds: LoopBounds = {
      maxFlashAttempts: 1,
      maxFlashRepairs: 0,
      maxProAttempts: 1,
      maxProRepairs: 0,
      maxTotalStages: 5,
    }
    const stages = [
      makeStage({ model: 'flash', verified: false }),
      makeStage({ model: 'flash', verified: false }),
    ]
    expect(detectLoopViolation(stages, bounds)).toContain('flash stages')
  })

  it('detects pro stage violation', () => {
    const bounds: LoopBounds = {
      maxFlashAttempts: 1,
      maxFlashRepairs: 0,
      maxProAttempts: 1,
      maxProRepairs: 0,
      maxTotalStages: 5,
    }
    const stages = [
      makeStage({ model: 'flash', verified: false }),
      makeStage({ model: 'pro', verified: false }),
      makeStage({ model: 'pro', verified: false }),
    ]
    expect(detectLoopViolation(stages, bounds)).toContain('pro stages')
  })
})

// ---------------------------------------------------------------------------
// constructFailurePackage
// ---------------------------------------------------------------------------

describe('constructFailurePackage', () => {
  it('constructs a complete failure package with fingerprint and progress', () => {
    const failurePackage = constructFailurePackage({
      taskId: 'task-1',
      routingDecisionId: 'rd-1',
      originalGoal: 'Implement debounce',
      model: 'deepseek-v4-flash',
      changedFiles: ['debounce.ts'],
      patchSummary: 'Added debounce function',
      verification: makeEvidence({ failedCriteria: ['test failed'] }),
      checkpoints: { taskStart: 'cp-0', afterFlash: 'cp-1' },
    })
    expect(failurePackage.taskId).toBe('task-1')
    expect(failurePackage.attempt.model).toBe('deepseek-v4-flash')
    expect(failurePackage.attempt.changedFiles).toEqual(['debounce.ts'])
    expect(failurePackage.attempt.patchSummary).toBe('Added debounce function')
    expect(failurePackage.failureFingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(failurePackage.progress).toBe('none')
    expect(failurePackage.checkpoints).toEqual({ taskStart: 'cp-0', afterFlash: 'cp-1' })
  })

  it('omits patchSummary when not provided', () => {
    const failurePackage = constructFailurePackage({
      taskId: 'task-1',
      routingDecisionId: 'rd-1',
      originalGoal: 'Implement debounce',
      model: 'deepseek-v4-flash',
      changedFiles: [],
      verification: makeEvidence(),
      checkpoints: { taskStart: 'cp-0', afterFlash: 'cp-1' },
    })
    expect(failurePackage.attempt.patchSummary).toBeUndefined()
  })

  it('classifies progress relative to prior evidence', () => {
    const priorEvidence = makeEvidence({ failedCriteria: ['a', 'b', 'c'] })
    const failurePackage = constructFailurePackage({
      taskId: 'task-1',
      routingDecisionId: 'rd-1',
      originalGoal: 'Implement debounce',
      model: 'deepseek-v4-flash',
      changedFiles: ['debounce.ts'],
      verification: makeEvidence({ failedCriteria: ['a'] }),
      priorEvidence,
      checkpoints: { taskStart: 'cp-0', afterFlash: 'cp-1' },
    })
    expect(failurePackage.progress).toBe('partial')
  })
})

// ---------------------------------------------------------------------------
// constructProRepairPrompt
// ---------------------------------------------------------------------------

describe('constructProRepairPrompt', () => {
  it('includes the original goal', () => {
    const failurePackage: FailurePackage = constructFailurePackage({
      taskId: 'task-1',
      routingDecisionId: 'rd-1',
      originalGoal: 'Implement a debounce function',
      model: 'deepseek-v4-flash',
      changedFiles: ['debounce.ts'],
      verification: makeEvidence({ failedCriteria: ['test failed'] }),
      checkpoints: { taskStart: 'cp-0', afterFlash: 'cp-1' },
    })
    const prompt = constructProRepairPrompt(failurePackage)
    expect(prompt).toContain('Implement a debounce function')
  })

  it('includes verification failures', () => {
    const failurePackage = constructFailurePackage({
      taskId: 'task-1',
      routingDecisionId: 'rd-1',
      originalGoal: 'Implement debounce',
      model: 'deepseek-v4-flash',
      changedFiles: ['debounce.ts'],
      verification: makeEvidence({
        failedCriteria: ['must handle leading edge'],
        failingTests: ['debounce.test.ts > handles leading edge'],
        typeErrors: ['debounce.ts:10:5 Type error'],
      }),
      checkpoints: { taskStart: 'cp-0', afterFlash: 'cp-1' },
    })
    const prompt = constructProRepairPrompt(failurePackage)
    expect(prompt).toContain('must handle leading edge')
    expect(prompt).toContain('debounce.test.ts > handles leading edge')
    expect(prompt).toContain('debounce.ts:10:5 Type error')
  })

  it('instructs Pro to choose REPAIR_EXISTING or ROLLBACK_AND_REDO', () => {
    const failurePackage = constructFailurePackage({
      taskId: 'task-1',
      routingDecisionId: 'rd-1',
      originalGoal: 'Implement debounce',
      model: 'deepseek-v4-flash',
      changedFiles: [],
      verification: makeEvidence({ failedCriteria: ['fail'] }),
      checkpoints: { taskStart: 'cp-0', afterFlash: 'cp-1' },
    })
    const prompt = constructProRepairPrompt(failurePackage)
    expect(prompt).toContain('REPAIR_EXISTING')
    expect(prompt).toContain('ROLLBACK_AND_REDO')
    expect(prompt).toContain('first line')
  })

  it('includes failure fingerprint and progress', () => {
    const failurePackage = constructFailurePackage({
      taskId: 'task-1',
      routingDecisionId: 'rd-1',
      originalGoal: 'Implement debounce',
      model: 'deepseek-v4-flash',
      changedFiles: [],
      verification: makeEvidence({ failedCriteria: ['fail'] }),
      checkpoints: { taskStart: 'cp-0', afterFlash: 'cp-1' },
    })
    const prompt = constructProRepairPrompt(failurePackage)
    expect(prompt).toContain(failurePackage.failureFingerprint)
    expect(prompt).toContain(failurePackage.progress)
  })
})

// ---------------------------------------------------------------------------
// parseTakeoverDecision
// ---------------------------------------------------------------------------

describe('parseTakeoverDecision', () => {
  it('parses REPAIR_EXISTING', () => {
    expect(parseTakeoverDecision('REPAIR_EXISTING\nI will fix the existing code.')).toBe('REPAIR_EXISTING')
  })

  it('parses ROLLBACK_AND_REDO', () => {
    expect(parseTakeoverDecision('ROLLBACK_AND_REDO\nStarting fresh.')).toBe('ROLLBACK_AND_REDO')
  })

  it('parses case-insensitively', () => {
    expect(parseTakeoverDecision('repair_existing\nFixing.')).toBe('REPAIR_EXISTING')
  })

  it('parses REPAIR when ROLLBACK is absent', () => {
    expect(parseTakeoverDecision('REPAIR\nFixing the code.')).toBe('REPAIR_EXISTING')
  })

  it('parses ROLLBACK when REPAIR is absent', () => {
    expect(parseTakeoverDecision('ROLLBACK\nStarting over.')).toBe('ROLLBACK_AND_REDO')
  })

  it('returns undefined for no valid decision', () => {
    expect(parseTakeoverDecision('I will fix the code.')).toBeUndefined()
  })

  it('returns undefined for empty output', () => {
    expect(parseTakeoverDecision('')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// computePolicyMetrics
// ---------------------------------------------------------------------------

describe('computePolicyMetrics', () => {
  it('computes flash-only metrics', () => {
    const trajectories = [
      makeTrajectory({
        policy: 'flash-only',
        verified: true,
        stages: [makeStage({ model: 'flash', verified: true, costUsd: 0.001 })],
      }),
      makeTrajectory({
        taskId: 'task-2',
        policy: 'flash-only',
        verified: false,
        stages: [makeStage({ model: 'flash', verified: false, costUsd: 0.002 })],
      }),
    ]
    const metrics = computePolicyMetrics('flash-only', trajectories)
    expect(metrics.tasks).toBe(2)
    expect(metrics.verifiedTasks).toBe(1)
    expect(metrics.verifiedRate).toBe(0.5)
    expect(metrics.proCalls).toBe(0)
    expect(metrics.proUtilization).toBe(0)
    expect(metrics.escalations).toBe(0)
    expect(metrics.proRescueRate).toBe(0)
  })

  it('computes pro rescue rate for escalated tasks', () => {
    const trajectories = [
      makeTrajectory({
        taskId: 'task-1',
        policy: 'flash-fail-pro-repair',
        verified: true,
        escalated: true,
        failurePackage: constructFailurePackage({
          taskId: 'task-1',
          routingDecisionId: 'rd-1',
          originalGoal: 'goal',
          model: 'deepseek-v4-flash',
          changedFiles: [],
          verification: makeEvidence({ failedCriteria: ['fail'] }),
          checkpoints: { taskStart: 'cp-0', afterFlash: 'cp-1' },
        }),
        stages: [
          makeStage({ model: 'flash', verified: false, costUsd: 0.001 }),
          makeStage({ model: 'pro', verified: true, costUsd: 0.01, takeoverDecision: 'REPAIR_EXISTING' }),
        ],
      }),
      makeTrajectory({
        taskId: 'task-2',
        policy: 'flash-fail-pro-repair',
        verified: false,
        escalated: true,
        failurePackage: constructFailurePackage({
          taskId: 'task-2',
          routingDecisionId: 'rd-2',
          originalGoal: 'goal',
          model: 'deepseek-v4-flash',
          changedFiles: [],
          verification: makeEvidence({ failedCriteria: ['fail'] }),
          checkpoints: { taskStart: 'cp-0', afterFlash: 'cp-1' },
        }),
        stages: [
          makeStage({ model: 'flash', verified: false, costUsd: 0.001 }),
          makeStage({ model: 'pro', verified: false, costUsd: 0.01, takeoverDecision: 'ROLLBACK_AND_REDO' }),
        ],
      }),
    ]
    const metrics = computePolicyMetrics('flash-fail-pro-repair', trajectories)
    expect(metrics.escalations).toBe(2)
    expect(metrics.successfulRescues).toBe(1)
    expect(metrics.proRescueRate).toBe(0.5)
    expect(metrics.auditableEscalations).toBe(2)
    expect(metrics.auditableEscalationRate).toBe(1)
    expect(metrics.repairExistingChoices).toBe(1)
    expect(metrics.rollbackRedoChoices).toBe(1)
    expect(metrics.loopViolations).toBe(0)
  })

  it('detects same-failure repetitions', () => {
    const trajectories = [
      makeTrajectory({
        taskId: 'task-1',
        policy: 'flash-repair-then-pro',
        verified: false,
        stages: [
          makeStage({ model: 'flash', verified: false, failureFingerprint: 'same' }),
          makeStage({ model: 'flash', verified: false, failureFingerprint: 'same' }),
          makeStage({ model: 'pro', verified: false }),
        ],
      }),
    ]
    const metrics = computePolicyMetrics('flash-repair-then-pro', trajectories)
    expect(metrics.sameFailureDetections).toBe(1)
  })

  it('detects loop violations', () => {
    const bounds: LoopBounds = {
      maxFlashAttempts: 1,
      maxFlashRepairs: 0,
      maxProAttempts: 1,
      maxProRepairs: 0,
      maxTotalStages: 2,
    }
    const trajectories = [
      makeTrajectory({
        taskId: 'task-1',
        policy: 'flash-only',
        stages: [
          makeStage({ model: 'flash', verified: false }),
          makeStage({ model: 'flash', verified: false }),
          makeStage({ model: 'pro', verified: false }),
        ],
      }),
    ]
    const metrics = computePolicyMetrics('flash-only', trajectories, bounds)
    expect(metrics.loopViolations).toBe(1)
  })

  it('computes cost per verified task', () => {
    const trajectories = [
      makeTrajectory({
        policy: 'flash-only',
        verified: true,
        stages: [makeStage({ model: 'flash', verified: true, costUsd: 0.003 })],
      }),
      makeTrajectory({
        taskId: 'task-2',
        policy: 'flash-only',
        verified: true,
        stages: [makeStage({ model: 'flash', verified: true, costUsd: 0.001 })],
      }),
    ]
    const metrics = computePolicyMetrics('flash-only', trajectories)
    expect(metrics.totalCost).toBeCloseTo(0.004, 6)
    expect(metrics.costPerVerifiedTask).toBeCloseTo(0.002, 6)
  })

  it('handles zero verified tasks', () => {
    const trajectories = [
      makeTrajectory({
        policy: 'flash-only',
        verified: false,
        stages: [makeStage({ model: 'flash', verified: false, costUsd: 0.001 })],
      }),
    ]
    const metrics = computePolicyMetrics('flash-only', trajectories)
    expect(metrics.verifiedTasks).toBe(0)
    expect(metrics.costPerVerifiedTask).toBe(Infinity)
  })
})

// ---------------------------------------------------------------------------
// semanticFailureOverlap
// ---------------------------------------------------------------------------

describe('semanticFailureOverlap', () => {
  it('returns 1 for identical evidence', () => {
    const evidence = makeEvidence({ failedCriteria: ['test a', 'test b'] })
    expect(semanticFailureOverlap(evidence, evidence)).toBe(1)
  })

  it('returns 0 for completely disjoint evidence', () => {
    const prior = makeEvidence({ failedCriteria: ['alpha'] })
    const current = makeEvidence({ failedCriteria: ['beta'] })
    expect(semanticFailureOverlap(prior, current)).toBe(0)
  })

  it('returns 0.5 when half of current failures are prior failures', () => {
    const prior = makeEvidence({ failedCriteria: ['a', 'b'] })
    const current = makeEvidence({ failedCriteria: ['a', 'c'] })
    expect(semanticFailureOverlap(prior, current)).toBe(0.5)
  })

  it('returns 0 for empty current evidence', () => {
    const prior = makeEvidence({ failedCriteria: ['a'] })
    expect(semanticFailureOverlap(prior, makeEvidence())).toBe(0)
  })

  it('normalizes text before comparing', () => {
    const prior = makeEvidence({ typeErrors: ['/home/user/src/index.ts:42:13 Type error'] })
    const current = makeEvidence({ typeErrors: ['/tmp/worker/src/index.ts:42:13 Type error'] })
    expect(semanticFailureOverlap(prior, current)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// isSemanticSameFailure
// ---------------------------------------------------------------------------

describe('isSemanticSameFailure', () => {
  it('returns true for identical fingerprints', () => {
    const evidence = makeEvidence({ failedCriteria: ['a'] })
    expect(isSemanticSameFailure(evidence, evidence)).toBe(true)
  })

  it('returns true when overlap exceeds threshold', () => {
    const prior = makeEvidence({ failedCriteria: ['a', 'b', 'c', 'd'] })
    const current = makeEvidence({ failedCriteria: ['a', 'b', 'c', 'e'] })
    expect(isSemanticSameFailure(prior, current, 0.7)).toBe(true)
  })

  it('returns false when overlap is below threshold', () => {
    const prior = makeEvidence({ failedCriteria: ['a', 'b', 'c', 'd'] })
    const current = makeEvidence({ failedCriteria: ['e', 'f', 'g', 'h'] })
    expect(isSemanticSameFailure(prior, current, 0.8)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Ablation prompts
// ---------------------------------------------------------------------------

describe('constructWorkspaceOnlyPrompt', () => {
  it('includes the original goal', () => {
    const prompt = constructWorkspaceOnlyPrompt('Implement debounce')
    expect(prompt).toContain('Implement debounce')
  })

  it('does not include structured failure evidence', () => {
    const prompt = constructWorkspaceOnlyPrompt('Implement debounce')
    expect(prompt).not.toContain('Failed acceptance criteria')
    expect(prompt).not.toContain('Failing tests')
    expect(prompt).not.toContain('Type errors')
  })

  it('instructs Pro to choose REPAIR or ROLLBACK', () => {
    const prompt = constructWorkspaceOnlyPrompt('Implement debounce')
    expect(prompt).toContain('REPAIR_EXISTING')
    expect(prompt).toContain('ROLLBACK_AND_REDO')
  })
})

describe('constructEvidenceOnlyPrompt', () => {
  it('states the workspace was reset', () => {
    const failurePackage = constructFailurePackage({
      taskId: 'task-1',
      routingDecisionId: 'rd-1',
      originalGoal: 'Implement debounce',
      model: 'deepseek-v4-flash',
      changedFiles: ['debounce.ts'],
      verification: makeEvidence({ failedCriteria: ['test failed'] }),
      checkpoints: { taskStart: 'cp-0', afterFlash: 'cp-1' },
    })
    const prompt = constructEvidenceOnlyPrompt(failurePackage)
    expect(prompt).toContain('reset')
    expect(prompt).toContain('gone')
  })

  it('includes the failure evidence', () => {
    const failurePackage = constructFailurePackage({
      taskId: 'task-1',
      routingDecisionId: 'rd-1',
      originalGoal: 'Implement debounce',
      model: 'deepseek-v4-flash',
      changedFiles: ['debounce.ts'],
      verification: makeEvidence({ failedCriteria: ['must handle leading edge'] }),
      checkpoints: { taskStart: 'cp-0', afterFlash: 'cp-1' },
    })
    const prompt = constructEvidenceOnlyPrompt(failurePackage)
    expect(prompt).toContain('must handle leading edge')
  })
})

// ---------------------------------------------------------------------------
// Rollback tracking in metrics
// ---------------------------------------------------------------------------

describe('rollback tracking', () => {
  it('counts rollback occurrences', () => {
    const trajectories = [
      makeTrajectory({
        taskId: 'task-1',
        policy: 'flash-fail-pro-repair',
        verified: true,
        escalated: true,
        stages: [
          makeStage({ model: 'flash', verified: false }),
          makeStage({ model: 'pro', verified: true, rollbackOccurred: true }),
        ],
      }),
      makeTrajectory({
        taskId: 'task-2',
        policy: 'flash-fail-pro-repair',
        verified: false,
        escalated: true,
        stages: [
          makeStage({ model: 'flash', verified: false }),
          makeStage({ model: 'pro', verified: false, rollbackOccurred: false }),
        ],
      }),
    ]
    const metrics = computePolicyMetrics('flash-fail-pro-repair', trajectories)
    expect(metrics.rollbackOccurred).toBe(1)
    expect(metrics.rollbackRate).toBe(0.5)
  })

  it('reports zero rollback when none occurred', () => {
    const trajectories = [
      makeTrajectory({
        policy: 'flash-fail-pro-repair',
        verified: true,
        escalated: true,
        stages: [
          makeStage({ model: 'flash', verified: false }),
          makeStage({ model: 'pro', verified: true, rollbackOccurred: false }),
        ],
      }),
    ]
    const metrics = computePolicyMetrics('flash-fail-pro-repair', trajectories)
    expect(metrics.rollbackOccurred).toBe(0)
    expect(metrics.rollbackRate).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// computeRepairAdvantage
// ---------------------------------------------------------------------------

describe('computeRepairAdvantage', () => {
  it('computes positive advantage when repair is better', () => {
    const repairMetrics = computePolicyMetrics('flash-fail-pro-repair', [
      makeTrajectory({
        taskId: 'task-1',
        policy: 'flash-fail-pro-repair',
        verified: true,
        escalated: true,
        stages: [
          makeStage({ model: 'flash', verified: false, costUsd: 0.001 }),
          makeStage({ model: 'pro', verified: true, costUsd: 0.005 }),
        ],
      }),
    ])
    const freshMetrics = computePolicyMetrics('flash-fail-pro-fresh', [
      makeTrajectory({
        taskId: 'task-1',
        policy: 'flash-fail-pro-fresh',
        verified: false,
        escalated: true,
        stages: [
          makeStage({ model: 'flash', verified: false, costUsd: 0.001 }),
          makeStage({ model: 'pro', verified: false, costUsd: 0.01 }),
        ],
      }),
    ])
    const advantage = computeRepairAdvantage(repairMetrics, freshMetrics)
    expect(advantage.verifiedSuccessAdvantage).toBeGreaterThan(0)
    expect(advantage.rescueRateAdvantage).toBeGreaterThan(0)
  })

  it('computes negative advantage when fresh is better', () => {
    const repairMetrics = computePolicyMetrics('flash-fail-pro-repair', [
      makeTrajectory({
        taskId: 'task-1',
        policy: 'flash-fail-pro-repair',
        verified: false,
        escalated: true,
        stages: [
          makeStage({ model: 'flash', verified: false, costUsd: 0.001 }),
          makeStage({ model: 'pro', verified: false, costUsd: 0.01 }),
        ],
      }),
    ])
    const freshMetrics = computePolicyMetrics('flash-fail-pro-fresh', [
      makeTrajectory({
        taskId: 'task-1',
        policy: 'flash-fail-pro-fresh',
        verified: true,
        escalated: true,
        stages: [
          makeStage({ model: 'flash', verified: false, costUsd: 0.001 }),
          makeStage({ model: 'pro', verified: true, costUsd: 0.005 }),
        ],
      }),
    ])
    const advantage = computeRepairAdvantage(repairMetrics, freshMetrics)
    expect(advantage.verifiedSuccessAdvantage).toBeLessThan(0)
    expect(advantage.rescueRateAdvantage).toBeLessThan(0)
  })

  it('computes economic advantage when repair is cheaper per verified task', () => {
    const repairMetrics = computePolicyMetrics('flash-fail-pro-repair', [
      makeTrajectory({
        taskId: 'task-1',
        policy: 'flash-fail-pro-repair',
        verified: true,
        escalated: true,
        stages: [
          makeStage({ model: 'flash', verified: false, costUsd: 0.001 }),
          makeStage({ model: 'pro', verified: true, costUsd: 0.003 }),
        ],
      }),
    ])
    const freshMetrics = computePolicyMetrics('flash-fail-pro-fresh', [
      makeTrajectory({
        taskId: 'task-1',
        policy: 'flash-fail-pro-fresh',
        verified: true,
        escalated: true,
        stages: [
          makeStage({ model: 'flash', verified: false, costUsd: 0.001 }),
          makeStage({ model: 'pro', verified: true, costUsd: 0.01 }),
        ],
      }),
    ])
    const advantage = computeRepairAdvantage(repairMetrics, freshMetrics)
    expect(advantage.economicAdvantage).toBeGreaterThan(0)
  })

  it('reports comparable tasks as the minimum escalation count', () => {
    const repairMetrics = computePolicyMetrics('flash-fail-pro-repair', [
      makeTrajectory({
        taskId: 'task-1',
        policy: 'flash-fail-pro-repair',
        verified: true,
        escalated: true,
        stages: [makeStage({ model: 'flash', verified: false }), makeStage({ model: 'pro', verified: true })],
      }),
      makeTrajectory({
        taskId: 'task-2',
        policy: 'flash-fail-pro-repair',
        verified: true,
        escalated: true,
        stages: [makeStage({ model: 'flash', verified: false }), makeStage({ model: 'pro', verified: true })],
      }),
    ])
    const freshMetrics = computePolicyMetrics('flash-fail-pro-fresh', [
      makeTrajectory({
        taskId: 'task-1',
        policy: 'flash-fail-pro-fresh',
        verified: true,
        escalated: true,
        stages: [makeStage({ model: 'flash', verified: false }), makeStage({ model: 'pro', verified: true })],
      }),
    ])
    const advantage = computeRepairAdvantage(repairMetrics, freshMetrics)
    expect(advantage.comparableTasks).toBe(1)
  })
})
