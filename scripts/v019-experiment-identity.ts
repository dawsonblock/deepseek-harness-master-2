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
import { readFileSync } from 'node:fs'

/** Experiment identity for the v0.19 synthetic multi-repo cohort. */
export const EXPERIMENT_ID = 'v019-synthetic-multirepo-validation-v4'

/** Experiment identity for the B0 infrastructure validation shakedown. */
export const B0_EXPERIMENT_ID = 'v019-infra-validation-v4'

/** Experiment identity for exploratory runs (security-gate-bypassed, not benchmark-eligible). */
export const EXPLORATORY_EXPERIMENT_ID = 'v019-exploratory-v4'

/** v0.18.0 tag that this experiment freezes as experimental control. */
export const FROZEN_V018_TAG = 'v0.18.0'

/** Experiment manifest recording all version stamps for the evaluation cohort. */
export interface ExperimentManifest {
  readonly experimentId: string
  readonly sourceCommit: string
  /** SHA-256 of the working tree contents (excluding node_modules/.git/dist) at manifest build time. */
  readonly sourceTreeHash: string
  /** True when the working tree had uncommitted changes at manifest build time. */
  readonly sourceTreeDirty: boolean
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
  /**
   * SHA-256 of sorted (taskId + taskManifestHash + baseCommit +
   * referenceFixCommit + strength + benchmarkEligible). Proves the exact
   * task set without relying on a version label.
   */
  readonly corpusManifestHash: string
  readonly taskCount: number
  readonly repositoryCount: number
  /** False for B0 infrastructure validation; true for the baseline cohort. */
  readonly benchmarkEligible: boolean
  /** 'benchmark' for qualified runs, 'exploratory' for security-gate-bypassed runs, 'b0' for infrastructure validation. */
  readonly runClass: 'benchmark' | 'exploratory' | 'b0'
  /** True when the security gate was bypassed via --skip-security-gate. Forces benchmarkEligible=false. */
  readonly securityGateBypassed: boolean
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
  /**
   * Semantic hash of the composed qualification artifact, excluding
   * non-deterministic fields (timestamp, environment noise). This hash
   * is part of the experiment identity: two runs with identical source,
   * corpus, sandbox, and controller produce the same semantic hash.
   */
  readonly qualificationSemanticHash: string
  /**
   * Full hash of the composed qualification artifact including
   * timestamp and environment fields. This is audit evidence, not
   * experiment identity.
   */
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
  corpusManifestHash: string
  taskCount: number
  repositoryCount: number
  benchmarkEligible: boolean
  /** True when --skip-security-gate was passed. Forces benchmarkEligible=false and runClass='exploratory'. */
  securityGateBypassed?: boolean
  /** Skip the clean-source enforcement gate. Tests use this to avoid depending on the repo's working-tree state. */
  skipCleanSourceCheck?: boolean
  repairStrategy: 'transactional' | 'iterative'
  sandboxBackend: { runner: string; runnerPath: string; runnerVersion: string; enforcement: string; networkDenied: boolean }
  snapshotAlgorithm: string
  snapshotExclusions: string
  /**
   * Semantic hash of the composed qualification artifact excluding
   * non-deterministic fields (timestamp, environment). Used as
   * experiment identity.
   */
  qualificationSemanticHash: string
  /**
   * Full hash of the composed qualification artifact including
   * timestamp and environment. Used as audit evidence.
   */
  qualificationArtifactHash: string
}): ExperimentManifest {
  // Invariant: security-gate bypass forces benchmark ineligibility.
  // This prevents exploratory runs from being mistaken for qualified evidence.
  const securityGateBypassed = params.securityGateBypassed ?? false
  if (securityGateBypassed && params.benchmarkEligible) {
    throw new Error(
      'Invariant violation: securityGateBypassed=true requires benchmarkEligible=false. '
      + 'A bypassed security gate cannot produce benchmark-eligible results.',
    )
  }
  const runClass: 'benchmark' | 'exploratory' | 'b0' = securityGateBypassed
    ? 'exploratory'
    : params.benchmarkEligible
      ? 'benchmark'
      : 'b0'
  const sourceCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
  const porcelain = execSync('git status --porcelain', { encoding: 'utf8' }).trim()
  const sourceTreeDirty = porcelain.length > 0
  if (params.benchmarkEligible && sourceTreeDirty && !params.skipCleanSourceCheck) {
    const count = porcelain.split('\n').filter(l => l.length > 0).length
    throw new Error(
      'Benchmark-eligible evaluation requires a clean source tree. '
      + `Found ${count} uncommitted change(s). Commit or stash changes, `
      + 'or run with --b0 for non-benchmark infrastructure validation.',
    )
  }
  const sourceTreeHash = computeSourceTreeHash()
  // Experiment ID is determined by runClass, not just benchmarkEligible.
  // Exploratory runs (security-gate-bypassed) get their own identity, distinct
  // from B0 infrastructure validation runs. This prevents exploratory
  // trajectories from being mapped to the B0 experiment identity.
  const experimentId = runClass === 'benchmark'
    ? EXPERIMENT_ID
    : runClass === 'exploratory'
      ? EXPLORATORY_EXPERIMENT_ID
      : B0_EXPERIMENT_ID
  const modelRoutes = [
    { alias: 'flash', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    { alias: 'pro', provider: 'deepseek-official', model: 'deepseek-v4-pro' },
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
    sourceTreeHash,
    sourceTreeDirty,
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
    corpusManifestHash: params.corpusManifestHash,
    taskCount: params.taskCount,
    repositoryCount: params.repositoryCount,
    benchmarkEligible: params.benchmarkEligible,
    runClass,
    securityGateBypassed,
    repairStrategy: params.repairStrategy,
    sandboxBackend: params.sandboxBackend,
    snapshotAlgorithm: params.snapshotAlgorithm,
    snapshotExclusions: params.snapshotExclusions,
    qualificationSemanticHash: params.qualificationSemanticHash,
  })
  return {
    experimentId,
    sourceCommit,
    sourceTreeHash,
    sourceTreeDirty,
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
    corpusManifestHash: params.corpusManifestHash,
    taskCount: params.taskCount,
    repositoryCount: params.repositoryCount,
    benchmarkEligible: params.benchmarkEligible,
    runClass,
    securityGateBypassed,
    repairStrategy: params.repairStrategy,
    sandboxBackend: params.sandboxBackend,
    snapshotAlgorithm: params.snapshotAlgorithm,
    snapshotExclusions: params.snapshotExclusions,
    qualificationSemanticHash: params.qualificationSemanticHash,
    qualificationArtifactHash: params.qualificationArtifactHash,
    manifestHash,
  }
}

function computeExperimentManifestHash(fields: Omit<ExperimentManifest, 'manifestHash' | 'qualificationArtifactHash'>): string {
  const routeLines = fields.modelRoutes
    .map(r => `${r.alias}=${r.provider}:${r.model}`)
    .sort()
    .join('|')
  const limitLine = `${fields.frozenRepairLimits.maxFlashAttempts}:${fields.frozenRepairLimits.maxProAttempts}:${fields.frozenRepairLimits.maxTotalAttempts}:${fields.frozenRepairLimits.maxTaskCostUsd ?? 'none'}:${fields.frozenRepairLimits.maxElapsedMs ?? 'none'}:${fields.frozenRepairLimits.maxOutputTokens ?? 'none'}`
  const backendLine = `${fields.sandboxBackend.runner}:${fields.sandboxBackend.runnerPath}:${fields.sandboxBackend.runnerVersion}:${fields.sandboxBackend.enforcement}:${fields.sandboxBackend.networkDenied}`
  const manifestContent = [
    fields.experimentId,
    fields.sourceCommit,
    fields.sourceTreeHash,
    String(fields.sourceTreeDirty),
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
    fields.corpusManifestHash,
    String(fields.taskCount),
    String(fields.repositoryCount),
    String(fields.benchmarkEligible),
    fields.repairStrategy,
    backendLine,
    fields.snapshotAlgorithm,
    fields.snapshotExclusions,
    fields.qualificationSemanticHash,
  ].join(':')
  return createHash('sha256').update(manifestContent).digest('hex')
}

/**
 * Compute a SHA-256 hash of the repository source tree, excluding
 * `node_modules`, `.git`, and `dist`. This catches dirty working trees
 * that share the same `git rev-parse HEAD` but differ in content.
 */
function computeSourceTreeHash(): string {
  const hash = createHash('sha256')
  const output = execSync(
    'git ls-files -z --cached --others --exclude-standard',
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 256 },
  )
  const files = output.split('\0').filter(f => f.length > 0)
  for (const file of files.sort()) {
    hash.update(file).update(':')
    try {
      hash.update(readFileSync(file))
    } catch {
      hash.update('[unreadable]')
    }
    hash.update('\n')
  }
  return hash.digest('hex')
}

/**
 * Compute a deterministic SHA-256 over a set of task manifests. The hash
 * covers sorted (taskId, taskManifestHash, baseCommit, referenceFixCommit,
 * verificationStrength, benchmarkEligible) tuples so any single task change
 * produces a different corpus identity.
 */
export function computeCorpusManifestHash(
  tasks: readonly {
    readonly taskId: string
    readonly manifestHash: string
    readonly repository: { readonly baseCommit: string; readonly referenceFixCommit: string | undefined }
    readonly verification: { readonly strength: string }
    readonly benchmarkEligible: boolean
  }[],
): string {
  const lines = tasks
    .map(t => `${t.taskId}:${t.manifestHash}:${t.repository.baseCommit}:${t.repository.referenceFixCommit ?? 'none'}:${t.verification.strength}:${String(t.benchmarkEligible)}`)
    .sort()
    .join('\n')
  return createHash('sha256').update(lines).digest('hex')
}
