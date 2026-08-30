/**
 * v0.19 synthetic multi-repository evaluation experiment identity and manifest.
 *
 * Freezes the v0.18.0 control policy as the experimental control for the
 * synthetic multi-repository evaluation cohort. Records all version stamps,
 * model routes, repair limits, and task corpus identity so every trajectory
 * points back to a single experiment identity.
 *
 * B0 infrastructure validation runs are marked `benchmarkEligible: false`
 * so they cannot accidentally enter the baseline cohort.
 *
 * @module v019-experiment-identity
 */

import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'

/** Experiment identity for the v0.19 synthetic multi-repo cohort. */
export const EXPERIMENT_ID = 'v019-synthetic-multirepo-validation-v1'

/** Experiment identity for the B0 infrastructure validation shakedown. */
export const B0_EXPERIMENT_ID = 'v019-infra-validation-v1'

/** v0.18.0 tag that this experiment freezes as experimental control. */
export const FROZEN_V018_TAG = 'v0.18.0'

/** Experiment manifest recording all version stamps for the evaluation cohort. */
export interface ExperimentManifest {
  readonly experimentId: string
  readonly sourceCommit: string
  readonly frozenV018Tag: string
  readonly repairControllerVersion: string
  readonly repairRuntimeVersion: string
  readonly eventSchemaVersion: number
  readonly pricingVersion: string
  readonly sandboxPolicyVersion: string
  readonly sandboxQualificationId: string
  readonly modelRoutes: ReadonlyArray<{ alias: string; provider: string; model: string }>
  readonly frozenRepairLimits: Readonly<{
    maxFlashAttempts: number
    maxProAttempts: number
    maxTotalAttempts: number
    maxTaskCostUsd: number | undefined
    maxElapsedMs: number | undefined
    maxOutputTokens: number | undefined
  }>
  readonly taskCorpusVersion: string
  readonly taskCount: number
  readonly repositoryCount: number
  /** False for B0 infrastructure validation; true for the baseline cohort. */
  readonly benchmarkEligible: boolean
  /** Repair strategy: 'transactional' rolls back to baseline before each attempt; 'iterative' preserves workspace state. */
  readonly repairStrategy: 'transactional' | 'iterative'
  /** Actual selected sandbox backend (runner name, path, version, enforcement, network isolation). */
  readonly sandboxBackend: Readonly<{
    runner: string
    runnerPath: string
    runnerVersion: string
    enforcement: string
    networkDenied: boolean
  }>
  /** Workspace snapshot algorithm and exclusion set versions. */
  readonly snapshotAlgorithm: string
  readonly snapshotExclusions: string
  /** Hash of the composed qualification artifact that must pass before the cohort runs. */
  readonly qualificationArtifactHash: string
  readonly manifestHash: string
}

/** Build the experiment manifest from the current repository state. */
export function buildExperimentManifest(params: {
  repairControllerVersion: string
  repairRuntimeVersion: string
  eventSchemaVersion: number
  pricingVersion: string
  sandboxPolicyVersion: string
  sandboxQualificationId: string
  taskCorpusVersion: string
  taskCount: number
  repositoryCount: number
  benchmarkEligible: boolean
  repairStrategy: 'transactional' | 'iterative'
  sandboxBackend: { runner: string; runnerPath: string; runnerVersion: string; enforcement: string; networkDenied: boolean }
  snapshotAlgorithm: string
  snapshotExclusions: string
  qualificationArtifactHash: string
}): ExperimentManifest {
  const sourceCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
  const experimentId = params.benchmarkEligible ? EXPERIMENT_ID : B0_EXPERIMENT_ID
  const modelRoutes = [
    { alias: 'flash', provider: 'deepseek', model: 'deepseek-v4-flash' },
    { alias: 'pro', provider: 'deepseek', model: 'deepseek-v4-pro' },
  ]
  const frozenRepairLimits = {
    maxFlashAttempts: 3,
    maxProAttempts: 2,
    maxTotalAttempts: 5,
    maxTaskCostUsd: undefined as number | undefined,
    maxElapsedMs: undefined as number | undefined,
    maxOutputTokens: undefined as number | undefined,
  }
  const manifestHash = computeExperimentManifestHash({
    experimentId,
    sourceCommit,
    frozenV018Tag: FROZEN_V018_TAG,
    repairControllerVersion: params.repairControllerVersion,
    repairRuntimeVersion: params.repairRuntimeVersion,
    eventSchemaVersion: params.eventSchemaVersion,
    pricingVersion: params.pricingVersion,
    sandboxPolicyVersion: params.sandboxPolicyVersion,
    sandboxQualificationId: params.sandboxQualificationId,
    modelRoutes,
    frozenRepairLimits,
    taskCorpusVersion: params.taskCorpusVersion,
    taskCount: params.taskCount,
    repositoryCount: params.repositoryCount,
    benchmarkEligible: params.benchmarkEligible,
    repairStrategy: params.repairStrategy,
    sandboxBackend: params.sandboxBackend,
    snapshotAlgorithm: params.snapshotAlgorithm,
    snapshotExclusions: params.snapshotExclusions,
    qualificationArtifactHash: params.qualificationArtifactHash,
  })
  return {
    experimentId,
    sourceCommit,
    frozenV018Tag: FROZEN_V018_TAG,
    repairControllerVersion: params.repairControllerVersion,
    repairRuntimeVersion: params.repairRuntimeVersion,
    eventSchemaVersion: params.eventSchemaVersion,
    pricingVersion: params.pricingVersion,
    sandboxPolicyVersion: params.sandboxPolicyVersion,
    sandboxQualificationId: params.sandboxQualificationId,
    modelRoutes,
    frozenRepairLimits,
    taskCorpusVersion: params.taskCorpusVersion,
    taskCount: params.taskCount,
    repositoryCount: params.repositoryCount,
    benchmarkEligible: params.benchmarkEligible,
    repairStrategy: params.repairStrategy,
    sandboxBackend: params.sandboxBackend,
    snapshotAlgorithm: params.snapshotAlgorithm,
    snapshotExclusions: params.snapshotExclusions,
    qualificationArtifactHash: params.qualificationArtifactHash,
    manifestHash,
  }
}

function computeExperimentManifestHash(fields: Omit<ExperimentManifest, 'manifestHash'>): string {
  const routeLines = fields.modelRoutes
    .map(r => `${r.alias}=${r.provider}:${r.model}`)
    .sort()
    .join('|')
  const limitLine = `${fields.frozenRepairLimits.maxFlashAttempts}:${fields.frozenRepairLimits.maxProAttempts}:${fields.frozenRepairLimits.maxTotalAttempts}:${fields.frozenRepairLimits.maxTaskCostUsd ?? 'none'}:${fields.frozenRepairLimits.maxElapsedMs ?? 'none'}:${fields.frozenRepairLimits.maxOutputTokens ?? 'none'}`
  const backendLine = `${fields.sandboxBackend.runner}:${fields.sandboxBackend.runnerPath}:${fields.sandboxBackend.runnerVersion}:${fields.sandboxBackend.enforcement}:${fields.sandboxBackend.networkDenied}`
  const manifestContent = [
    fields.experimentId,
    fields.sourceCommit,
    fields.frozenV018Tag,
    fields.repairControllerVersion,
    fields.repairRuntimeVersion,
    String(fields.eventSchemaVersion),
    fields.pricingVersion,
    fields.sandboxPolicyVersion,
    fields.sandboxQualificationId,
    routeLines,
    limitLine,
    fields.taskCorpusVersion,
    String(fields.taskCount),
    String(fields.repositoryCount),
    String(fields.benchmarkEligible),
    fields.repairStrategy,
    backendLine,
    fields.snapshotAlgorithm,
    fields.snapshotExclusions,
    fields.qualificationArtifactHash,
  ].join(':')
  return createHash('sha256').update(manifestContent).digest('hex')
}
