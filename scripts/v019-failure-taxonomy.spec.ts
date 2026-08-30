/**
 * Deterministic fixtures for F1-F18 failure taxonomy precedence.
 *
 * Each fixture constructs a minimal TaskTrajectory that exercises one
 * classification path. The tests verify that the classifier produces
 * the expected category and that precedence ordering is correct —
 * specifically that more informative categories are checked before
 * less informative ones.
 *
 * @module v019-failure-taxonomy.spec
 */

import { describe, expect, it } from 'vitest'
import { classifyFailure } from './v019-failure-taxonomy.ts'
import type { TaskTrajectory, AttemptTrajectory } from './v019-trajectory-collector.ts'
import type { RepoMetadata } from './v019-repo-checkout.ts'

const repo: RepoMetadata = {
  name: 'repo',
  url: 'https://github.com/test/repo',
  baseCommit: 'abc123',
  size: 'small',
  loc: 100,
  fileCount: 10,
  packageCount: 1,
  testCount: 5,
}

function makeAttempt(over: Partial<AttemptTrajectory>): AttemptTrajectory {
  return {
    attempt: 1,
    model: 'deepseek-v4-flash',
    routingDecisionId: 'rd-1',
    verified: false,
    diagnosticPass: false,
    holdoutPass: undefined,
    failureFingerprint: undefined,
    progress: undefined,
    failedCriteria: [],
    failingTests: [],
    typeErrors: [],
    buildErrors: [],
    usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 0, totalTokens: 150, cacheReadTokens: 0, cacheMissTokens: 0 },
    costUsd: 0.001,
    latencyMs: 1000,
    repairAction: 'flash-repair',
    repairReason: undefined,
    changedFiles: [],
    toolCallCount: 1,
    filesInspected: [],
    terminalOutcome: 'attempts-exhausted',
    ...over,
  }
}

function makeTrajectory(over: Partial<TaskTrajectory> & { attempts: readonly AttemptTrajectory[] }): TaskTrajectory {
  return {
    taskId: 'task-1',
    taskManifestHash: 'hash',
    experimentId: 'exp-1',
    benchmarkEligible: true,
    repository: repo,
    category: 'bug-fix',
    taskDescription: 'test task',
    baseCommit: 'abc123',
    referenceFixCommit: undefined,
    taskState: 'COMPLETED',
    controlPlaneStatus: 'PASS',
    modelCapabilityStatus: 'FAIL',
    finalVerified: false,
    holdoutPass: undefined,
    verificationStrength: 'diagnostic',
    flashAttempts: over.attempts.filter(a => a.model === 'deepseek-v4-flash').length,
    proAttempts: over.attempts.filter(a => a.model === 'deepseek-v4-pro').length,
    escalatedToPro: over.attempts.some(a => a.model === 'deepseek-v4-pro'),
    totalCostUsd: 0.01,
    totalLatencyMs: 5000,
    totalOutputTokens: 200,
    totalCacheReadTokens: 0,
    totalCacheMissTokens: 0,
    changedFiles: [],
    referenceFixFiles: [],
    referenceFixFilesInspected: [],
    referenceFixFilesModified: [],
    rollbackUsed: false,
    aborted: false,
    abortReason: undefined,
    terminalOutcome: 'attempts-exhausted',
    failureCategory: undefined,
    timestamp: new Date().toISOString(),
    ...over,
  }
}

describe('v019-failure-taxonomy precedence', () => {
  it('returns undefined for verified tasks', () => {
    const t = makeTrajectory({
      finalVerified: true,
      attempts: [makeAttempt({ verified: true })],
    })
    expect(classifyFailure(t)).toBeUndefined()
  })

  it('classifies F6-build-environment when controlPlaneStatus is NOT_EVALUATED', () => {
    const t = makeTrajectory({
      controlPlaneStatus: 'NOT_EVALUATED',
      modelCapabilityStatus: 'NOT_EVALUATED',
      taskState: 'FAILED_INFRA',
      abortReason: 'checkout failed',
      attempts: [],
    })
    const result = classifyFailure(t)
    expect(result?.category).toBe('F6-build-environment')
  })

  it('classifies F14-provider-failure when aborted with reason', () => {
    const t = makeTrajectory({
      controlPlaneStatus: 'FAIL',
      aborted: true,
      abortReason: 'provider timeout',
      attempts: [makeAttempt({})],
    })
    const result = classifyFailure(t)
    expect(result?.category).toBe('F14-provider-failure')
  })

  it('classifies F13-rollback when control plane FAIL without abort', () => {
    const t = makeTrajectory({
      controlPlaneStatus: 'FAIL',
      aborted: false,
      attempts: [makeAttempt({})],
    })
    const result = classifyFailure(t)
    expect(result?.category).toBe('F13-rollback')
  })

  it('classifies F18-holdout-edge-case when diagnostic PASS but holdout FAIL', () => {
    const t = makeTrajectory({
      attempts: [makeAttempt({ diagnosticPass: true, holdoutPass: false })],
    })
    const result = classifyFailure(t)
    expect(result?.category).toBe('F18-holdout-edge-case')
  })

  it('classifies F11-budget-exhaustion on budget-stop', () => {
    const t = makeTrajectory({
      terminalOutcome: 'budget-stop',
      attempts: [makeAttempt({ terminalOutcome: 'budget-stop' })],
    })
    const result = classifyFailure(t)
    expect(result?.category).toBe('F11-budget-exhaustion')
  })

  it('classifies F9-premature-escalation when Pro called after only 1 Flash', () => {
    const t = makeTrajectory({
      attempts: [
        makeAttempt({ attempt: 1, model: 'deepseek-v4-flash' }),
        makeAttempt({ attempt: 2, model: 'deepseek-v4-pro' }),
      ],
    })
    const result = classifyFailure(t)
    expect(result?.category).toBe('F9-premature-escalation')
  })

  it('classifies F10-insufficient-escalation when Flash exhausted without Pro', () => {
    const t = makeTrajectory({
      attempts: [
        makeAttempt({ attempt: 1, model: 'deepseek-v4-flash' }),
        makeAttempt({ attempt: 2, model: 'deepseek-v4-flash' }),
        makeAttempt({ attempt: 3, model: 'deepseek-v4-flash' }),
      ],
    })
    const result = classifyFailure(t)
    expect(result?.category).toBe('F10-insufficient-escalation')
  })

  it('F8 takes precedence over F17 when same fingerprint repeats with changed files', () => {
    const t = makeTrajectory({
      changedFiles: ['src/a.ts', 'src/b.ts'],
      attempts: [
        makeAttempt({ attempt: 1, failureFingerprint: 'fp-xyz', changedFiles: ['src/a.ts'] }),
        makeAttempt({ attempt: 2, failureFingerprint: 'fp-xyz', changedFiles: ['src/b.ts'] }),
      ],
    })
    const result = classifyFailure(t)
    expect(result?.category).toBe('F8-repair-evidence')
  })

  it('classifies F1-model-reasoning when all failed and no changed files', () => {
    const t = makeTrajectory({
      changedFiles: [],
      attempts: [
        makeAttempt({ attempt: 1, changedFiles: [] }),
        makeAttempt({ attempt: 2, changedFiles: [] }),
      ],
    })
    const result = classifyFailure(t)
    expect(result?.category).toBe('F1-model-reasoning')
  })

  it('classifies F17-cross-file-consistency when changes made but still fails', () => {
    const t = makeTrajectory({
      changedFiles: ['src/a.ts'],
      attempts: [
        makeAttempt({ attempt: 1, failureFingerprint: 'fp-1', changedFiles: ['src/a.ts'] }),
        makeAttempt({ attempt: 2, failureFingerprint: 'fp-2', changedFiles: ['src/a.ts'] }),
      ],
    })
    const result = classifyFailure(t)
    expect(result?.category).toBe('F17-cross-file-consistency')
  })

  it('classifies F1-model-reasoning as default fallback', () => {
    const t = makeTrajectory({
      attempts: [
        makeAttempt({ attempt: 1, model: 'deepseek-v4-flash', failureFingerprint: 'fp-1' }),
        makeAttempt({ attempt: 2, model: 'deepseek-v4-flash', failureFingerprint: 'fp-2' }),
      ],
    })
    const result = classifyFailure(t)
    expect(result?.category).toBe('F1-model-reasoning')
  })

  it('classifies F12-timeout-latency on timeout terminal outcome', () => {
    const t = makeTrajectory({
      terminalOutcome: 'timeout',
      abortReason: 'task timed out',
      attempts: [makeAttempt({ terminalOutcome: 'timeout' })],
    })
    const result = classifyFailure(t)
    expect(result?.category).toBe('F12-timeout-latency')
  })

  it('does not auto-classify F3-wrong-file (manual-only: reference patches are forensic, not grading authority)', () => {
    const t = makeTrajectory({
      changedFiles: ['src/unrelated.ts'],
      referenceFixFiles: ['src/fix.ts'],
      referenceFixFilesInspected: ['src/fix.ts'],
      referenceFixFilesModified: [],
      attempts: [
        makeAttempt({ attempt: 1, failureFingerprint: 'fp-1', changedFiles: ['src/unrelated.ts'] }),
        makeAttempt({ attempt: 2, failureFingerprint: 'fp-2', changedFiles: ['src/unrelated.ts'] }),
      ],
    })
    const result = classifyFailure(t)
    expect(result?.category).not.toBe('F3-wrong-file')
  })

  it('does not auto-classify F2-repo-context (manual-only: no inspection is a proxy, not proof)', () => {
    const t = makeTrajectory({
      changedFiles: [],
      referenceFixFiles: ['src/fix.ts'],
      referenceFixFilesInspected: [],
      referenceFixFilesModified: [],
      attempts: [
        makeAttempt({ attempt: 1, failureFingerprint: 'fp-1', changedFiles: [] }),
        makeAttempt({ attempt: 2, failureFingerprint: 'fp-2', changedFiles: [] }),
      ],
    })
    const result = classifyFailure(t)
    expect(result?.category).not.toBe('F2-repo-context')
  })

  it('classifies F7-dependency when error evidence mentions module resolution errors', () => {
    const t = makeTrajectory({
      changedFiles: ['src/a.ts'],
      attempts: [
        makeAttempt({
          attempt: 1,
          failureFingerprint: 'fp-1',
          failedCriteria: ['Cannot find module ./utils'],
          typeErrors: [],
          buildErrors: [],
        }),
      ],
    })
    const result = classifyFailure(t)
    expect(result?.category).toBe('F7-dependency')
  })
})
