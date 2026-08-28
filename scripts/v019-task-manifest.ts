/**
 * v0.19 task manifest format and validator.
 *
 * Each task in the evaluation cohort has a stable manifest that records
 * the repository, base commit, task description, verification commands,
 * and repair limits. The manifest is hashed so every trajectory can point
 * back to a deterministic task identity.
 *
 * @module v019-task-manifest
 */

import { createHash } from 'node:crypto'

/** Verification strength classification. */
export type VerificationStrength = 'V3' | 'V2' | 'V1' | 'V0'

/** Task category from the v0.19 evaluation plan. */
export type TaskCategory =
  | 'bug-fix'
  | 'failing-test'
  | 'type-build-error'
  | 'multi-file-feature'
  | 'refactor'
  | 'api-integration'
  | 'repo-understanding'
  | 'algorithm'
  | 'config-deps'

/** Repository size bucket. */
export type RepoSize = 'small' | 'medium' | 'large'

/** A single verification command with expected exit code. */
export interface VerificationCommand {
  readonly command: string
  readonly expectedExitCode: number
}

/** Task manifest for one evaluation task. */
export interface TaskManifest {
  readonly taskId: string
  readonly category: TaskCategory
  readonly repository: {
    readonly name: string
    readonly url: string
    readonly baseCommit: string
    readonly referenceFixCommit: string | undefined
  }
  readonly repoSize: RepoSize
  readonly task: {
    readonly title: string
    readonly description: string
    readonly source: 'historical-issue' | 'historical-pr' | 'historical-commit' | 'synthetic' | 'manual'
  }
  readonly verification: {
    readonly build: VerificationCommand
    readonly diagnostic: readonly VerificationCommand[]
    readonly holdout: readonly VerificationCommand[]
    readonly strength: VerificationStrength
  }
  readonly limits: {
    readonly maxFlashAttempts: number
    readonly maxProAttempts: number
    readonly maxTotalAttempts: number
  }
  readonly manifestHash: string
}

/** Compute the SHA-256 hash of a task manifest (excluding the hash field). */
export function computeTaskManifestHash(fields: Omit<TaskManifest, 'manifestHash'>): string {
  const diagLines = fields.verification.diagnostic
    .map(c => `${c.command}=${c.expectedExitCode}`)
    .sort()
    .join('|')
  const holdoutLines = fields.verification.holdout
    .map(c => `${c.command}=${c.expectedExitCode}`)
    .sort()
    .join('|')
  const manifestContent = [
    fields.taskId,
    fields.category,
    fields.repository.name,
    fields.repository.url,
    fields.repository.baseCommit,
    fields.repository.referenceFixCommit ?? 'none',
    fields.repoSize,
    fields.task.title,
    fields.task.description,
    fields.task.source,
    fields.verification.build.command,
    String(fields.verification.build.expectedExitCode),
    diagLines,
    holdoutLines,
    fields.verification.strength,
    String(fields.limits.maxFlashAttempts),
    String(fields.limits.maxProAttempts),
    String(fields.limits.maxTotalAttempts),
  ].join(':')
  return createHash('sha256').update(manifestContent).digest('hex')
}

/** Build a task manifest with computed hash. */
export function buildTaskManifest(params: Omit<TaskManifest, 'manifestHash'>): TaskManifest {
  return { ...params, manifestHash: computeTaskManifestHash(params) }
}

/** Validate a task manifest is internally consistent. */
export function validateTaskManifest(manifest: TaskManifest): readonly string[] {
  const errors: string[] = []
  if (manifest.taskId.length === 0) errors.push('taskId must not be empty')
  if (manifest.repository.url.length === 0) errors.push('repository url must not be empty')
  if (manifest.repository.baseCommit.length === 0) errors.push('repository baseCommit must not be empty')
  if (manifest.task.description.length === 0) errors.push('task description must not be empty')
  if (manifest.verification.build.command.length === 0) errors.push('build command must not be empty')
  if (manifest.verification.diagnostic.length === 0) errors.push('at least one diagnostic command required')
  if (manifest.limits.maxFlashAttempts < 1) errors.push('maxFlashAttempts must be >= 1')
  if (manifest.limits.maxProAttempts < 0) errors.push('maxProAttempts must be >= 0')
  if (manifest.limits.maxTotalAttempts < manifest.limits.maxFlashAttempts + manifest.limits.maxProAttempts) {
    errors.push('maxTotalAttempts must be >= maxFlashAttempts + maxProAttempts')
  }
  const recomputed = computeTaskManifestHash(manifest)
  if (recomputed !== manifest.manifestHash) errors.push('manifestHash mismatch')
  return errors
}

/** Default repair limits matching the frozen v0.18.0 policy. */
export const FROZEN_V018_LIMITS = {
  maxFlashAttempts: 3,
  maxProAttempts: 2,
  maxTotalAttempts: 5,
} as const
