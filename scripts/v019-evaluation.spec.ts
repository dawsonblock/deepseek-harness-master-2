import { describe, it, expect } from 'vitest'

import {
  EXPERIMENT_ID,
  FROZEN_V018_TAG,
  buildExperimentManifest,
} from './v019-experiment-identity.ts'
import {
  type TaskManifest,
  FROZEN_V018_LIMITS,
  buildTaskManifest,
  validateTaskManifest,
} from './v019-task-manifest.ts'
import { computeMetrics } from './v019-metrics.ts'
import {
  classifyFailure,
  classifyAllFailures,
  failureCategorySummary,
} from './v019-failure-taxonomy.ts'
import type { TaskTrajectory } from './v019-trajectory-collector.ts'

describe('v019-experiment-identity', () => {
  it('exports the correct experiment ID', () => {
    expect(EXPERIMENT_ID).toBe('v019-synthetic-multirepo-validation-v4')
  })

  it('freezes the v0.18.0 tag', () => {
    expect(FROZEN_V018_TAG).toBe('v0.18.0')
  })

  it('builds a manifest with a deterministic hash', () => {
    const m1 = buildExperimentManifest({
      repairControllerVersion: '0.18.0',
      repairRuntimeVersion: '0.18.0',
      eventSchemaVersion: 0,
      pricingVersion: '2026-08-25',
      sandboxPolicyVersion: 'v1',
      sandboxQualificationId: 'test-sandbox-id',
      taskCorpusVersion: 'v1',
      taskCount: 75,
      repositoryCount: 10,
      benchmarkEligible: true, skipCleanSourceCheck: true,
      repairStrategy: 'transactional',
      sandboxBackend: { runner: 'test', runnerPath: '/test', runnerVersion: '1.0', enforcement: 'full', networkDenied: true },
      snapshotAlgorithm: 'sha256-tree-v2',
      snapshotExclusions: 'verifier-snapshot-exclusions-v1',
      qualificationSemanticHash: 'test-semantic-hash',
      qualificationArtifactHash: 'test-hash',
      corpusManifestHash: 'test-corpus-hash',
    })
    const m2 = buildExperimentManifest({
      repairControllerVersion: '0.18.0',
      repairRuntimeVersion: '0.18.0',
      eventSchemaVersion: 0,
      pricingVersion: '2026-08-25',
      sandboxPolicyVersion: 'v1',
      sandboxQualificationId: 'test-sandbox-id',
      taskCorpusVersion: 'v1',
      taskCount: 75,
      repositoryCount: 10,
      benchmarkEligible: true, skipCleanSourceCheck: true,
      repairStrategy: 'transactional',
      sandboxBackend: { runner: 'test', runnerPath: '/test', runnerVersion: '1.0', enforcement: 'full', networkDenied: true },
      snapshotAlgorithm: 'sha256-tree-v2',
      snapshotExclusions: 'verifier-snapshot-exclusions-v1',
      qualificationSemanticHash: 'test-semantic-hash',
      qualificationArtifactHash: 'test-hash',
      corpusManifestHash: 'test-corpus-hash',
    })
    expect(m1.manifestHash).toBe(m2.manifestHash)
    expect(m1.manifestHash).toHaveLength(64)
  })

  it('manifest hash is independent of qualificationArtifactHash', () => {
    const base = {
      repairControllerVersion: '0.18.0',
      repairRuntimeVersion: '0.18.0',
      eventSchemaVersion: 0,
      pricingVersion: '2026-08-25',
      sandboxPolicyVersion: 'v1',
      sandboxQualificationId: 'test-sandbox-id',
      taskCorpusVersion: 'v1',
      taskCount: 75,
      repositoryCount: 10,
      benchmarkEligible: true, skipCleanSourceCheck: true,
      repairStrategy: 'transactional' as const,
      sandboxBackend: { runner: 'test', runnerPath: '/test', runnerVersion: '1.0', enforcement: 'full', networkDenied: true },
      snapshotAlgorithm: 'sha256-tree-v2',
      snapshotExclusions: 'verifier-snapshot-exclusions-v1',
      qualificationSemanticHash: 'test-semantic-hash',
      corpusManifestHash: 'test-corpus-hash',
    }
    const m1 = buildExperimentManifest({ ...base, qualificationArtifactHash: 'artifact-hash-A' })
    const m2 = buildExperimentManifest({ ...base, qualificationArtifactHash: 'artifact-hash-B' })
    // The artifact hash includes timestamps and environment data; it must
    // not affect experiment identity or checkpoint resume would break on
    // every qualification re-run.
    expect(m1.manifestHash).toBe(m2.manifestHash)
    // The artifact hash is still preserved in the manifest for audit.
    expect(m1.qualificationArtifactHash).toBe('artifact-hash-A')
    expect(m2.qualificationArtifactHash).toBe('artifact-hash-B')
  })

  it('freezes maxFlashAttempts=3, maxProAttempts=2, maxTotalAttempts=5', () => {
    const m = buildExperimentManifest({
      repairControllerVersion: '0.18.0',
      repairRuntimeVersion: '0.18.0',
      eventSchemaVersion: 0,
      pricingVersion: '2026-08-25',
      sandboxPolicyVersion: 'v1',
      sandboxQualificationId: 'test',
      taskCorpusVersion: 'v1',
      taskCount: 5,
      repositoryCount: 1,
      benchmarkEligible: true, skipCleanSourceCheck: true,
      repairStrategy: 'transactional',
      sandboxBackend: { runner: 'test', runnerPath: '/test', runnerVersion: '1.0', enforcement: 'full', networkDenied: true },
      snapshotAlgorithm: 'sha256-tree-v2',
      snapshotExclusions: 'verifier-snapshot-exclusions-v1',
      qualificationSemanticHash: 'test-semantic-hash',
      qualificationArtifactHash: 'test-hash',
      corpusManifestHash: 'test-corpus-hash',
    })
    expect(m.frozenRepairLimits.maxFlashAttempts).toBe(3)
    expect(m.frozenRepairLimits.maxProAttempts).toBe(2)
    expect(m.frozenRepairLimits.maxTotalAttempts).toBe(5)
  })
})

describe('v019-task-manifest', () => {
  it('freezes v0.18 repair limits', () => {
    expect(FROZEN_V018_LIMITS.maxFlashAttempts).toBe(3)
    expect(FROZEN_V018_LIMITS.maxProAttempts).toBe(2)
    expect(FROZEN_V018_LIMITS.maxTotalAttempts).toBe(5)
  })

  it('builds a task manifest with a deterministic hash', () => {
    const base = {
      taskId: 'test-001',
      category: 'bug-fix' as const,
      benchmarkEligible: true, skipCleanSourceCheck: true,
      repository: {
        name: 'test-repo',
        url: 'file:///tmp/test',
        baseCommit: 'abc123',
        referenceFixCommit: undefined,
        dependencyLockHash: '',
      },
      repoSize: 'small' as const,
      task: {
        title: 'Fix a bug',
        description: 'The sort function is broken',
        source: 'synthetic' as const,
      },
      verification: {
        build: { command: 'npm run build', expectedExitCode: 0 },
        diagnostic: [{ command: 'npm test', expectedExitCode: 0 }],
        holdout: [],
        holdoutArtifacts: [],
        strength: 'V2' as const,
      },
      limits: { ...FROZEN_V018_LIMITS },
    }
    const m1 = buildTaskManifest(base)
    const m2 = buildTaskManifest(base)
    expect(m1.manifestHash).toBe(m2.manifestHash)
    expect(m1.manifestHash).toHaveLength(64)
  })

  it('validates a correct manifest', () => {
    const m = buildTaskManifest({
      taskId: 'test-002',
      category: 'bug-fix',
      benchmarkEligible: true,
      repository: {
        name: 'test-repo',
        url: 'file:///tmp/test',
        baseCommit: 'abc123',
        referenceFixCommit: undefined,
        dependencyLockHash: '',
      },
      repoSize: 'small',
      task: {
        title: 'Fix a bug',
        description: 'The sort function is broken',
        source: 'synthetic',
      },
      verification: {
        build: { command: 'npm run build', expectedExitCode: 0 },
        diagnostic: [{ command: 'npm test', expectedExitCode: 0 }],
        holdout: [],
        holdoutArtifacts: [],
        strength: 'V2',
      },
      limits: { ...FROZEN_V018_LIMITS },
    })
    const errors = validateTaskManifest(m)
    expect(errors).toEqual([])
  })

  it('rejects an empty taskId', () => {
    const m = buildTaskManifest({
      taskId: '',
      category: 'bug-fix',
      benchmarkEligible: true,
      repository: { name: 'r', url: 'file:///t', baseCommit: 'a', referenceFixCommit: undefined, dependencyLockHash: '' },
      repoSize: 'small',
      task: { title: 't', description: 'd', source: 'synthetic' },
      verification: {
        build: { command: 'npm run build', expectedExitCode: 0 },
        diagnostic: [{ command: 'npm test', expectedExitCode: 0 }],
        holdout: [],
        holdoutArtifacts: [],
        strength: 'V2',
      },
      limits: { ...FROZEN_V018_LIMITS },
    })
    const errors = validateTaskManifest(m)
    expect(errors).toContain('taskId must not be empty')
  })

  it('detects manifest hash tampering', () => {
    const m = buildTaskManifest({
      taskId: 'test-003',
      category: 'bug-fix',
      benchmarkEligible: true,
      repository: { name: 'r', url: 'file:///t', baseCommit: 'a', referenceFixCommit: undefined, dependencyLockHash: '' },
      repoSize: 'small',
      task: { title: 't', description: 'd', source: 'synthetic' },
      verification: {
        build: { command: 'npm run build', expectedExitCode: 0 },
        diagnostic: [{ command: 'npm test', expectedExitCode: 0 }],
        holdout: [],
        holdoutArtifacts: [],
        strength: 'V2',
      },
      limits: { ...FROZEN_V018_LIMITS },
    })
    const tampered: TaskManifest = { ...m, taskId: 'tampered' }
    const errors = validateTaskManifest(tampered)
    expect(errors.some(e => e.includes('manifestHash mismatch'))).toBe(true)
  })
})

function makeTrajectory(overrides: Partial<TaskTrajectory> = {}): TaskTrajectory {
  return {
    taskId: 'task-001',
    taskManifestHash: 'abc',
    experimentId: 'v019-synthetic-multirepo-validation-v4',
    experimentManifestHash: 'test-manifest-hash',
    benchmarkEligible: true,
    repository: {
      name: 'test-repo', url: 'file:///tmp/test', baseCommit: 'abc',
      size: 'small', loc: 100, fileCount: 5, packageCount: 1, testCount: 1,
    },
    category: 'bug-fix',
    taskDescription: 'Fix a bug',
    baseCommit: 'abc',
    referenceFixCommit: undefined,
    taskState: 'COMPLETED',
    controlPlaneStatus: 'PASS',
    modelCapabilityStatus: 'PASS',
    finalVerified: true,
    holdoutPass: true,
    verificationStrength: 'V2',
    flashAttempts: 1,
    proAttempts: 0,
    escalatedToPro: false,
    totalCostUsd: 0.005,
    totalLatencyMs: 20000,
    totalOutputTokens: 1000,
    totalCacheReadTokens: 5000,
    totalCacheMissTokens: 500,
    attempts: [{
      attempt: 1,
      attemptId: undefined,
      model: 'deepseek-v4-flash',
      routingDecisionId: 'rd-001',
      verified: true,
      diagnosticPass: true,
      holdoutPass: true,
      failureFingerprint: undefined,
      progress: undefined,
      failedCriteria: [], failingTests: [], typeErrors: [], buildErrors: [],
      usage: {
        inputTokens: 500, outputTokens: 1000, reasoningTokens: 100,
        totalTokens: 6500, cacheReadTokens: 5000, cacheMissTokens: 500,
      },
      costUsd: 0.005,
      latencyMs: 20000,
      repairAction: 'complete',
      repairReason: undefined,
      changedFiles: ['src/index.ts'],
      toolCallCount: 3,
      filesInspected: ['src/index.ts'],
      terminalOutcome: 'verified-complete',
    }],
    changedFiles: ['src/index.ts'],
    referenceFixFiles: [],
    referenceFixFilesInspected: [],
    referenceFixFilesModified: [],
    rollbackUsed: false,
    aborted: false,
    abortReason: undefined,
    terminalOutcome: 'verified-complete',
    failureCategory: undefined,
    providerRequestOutcomes: [{ outcome: 'success', provider: 'deepseek-official', model: 'deepseek-v4-flash' }],
    timestamp: '2026-08-28T00:00:00.000Z',
    ...overrides,
  }
}

describe('v019-metrics', () => {

  it('computes metrics for an empty cohort', () => {
    const metrics = computeMetrics([])
    expect(metrics.taskCount).toBe(0)
    expect(metrics.verifiedTaskRate).toBe(0)
  })

  it('computes one-shot Flash rate correctly', () => {
    const trajectories = [
      makeTrajectory({ taskId: 't1', finalVerified: true, attempts: [makeTrajectory().attempts[0]!] }),
      makeTrajectory({ taskId: 't2', finalVerified: false, attempts: [
        { ...makeTrajectory().attempts[0]!, verified: false, terminalOutcome: 'failed-no-rescue' },
      ] }),
    ]
    const metrics = computeMetrics(trajectories)
    expect(metrics.taskCount).toBe(2)
    expect(metrics.oneShotFlashRate).toBe(0.5)
    expect(metrics.verifiedTaskRate).toBe(0.5)
  })

  it('computes Pro escalation and rescue rates', () => {
    const trajectories = [
      makeTrajectory({ taskId: 't1', proAttempts: 1, escalatedToPro: true, finalVerified: true }),
      makeTrajectory({ taskId: 't2', proAttempts: 1, escalatedToPro: true, finalVerified: false }),
    ]
    const metrics = computeMetrics(trajectories)
    expect(metrics.proEscalationRate).toBe(1.0)
    expect(metrics.proRescueRate).toBe(0.5)
  })

  it('computes budget stop rate', () => {
    const trajectories = [
      makeTrajectory({ taskId: 't1', terminalOutcome: 'budget-stop', finalVerified: false }),
      makeTrajectory({ taskId: 't2', finalVerified: true }),
    ]
    const metrics = computeMetrics(trajectories)
    expect(metrics.budgetStopRate).toBe(0.5)
  })
})

describe('v019-failure-taxonomy', () => {
  function makeFailedTrajectory(overrides: Partial<TaskTrajectory> = {}): TaskTrajectory {
    return {
      taskId: 'fail-001',
      taskManifestHash: 'abc',
      experimentId: 'v019-synthetic-multirepo-validation-v4',
      experimentManifestHash: 'test-manifest-hash',
      benchmarkEligible: true,
      repository: {
        name: 'test-repo', url: 'file:///tmp/test', baseCommit: 'abc',
        size: 'small', loc: 100, fileCount: 5, packageCount: 1, testCount: 1,
      },
      category: 'bug-fix',
      taskDescription: 'Fix a bug',
      baseCommit: 'abc',
      referenceFixCommit: undefined,
      taskState: 'COMPLETED',
      controlPlaneStatus: 'PASS',
      modelCapabilityStatus: 'FAIL',
      finalVerified: false,
      holdoutPass: false,
      verificationStrength: 'V2',
      flashAttempts: 3,
      proAttempts: 0,
      escalatedToPro: false,
      totalCostUsd: 0.01,
      totalLatencyMs: 60000,
      totalOutputTokens: 2000,
      totalCacheReadTokens: 10000,
      totalCacheMissTokens: 1000,
      attempts: [],
      changedFiles: [],
      rollbackUsed: false,
      aborted: false,
      abortReason: undefined,
      terminalOutcome: 'failed-no-rescue',
      failureCategory: undefined,
      providerRequestOutcomes: [],
      referenceFixFiles: [],
      referenceFixFilesInspected: [],
      referenceFixFilesModified: [],
      timestamp: '2026-08-28T00:00:00.000Z',
      ...overrides,
    }
  }

  it('does not classify a verified task', () => {
    const t = makeFailedTrajectory({ finalVerified: true, modelCapabilityStatus: 'PASS' })
    expect(classifyFailure(t)).toBeUndefined()
  })

  it('classifies holdout edge-case failures', () => {
    const t = makeFailedTrajectory({
      attempts: [{
        attempt: 1, attemptId: undefined, model: 'deepseek-v4-flash', routingDecisionId: 'rd-1',
        verified: false, diagnosticPass: true, holdoutPass: false,
        failureFingerprint: undefined, progress: undefined,
        failedCriteria: [], failingTests: [], typeErrors: [], buildErrors: [],
        usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheMissTokens: 0 },
        costUsd: 0, latencyMs: 0, repairAction: 'complete', repairReason: 'qualification-failed',
        changedFiles: [], toolCallCount: 0, filesInspected: [], terminalOutcome: 'qualification-failed',
      }],
    })
    const classification = classifyFailure(t)
    expect(classification?.category).toBe('F18-holdout-edge-case')
  })

  it('classifies budget exhaustion', () => {
    const t = makeFailedTrajectory({ terminalOutcome: 'budget-stop' })
    const classification = classifyFailure(t)
    expect(classification?.category).toBe('F11-budget-exhaustion')
  })

  it('classifies provider failures', () => {
    const t = makeFailedTrajectory({
      controlPlaneStatus: 'FAIL',
      aborted: true,
      abortReason: 'model-unavailable',
      terminalOutcome: 'model-unavailable',
    })
    const classification = classifyFailure(t)
    expect(classification?.category).toBe('F14-provider-failure')
  })

  it('classifies control-plane errors separately from provider failures', () => {
    const t = makeFailedTrajectory({
      controlPlaneStatus: 'FAIL',
      aborted: true,
      abortReason: 'authority-undecidable',
      terminalOutcome: 'authority-undecidable',
    })
    const classification = classifyFailure(t)
    expect(classification?.category).toBe('F19-control-plane-error')
  })

  it('classifies premature escalation', () => {
    const t = makeFailedTrajectory({
      flashAttempts: 1,
      proAttempts: 1,
      escalatedToPro: true,
      attempts: [
        { attempt: 1, attemptId: undefined, model: 'deepseek-v4-flash', routingDecisionId: 'rd-1', verified: false, diagnosticPass: false, holdoutPass: undefined, failureFingerprint: 'fp1', progress: 'none', failedCriteria: [], failingTests: [], typeErrors: [], buildErrors: [], usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheMissTokens: 0 }, costUsd: 0, latencyMs: 0, repairAction: 'pro-escalate', repairReason: 'flash-exhausted', changedFiles: [], toolCallCount: 0, filesInspected: [], terminalOutcome: 'pro-escalate' },
        { attempt: 2, attemptId: undefined, model: 'deepseek-v4-pro', routingDecisionId: 'rd-2', verified: false, diagnosticPass: false, holdoutPass: undefined, failureFingerprint: 'fp2', progress: undefined, failedCriteria: [], failingTests: [], typeErrors: [], buildErrors: [], usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheMissTokens: 0 }, costUsd: 0, latencyMs: 0, repairAction: 'complete', repairReason: undefined, changedFiles: [], toolCallCount: 0, filesInspected: [], terminalOutcome: 'failed-no-rescue' },
      ],
    })
    const classification = classifyFailure(t)
    expect(classification?.category).toBe('F9-premature-escalation')
  })

  it('produces a failure category summary', () => {
    const trajectories = [
      makeFailedTrajectory({ taskId: 't1', terminalOutcome: 'budget-stop' }),
      makeFailedTrajectory({ taskId: 't2', terminalOutcome: 'budget-stop' }),
      makeFailedTrajectory({ taskId: 't3' }),
    ]
    const classifications = classifyAllFailures(trajectories)
    const summary = failureCategorySummary(classifications)
    expect(summary['F11-budget-exhaustion']).toBe(2)
  })

  it('classifies NOT_EVALUATED tasks as F6 build/environment', () => {
    const t = makeFailedTrajectory({
      taskState: 'FAILED_INFRA',
      controlPlaneStatus: 'NOT_EVALUATED',
      modelCapabilityStatus: 'NOT_EVALUATED',
      aborted: true,
      abortReason: 'npm install failed',
    })
    const classification = classifyFailure(t)
    expect(classification?.category).toBe('F6-build-environment')
  })
})

describe('v019 B0 vs benchmark separation', () => {
  it('B0 manifest is not benchmark-eligible', () => {
    const m = buildExperimentManifest({
      repairControllerVersion: '0.18.0',
      repairRuntimeVersion: '0.18.0',
      eventSchemaVersion: 0,
      pricingVersion: '2026-08-25',
      sandboxPolicyVersion: 'v1',
      sandboxQualificationId: 'test',
      taskCorpusVersion: 'v1',
      taskCount: 5,
      repositoryCount: 5,
      benchmarkEligible: false,
      repairStrategy: 'transactional',
      sandboxBackend: { runner: 'test', runnerPath: '/test', runnerVersion: '1.0', enforcement: 'full', networkDenied: true },
      snapshotAlgorithm: 'sha256-tree-v2',
      snapshotExclusions: 'verifier-snapshot-exclusions-v1',
      qualificationSemanticHash: 'test-semantic-hash',
      qualificationArtifactHash: 'test-hash',
      corpusManifestHash: 'test-corpus-hash',
    })
    expect(m.benchmarkEligible).toBe(false)
    expect(m.experimentId).toBe('v019-infra-validation-v4')
  })

  it('benchmark manifest is benchmark-eligible', () => {
    const m = buildExperimentManifest({
      repairControllerVersion: '0.18.0',
      repairRuntimeVersion: '0.18.0',
      eventSchemaVersion: 0,
      pricingVersion: '2026-08-25',
      sandboxPolicyVersion: 'v1',
      sandboxQualificationId: 'test',
      taskCorpusVersion: 'v1',
      taskCount: 75,
      repositoryCount: 10,
      benchmarkEligible: true, skipCleanSourceCheck: true,
      repairStrategy: 'transactional',
      sandboxBackend: { runner: 'test', runnerPath: '/test', runnerVersion: '1.0', enforcement: 'full', networkDenied: true },
      snapshotAlgorithm: 'sha256-tree-v2',
      snapshotExclusions: 'verifier-snapshot-exclusions-v1',
      qualificationSemanticHash: 'test-semantic-hash',
      qualificationArtifactHash: 'test-hash',
      corpusManifestHash: 'test-corpus-hash',
    })
    expect(m.benchmarkEligible).toBe(true)
    expect(m.experimentId).toBe('v019-synthetic-multirepo-validation-v4')
  })

  it('B0 and benchmark produce different experiment IDs', () => {
    const b0 = buildExperimentManifest({
      repairControllerVersion: '0.18.0',
      repairRuntimeVersion: '0.18.0',
      eventSchemaVersion: 0,
      pricingVersion: '2026-08-25',
      sandboxPolicyVersion: 'v1',
      sandboxQualificationId: 'test',
      taskCorpusVersion: 'v1',
      taskCount: 5,
      repositoryCount: 5,
      benchmarkEligible: false,
      repairStrategy: 'transactional',
      sandboxBackend: { runner: 'test', runnerPath: '/test', runnerVersion: '1.0', enforcement: 'full', networkDenied: true },
      snapshotAlgorithm: 'sha256-tree-v2',
      snapshotExclusions: 'verifier-snapshot-exclusions-v1',
      qualificationSemanticHash: 'test-semantic-hash',
      qualificationArtifactHash: 'test-hash',
      corpusManifestHash: 'test-corpus-hash',
    })
    const bench = buildExperimentManifest({
      repairControllerVersion: '0.18.0',
      repairRuntimeVersion: '0.18.0',
      eventSchemaVersion: 0,
      pricingVersion: '2026-08-25',
      sandboxPolicyVersion: 'v1',
      sandboxQualificationId: 'test',
      taskCorpusVersion: 'v1',
      taskCount: 75,
      repositoryCount: 10,
      benchmarkEligible: true, skipCleanSourceCheck: true,
      repairStrategy: 'transactional',
      sandboxBackend: { runner: 'test', runnerPath: '/test', runnerVersion: '1.0', enforcement: 'full', networkDenied: true },
      snapshotAlgorithm: 'sha256-tree-v2',
      snapshotExclusions: 'verifier-snapshot-exclusions-v1',
      qualificationSemanticHash: 'test-semantic-hash',
      qualificationArtifactHash: 'test-hash',
      corpusManifestHash: 'test-corpus-hash',
    })
    expect(b0.experimentId).not.toBe(bench.experimentId)
    expect(b0.manifestHash).not.toBe(bench.manifestHash)
  })

  it('task manifest carries benchmarkEligible', () => {
    const m = buildTaskManifest({
      taskId: 'test-bm',
      category: 'bug-fix',
      benchmarkEligible: false,
      repository: { name: 'r', url: 'file:///t', baseCommit: 'a', referenceFixCommit: undefined, dependencyLockHash: '' },
      repoSize: 'small',
      task: { title: 't', description: 'd', source: 'synthetic' },
      verification: {
        build: { command: 'npm run build', expectedExitCode: 0 },
        diagnostic: [{ command: 'npm test', expectedExitCode: 0 }],
        holdout: [],
        holdoutArtifacts: [],
        strength: 'V2',
      },
      limits: { ...FROZEN_V018_LIMITS },
    })
    expect(m.benchmarkEligible).toBe(false)
  })

  it('benchmarkEligible is included in manifest hash', () => {
    const base = {
      taskId: 'test-hash',
      category: 'bug-fix' as const,
      repoSize: 'small' as const,
      repository: { name: 'r', url: 'file:///t', baseCommit: 'a', referenceFixCommit: undefined, dependencyLockHash: '' },
      task: { title: 't', description: 'd', source: 'synthetic' as const },
      verification: {
        build: { command: 'npm run build', expectedExitCode: 0 },
        diagnostic: [{ command: 'npm test', expectedExitCode: 0 }],
        holdout: [] as readonly { command: string; expectedExitCode: number }[],
        holdoutArtifacts: [],
        strength: 'V2' as const,
      },
      limits: { ...FROZEN_V018_LIMITS },
    }
    const eligible = buildTaskManifest({ ...base, benchmarkEligible: true })
    const ineligible = buildTaskManifest({ ...base, benchmarkEligible: false })
    expect(eligible.manifestHash).not.toBe(ineligible.manifestHash)
  })
})

describe('v019 metrics reproducibility', () => {
  it('metrics are deterministically reproducible from trajectories', () => {
    const trajectories = [
      makeTrajectory({ taskId: 't1' }),
      makeTrajectory({ taskId: 't2', finalVerified: false, modelCapabilityStatus: 'FAIL' }),
    ]
    const m1 = computeMetrics(trajectories)
    const m2 = computeMetrics(trajectories)
    expect(JSON.stringify(m1)).toBe(JSON.stringify(m2))
  })

  it('NOT_EVALUATED tasks are excluded from capability metrics', () => {
    const trajectories = [
      makeTrajectory({ taskId: 't1', finalVerified: true }),
      makeTrajectory({
        taskId: 't2',
        taskState: 'FAILED_INFRA',
        controlPlaneStatus: 'NOT_EVALUATED',
        modelCapabilityStatus: 'NOT_EVALUATED',
        finalVerified: false,
        aborted: true,
        abortReason: 'checkout failed',
        attempts: [],
      }),
    ]
    const metrics = computeMetrics(trajectories)
    expect(metrics.taskCount).toBe(2)
    expect(metrics.evaluatedTaskCount).toBe(1)
    expect(metrics.infraFailureCount).toBe(1)
    expect(metrics.verifiedTaskRate).toBe(1.0)
  })

  it('reference-fix file miss rate is computed for failed tasks', () => {
    const trajectories = [
      makeTrajectory({
        taskId: 't1',
        finalVerified: false,
        modelCapabilityStatus: 'FAIL',
        referenceFixCommit: 'def456',
        referenceFixFilesInspected: [],
      }),
      makeTrajectory({
        taskId: 't2',
        finalVerified: false,
        modelCapabilityStatus: 'FAIL',
        referenceFixCommit: 'def789',
        referenceFixFilesInspected: ['src/index.ts'],
      }),
    ]
    const metrics = computeMetrics(trajectories)
    expect(metrics.referenceFixFileMissRate).toBe(0.5)
  })

  it('reference-fix file inspection rate is computed across all tasks with reference', () => {
    const trajectories = [
      makeTrajectory({
        taskId: 't1',
        finalVerified: true,
        referenceFixCommit: 'def456',
        referenceFixFilesInspected: ['src/index.ts'],
      }),
      makeTrajectory({
        taskId: 't2',
        finalVerified: false,
        modelCapabilityStatus: 'FAIL',
        referenceFixCommit: 'def789',
        referenceFixFilesInspected: [],
      }),
    ]
    const metrics = computeMetrics(trajectories)
    expect(metrics.referenceFixFileInspectionRate).toBe(0.5)
  })
})
