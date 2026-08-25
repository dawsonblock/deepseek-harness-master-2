/**
 * v0.17.4 repair experiment core: canonical failure evidence, deterministic
 * failure fingerprinting, progress-aware same-failure escalation, and bounded
 * stage loop protection. Pure functions only — no provider calls, no session
 * mutations, no runtime authority.
 *
 * The experiment runner in `run-v0174-repair-experiment.ts` imports these
 * functions to construct real Flash-failure → Pro-repair trajectories. The
 * companion spec file validates them keylessly.
 *
 * @module v0174-repair-core
 */

import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Progress classification for a failed attempt relative to prior state. */
export type ProgressClass = 'none' | 'partial' | 'regression'

/** Pro's explicit takeover decision, recorded before Pro mutates the workspace. */
export type TakeoverDecision = 'REPAIR_EXISTING' | 'ROLLBACK_AND_REDO'

/** Objective verification evidence collected from a failed coding attempt. */
export interface VerificationEvidence {
  /** Acceptance criteria that failed (human-readable descriptions). */
  readonly failedCriteria: readonly string[]
  /** Failing test names or identifiers. */
  readonly failingTests: readonly string[]
  /** TypeScript type errors (file:message format, normalized at ingestion). */
  readonly typeErrors: readonly string[]
  /** Build errors (compiler/bundler output, normalized at ingestion). */
  readonly buildErrors: readonly string[]
}

/** Canonical failure evidence package constructed after a verified Flash failure. */
export interface FailurePackage {
  readonly taskId: string
  readonly routingDecisionId: string
  readonly originalGoal: string
  readonly attempt: {
    readonly model: string
    readonly changedFiles: readonly string[]
    readonly patchSummary?: string
  }
  readonly verification: VerificationEvidence
  readonly failureFingerprint: string
  readonly progress: ProgressClass
  readonly checkpoints: {
    readonly taskStart: string
    readonly afterFlash: string
  }
}

/** One stage execution attempt within a multi-stage task trajectory. */
export interface StageAttempt {
  readonly model: 'flash' | 'pro'
  readonly routingDecisionId: string
  readonly verified: boolean
  readonly failureFingerprint?: string
  readonly verificationEvidence?: VerificationEvidence
  readonly takeoverDecision?: TakeoverDecision
  readonly costUsd: number
  readonly latencyMs: number
  readonly usage: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly reasoningTokens: number
    readonly totalTokens: number
  }
}

/** One task's full trajectory under a specific policy. */
export interface TaskTrajectory {
  readonly taskId: string
  readonly policy: PolicyName
  readonly verified: boolean
  readonly stages: readonly StageAttempt[]
  readonly escalated: boolean
  readonly failurePackage?: FailurePackage
}

/** The five policies evaluated in v0.17.4. */
export type PolicyName =
  | 'flash-only'
  | 'pro-only'
  | 'flash-fail-pro-fresh'
  | 'flash-fail-pro-repair'
  | 'flash-repair-then-pro'

/** Result of objective verification on a workspace. */
export interface WorkspaceVerificationResult {
  readonly passed: boolean
  readonly evidence: VerificationEvidence
  readonly criteriaPassed: number
  readonly criteriaTotal: number
}

// ---------------------------------------------------------------------------
// Failure fingerprinting
// ---------------------------------------------------------------------------

/**
 * Normalize one failure text line for fingerprinting. Strips absolute file
 * paths, line:col positions, timing, and collapses whitespace, preserving
 * only the substantive failure content.
 */
export function normalizeFailureText(text: string): string {
  return text.trim().toLowerCase()
    .replace(/\/[^\s:]+:\d+:\d+/g, '<file:line:col>')
    .replace(/\/[^\s:)]+/g, '<file>')
    .replace(/\b\d+ms\b/g, '<ms>')
    .replace(/\b0x[0-9a-f]+\b/g, '<hex>')
    .replace(/\s+/g, ' ')
}

/**
 * Compute a deterministic 16-hex-character fingerprint from verification
 * evidence. Two attempts that fail for the same substantive reasons produce
 * the same fingerprint regardless of incidental formatting, timestamps, or
 * file path differences.
 *
 * @param evidence - verification evidence from a failed attempt.
 * @returns 16-character hex fingerprint.
 */
export function computeFailureFingerprint(evidence: VerificationEvidence): string {
  const parts = [
    ...evidence.failedCriteria.map(normalizeFailureText).sort(),
    ...evidence.failingTests.map(normalizeFailureText).sort(),
    ...evidence.typeErrors.map(normalizeFailureText).sort(),
    ...evidence.buildErrors.map(normalizeFailureText).sort(),
  ]
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------------------
// Progress classification
// ---------------------------------------------------------------------------

/** Count total failure items across all evidence categories. */
export function countFailures(evidence: VerificationEvidence): number {
  return evidence.failedCriteria.length
    + evidence.failingTests.length
    + evidence.typeErrors.length
    + evidence.buildErrors.length
}

/**
 * Classify progress of a failed attempt relative to the prior failed attempt.
 * Returns `none` when this is the first failure or the same substantive
 * failure repeats, `partial` when fewer or different failures remain, and
 * `regression` when more failures appeared.
 *
 * @param priorEvidence - verification evidence from the previous failed attempt, or undefined for the first failure.
 * @param currentEvidence - verification evidence from the current failed attempt.
 * @returns progress classification.
 */
export function classifyProgress(
  priorEvidence: VerificationEvidence | undefined,
  currentEvidence: VerificationEvidence,
): ProgressClass {
  if (priorEvidence === undefined) return 'none'
  const priorCount = countFailures(priorEvidence)
  const currentCount = countFailures(currentEvidence)
  if (currentCount === 0) return 'partial'
  if (currentCount > priorCount) return 'regression'
  if (currentCount < priorCount) return 'partial'
  if (computeFailureFingerprint(priorEvidence) === computeFailureFingerprint(currentEvidence)) {
    return 'none'
  }
  return 'partial'
}

// ---------------------------------------------------------------------------
// Same-failure detection
// ---------------------------------------------------------------------------

/**
 * Whether two failure fingerprints represent the same substantive failure.
 * Used to detect repeated no-progress failures and prevent wasting calls.
 */
export function isSameFailure(priorFingerprint: string, currentFingerprint: string): boolean {
  return priorFingerprint === currentFingerprint
}

// ---------------------------------------------------------------------------
// Loop bounds and escalation
// ---------------------------------------------------------------------------

/** Bounded stage limits for one task trajectory. */
export interface LoopBounds {
  /** Maximum initial Flash attempts (always 1 for v0.17.4). */
  readonly maxFlashAttempts: number
  /** Maximum evidence-conditioned Flash repairs after an initial Flash failure. */
  readonly maxFlashRepairs: number
  /** Maximum Pro attempts (initial or after Flash). */
  readonly maxProAttempts: number
  /** Maximum evidence-conditioned Pro repairs after a Pro failure. */
  readonly maxProRepairs: number
  /** Hard limit on total stages per task; prevents infinite loops. */
  readonly maxTotalStages: number
}

/** Default loop bounds for v0.17.4 policies. */
export const DEFAULT_LOOP_BOUNDS: LoopBounds = {
  maxFlashAttempts: 1,
  maxFlashRepairs: 1,
  maxProAttempts: 1,
  maxProRepairs: 0,
  maxTotalStages: 4,
}

/** Action chosen by the escalation controller after a failed stage. */
export type EscalationAction =
  | { readonly kind: 'flash-repair' }
  | { readonly kind: 'escalate-to-pro' }
  | { readonly kind: 'stop' }

/**
 * Decide the next action after a failed stage, applying same-failure
 * detection and loop bounds. The decision is deterministic given the stage
 * history and bounds.
 *
 * Rules:
 * 1. If two consecutive Flash failures share the same fingerprint, escalate
 *    to Pro immediately — stop wasting Flash calls.
 * 2. If a Flash repair is still within bounds and the failure is new, allow
 *    one evidence-conditioned Flash repair.
 * 3. If Flash bounds are exhausted, escalate to Pro.
 * 4. If Pro fails, stop (no Pro repair loop in v0.17.4).
 * 5. If the hard stage limit is reached, stop.
 *
 * @param stages - completed stage attempts in execution order.
 * @param bounds - loop bounds for this trajectory.
 * @returns the next escalation action.
 */
export function decideEscalation(
  stages: readonly StageAttempt[],
  bounds: LoopBounds = DEFAULT_LOOP_BOUNDS,
): EscalationAction {
  if (stages.length === 0) return { kind: 'stop' }
  const lastStage = stages[stages.length - 1]
  if (lastStage.verified) return { kind: 'stop' }
  if (stages.length >= bounds.maxTotalStages) return { kind: 'stop' }

  if (lastStage.model === 'flash') {
    const flashStages = stages.filter(stage => stage.model === 'flash')
    const flashFailures = flashStages.filter(stage => !stage.verified)

    if (flashFailures.length >= 2) {
      const fingerprints = flashFailures.map(stage => stage.failureFingerprint)
      const prior = fingerprints[fingerprints.length - 2]
      const current = fingerprints[fingerprints.length - 1]
      if (prior !== undefined && current !== undefined && isSameFailure(prior, current)) {
        return { kind: 'escalate-to-pro' }
      }
    }

    const maxFlashStages = bounds.maxFlashAttempts + bounds.maxFlashRepairs
    if (flashStages.length < maxFlashStages) {
      return { kind: 'flash-repair' }
    }

    const proStages = stages.filter(stage => stage.model === 'pro')
    if (proStages.length < bounds.maxProAttempts + bounds.maxProRepairs) {
      return { kind: 'escalate-to-pro' }
    }

    return { kind: 'stop' }
  }

  if (lastStage.model === 'pro') {
    return { kind: 'stop' }
  }

  return { kind: 'stop' }
}

/**
 * Verify that a stage history respects loop bounds. Returns a violation
 * description if any bound is exceeded, or undefined if the trajectory is
 * valid. Used as a safety check after trajectory completion.
 *
 * @param stages - completed stage attempts.
 * @param bounds - loop bounds.
 * @returns violation description or undefined.
 */
export function detectLoopViolation(
  stages: readonly StageAttempt[],
  bounds: LoopBounds = DEFAULT_LOOP_BOUNDS,
): string | undefined {
  if (stages.length > bounds.maxTotalStages) {
    return `total stages ${stages.length} exceed hard limit ${bounds.maxTotalStages}`
  }
  const flashStages = stages.filter(stage => stage.model === 'flash')
  const maxFlashStages = bounds.maxFlashAttempts + bounds.maxFlashRepairs
  if (flashStages.length > maxFlashStages) {
    return `flash stages ${flashStages.length} exceed limit ${maxFlashStages}`
  }
  const proStages = stages.filter(stage => stage.model === 'pro')
  const maxProStages = bounds.maxProAttempts + bounds.maxProRepairs
  if (proStages.length > maxProStages) {
    return `pro stages ${proStages.length} exceed limit ${maxProStages}`
  }
  return undefined
}

// ---------------------------------------------------------------------------
// FailurePackage construction
// ---------------------------------------------------------------------------

/**
 * Construct a canonical FailurePackage from a failed Flash attempt.
 *
 * @param params - construction inputs.
 * @returns the FailurePackage.
 */
export function constructFailurePackage(params: {
  taskId: string
  routingDecisionId: string
  originalGoal: string
  model: string
  changedFiles: readonly string[]
  patchSummary?: string
  verification: VerificationEvidence
  priorEvidence?: VerificationEvidence
  checkpoints: { taskStart: string; afterFlash: string }
}): FailurePackage {
  const failureFingerprint = computeFailureFingerprint(params.verification)
  const progress = classifyProgress(params.priorEvidence, params.verification)
  return {
    taskId: params.taskId,
    routingDecisionId: params.routingDecisionId,
    originalGoal: params.originalGoal,
    attempt: {
      model: params.model,
      changedFiles: params.changedFiles,
      ...params.patchSummary !== undefined ? { patchSummary: params.patchSummary } : {},
    },
    verification: params.verification,
    failureFingerprint,
    progress,
    checkpoints: params.checkpoints,
  }
}

// ---------------------------------------------------------------------------
// Pro repair prompt construction
// ---------------------------------------------------------------------------

/**
 * Construct the prompt for Pro when it takes over a failed Flash task with
 * failure evidence. Pro receives the original goal, Flash's attempt details,
 * and the verification failures, then must choose REPAIR_EXISTING or
 * ROLLBACK_AND_REDO before making any changes.
 *
 * @param failurePackage - the canonical failure evidence.
 * @returns the prompt string for Pro.
 */
export function constructProRepairPrompt(failurePackage: FailurePackage): string {
  const lines: string[] = [
    'You are taking over a coding task that a junior engineer attempted but failed.',
    '',
    `Original goal: ${failurePackage.originalGoal}`,
    '',
    'Junior engineer attempt:',
    `- Model: ${failurePackage.attempt.model}`,
    `- Changed files: ${failurePackage.attempt.changedFiles.length > 0
      ? failurePackage.attempt.changedFiles.join(', ')
      : 'none'}`,
  ]
  if (failurePackage.attempt.patchSummary !== undefined) {
    lines.push(`- Patch summary: ${failurePackage.attempt.patchSummary}`)
  }
  lines.push('')
  lines.push('Verification failures:')
  if (failurePackage.verification.failedCriteria.length > 0) {
    lines.push('Failed acceptance criteria:')
    for (const criterion of failurePackage.verification.failedCriteria) {
      lines.push(`  - ${criterion}`)
    }
  }
  if (failurePackage.verification.failingTests.length > 0) {
    lines.push('Failing tests:')
    for (const test of failurePackage.verification.failingTests) {
      lines.push(`  - ${test}`)
    }
  }
  if (failurePackage.verification.typeErrors.length > 0) {
    lines.push('Type errors:')
    for (const error of failurePackage.verification.typeErrors) {
      lines.push(`  - ${error}`)
    }
  }
  if (failurePackage.verification.buildErrors.length > 0) {
    lines.push('Build errors:')
    for (const error of failurePackage.verification.buildErrors) {
      lines.push(`  - ${error}`)
    }
  }
  lines.push('')
  lines.push(`Failure fingerprint: ${failurePackage.failureFingerprint}`)
  lines.push(`Progress: ${failurePackage.progress}`)
  lines.push('')
  lines.push('You must choose one of:')
  lines.push('1. REPAIR_EXISTING — fix the existing code in the workspace')
  lines.push('2. ROLLBACK_AND_REDO — start fresh and redo the task')
  lines.push('')
  lines.push('Before making any changes, state your decision as either "REPAIR_EXISTING" or "ROLLBACK_AND_REDO" on the first line, then explain briefly, then proceed.')

  return lines.join('\n')
}

/**
 * Extract the takeover decision from Pro's first output line. Returns
 * undefined if the line does not contain a valid decision.
 *
 * @param output - Pro's output text.
 * @returns the parsed decision or undefined.
 */
export function parseTakeoverDecision(output: string): TakeoverDecision | undefined {
  const firstLine = output.trim().split('\n')[0]?.trim().toUpperCase() ?? ''
  if (firstLine.includes('REPAIR_EXISTING')) return 'REPAIR_EXISTING'
  if (firstLine.includes('ROLLBACK_AND_REDO')) return 'ROLLBACK_AND_REDO'
  if (firstLine.includes('REPAIR') && !firstLine.includes('ROLLBACK')) return 'REPAIR_EXISTING'
  if (firstLine.includes('ROLLBACK') && !firstLine.includes('REPAIR')) return 'ROLLBACK_AND_REDO'
  return undefined
}

// ---------------------------------------------------------------------------
// Policy metrics
// ---------------------------------------------------------------------------

/** Aggregated metrics for one policy across all tasks. */
export interface PolicyMetrics {
  readonly policy: PolicyName
  readonly tasks: number
  readonly verifiedTasks: number
  readonly verifiedRate: number
  readonly totalCost: number
  readonly costPerVerifiedTask: number
  readonly proCalls: number
  readonly totalCalls: number
  readonly proUtilization: number
  readonly escalations: number
  readonly escalationRate: number
  readonly successfulRescues: number
  readonly proRescueRate: number
  readonly escalationCostEfficiency: number
  readonly auditableEscalations: number
  readonly auditableEscalationRate: number
  readonly sameFailureDetections: number
  readonly loopViolations: number
  readonly repairExistingChoices: number
  readonly rollbackRedoChoices: number
  readonly medianLatencyMs: number
  readonly p90LatencyMs: number
}

/**
 * Compute aggregated metrics for one policy from task trajectories.
 *
 * @param policy - the policy name.
 * @param trajectories - task trajectories under this policy.
 * @param bounds - loop bounds for violation detection.
 * @returns aggregated policy metrics.
 */
export function computePolicyMetrics(
  policy: PolicyName,
  trajectories: readonly TaskTrajectory[],
  bounds: LoopBounds = DEFAULT_LOOP_BOUNDS,
): PolicyMetrics {
  const tasks = trajectories.length
  const verifiedTasks = trajectories.filter(trajectory => trajectory.verified).length
  const allStages = trajectories.flatMap(trajectory => trajectory.stages)
  const proCalls = allStages.filter(stage => stage.model === 'pro').length
  const totalCalls = allStages.length
  const escalated = trajectories.filter(trajectory => trajectory.escalated)
  const successfulRescues = escalated.filter(trajectory => trajectory.verified).length
  const totalCost = allStages.reduce((sum, stage) => sum + stage.costUsd, 0)
  const escalationCost = escalated
    .flatMap(trajectory => trajectory.stages.filter(stage => stage.model === 'pro'))
    .reduce((sum, stage) => sum + stage.costUsd, 0)
  const auditableEscalations = escalated.filter(trajectory => trajectory.failurePackage !== undefined).length
  const sameFailureDetections = trajectories.filter((trajectory) => {
    const flashFailures = trajectory.stages
      .filter(stage => stage.model === 'flash' && !stage.verified)
    if (flashFailures.length < 2) return false
    for (let index = 1; index < flashFailures.length; index++) {
      const prior = flashFailures[index - 1].failureFingerprint
      const current = flashFailures[index].failureFingerprint
      if (prior !== undefined && current !== undefined && isSameFailure(prior, current)) {
        return true
      }
    }
    return false
  }).length
  const loopViolations = trajectories.filter(
    trajectory => detectLoopViolation(trajectory.stages, bounds) !== undefined,
  ).length
  const repairExistingChoices = trajectories
    .flatMap(trajectory => trajectory.stages)
    .filter(stage => stage.takeoverDecision === 'REPAIR_EXISTING').length
  const rollbackRedoChoices = trajectories
    .flatMap(trajectory => trajectory.stages)
    .filter(stage => stage.takeoverDecision === 'ROLLBACK_AND_REDO').length
  const latencies = trajectories.map(trajectory =>
    trajectory.stages.reduce((sum, stage) => sum + stage.latencyMs, 0),
  )

  return {
    policy,
    tasks,
    verifiedTasks,
    verifiedRate: tasks === 0 ? 0 : verifiedTasks / tasks,
    totalCost,
    costPerVerifiedTask: verifiedTasks === 0 ? Infinity : totalCost / verifiedTasks,
    proCalls,
    totalCalls,
    proUtilization: totalCalls === 0 ? 0 : proCalls / totalCalls,
    escalations: escalated.length,
    escalationRate: tasks === 0 ? 0 : escalated.length / tasks,
    successfulRescues,
    proRescueRate: escalated.length === 0 ? 0 : successfulRescues / escalated.length,
    escalationCostEfficiency: successfulRescues === 0 ? Infinity : escalationCost / successfulRescues,
    auditableEscalations,
    auditableEscalationRate: escalated.length === 0 ? 0 : auditableEscalations / escalated.length,
    sameFailureDetections,
    loopViolations,
    repairExistingChoices,
    rollbackRedoChoices,
    medianLatencyMs: percentile(latencies, 0.5),
    p90LatencyMs: percentile(latencies, 0.9),
  }
}

/** Compute a percentile from a list of values. */
function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(Math.ceil(sorted.length * fraction) - 1, sorted.length - 1)] ?? 0
}
