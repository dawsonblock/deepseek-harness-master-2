/**
 * v0.19 failure taxonomy classifier.
 *
 * Classifies every failed task into one of 18 failure categories (F1-F18)
 * based on trajectory evidence. The taxonomy determines which architectural
 * changes v0.19 should target.
 *
 * @module v019-failure-taxonomy
 */

import type { TaskTrajectory } from './v019-trajectory-collector.ts'

/** Failure category codes from the v0.19 evaluation plan. */
export type FailureCategory =
  | 'F1-model-reasoning'
  | 'F2-repo-context'
  | 'F3-wrong-file'
  | 'F4-verifier-false-negative'
  | 'F5-verifier-false-positive'
  | 'F6-build-environment'
  | 'F7-dependency'
  | 'F8-repair-evidence'
  | 'F9-premature-escalation'
  | 'F10-insufficient-escalation'
  | 'F11-budget-exhaustion'
  | 'F12-timeout-latency'
  | 'F13-rollback'
  | 'F14-provider-failure'
  | 'F15-ambiguous-task'
  | 'F16-decomposition'
  | 'F17-cross-file-consistency'
  | 'F18-holdout-edge-case'

export interface FailureClassification {
  readonly taskId: string
  readonly category: FailureCategory
  readonly reason: string
  readonly evidence: string
}

/**
 * Classify a failed task trajectory into a failure category.
 *
 * Classification is based on trajectory evidence: attempt patterns,
 * verification results, abort reasons, changed files, and terminal outcomes.
 * Manual review may override the automatic classification.
 */
export function classifyFailure(trajectory: TaskTrajectory): FailureClassification | undefined {
  if (trajectory.finalVerified) return undefined
  if (trajectory.controlPlaneStatus === 'NOT_EVALUATED') {
    return {
      taskId: trajectory.taskId,
      category: 'F6-build-environment',
      reason: `Infrastructure failure: ${trajectory.abortReason ?? 'unknown'}`,
      evidence: `taskState=${trajectory.taskState}, controlPlaneStatus=NOT_EVALUATED, abortReason=${trajectory.abortReason}`,
    }
  }
  if (trajectory.controlPlaneStatus === 'FAIL') {
    return classifyControlPlaneFailure(trajectory)
  }
  return classifyModelFailure(trajectory)
}

function classifyControlPlaneFailure(t: TaskTrajectory): FailureClassification {
  if (t.aborted && t.abortReason !== undefined) {
    return {
      taskId: t.taskId,
      category: 'F14-provider-failure',
      reason: `Provider failure: ${t.abortReason}`,
      evidence: `aborted=true, abortReason=${t.abortReason}`,
    }
  }
  return {
    taskId: t.taskId,
    category: 'F13-rollback',
    reason: 'Control plane failure without provider abort',
    evidence: `controlPlaneStatus=FAIL, aborted=${t.aborted}`,
  }
}

function classifyModelFailure(t: TaskTrajectory): FailureClassification {
  const lastAttempt = t.attempts.at(-1)
  const flashAttempts = t.attempts.filter(a => a.model === 'deepseek-v4-flash')
  const proAttempts = t.attempts.filter(a => a.model === 'deepseek-v4-pro')

  // F18: holdout edge-case failure (diagnostic PASS, holdout FAIL)
  if (lastAttempt?.diagnosticPass === true && lastAttempt?.holdoutPass === false) {
    return {
      taskId: t.taskId,
      category: 'F18-holdout-edge-case',
      reason: 'Diagnostic passed but unseen holdout detected an edge case',
      evidence: `diagnosticPass=true, holdoutPass=false, attempts=${t.attempts.length}`,
    }
  }

  // F11: budget exhaustion
  if (t.terminalOutcome === 'budget-stop') {
    return {
      taskId: t.taskId,
      category: 'F11-budget-exhaustion',
      reason: 'Task stopped due to budget limit (cost, time, or token)',
      evidence: `terminalOutcome=budget-stop, cost=$${t.totalCostUsd.toFixed(6)}, latency=${t.totalLatencyMs}ms`,
    }
  }

  // F9: premature escalation (Pro called after only 1 Flash attempt)
  if (proAttempts.length > 0 && flashAttempts.length === 1) {
    return {
      taskId: t.taskId,
      category: 'F9-premature-escalation',
      reason: 'Escalated to Pro after only 1 Flash attempt without trying Flash repair',
      evidence: `flashAttempts=${flashAttempts.length}, proAttempts=${proAttempts.length}`,
    }
  }

  // F10: insufficient escalation (Flash exhausted all attempts, Pro never called)
  if (proAttempts.length === 0 && flashAttempts.length >= 3 && !t.finalVerified) {
    return {
      taskId: t.taskId,
      category: 'F10-insufficient-escalation',
      reason: 'Flash exhausted all attempts without success, Pro was not called',
      evidence: `flashAttempts=${flashAttempts.length}, proAttempts=0`,
    }
  }

  // F1: model reasoning failure (all attempts failed, no specific pattern)
  const allFailed = t.attempts.every(a => !a.verified)
  if (allFailed && t.changedFiles.length === 0) {
    return {
      taskId: t.taskId,
      category: 'F1-model-reasoning',
      reason: 'Model produced no valid changes across all attempts',
      evidence: `attempts=${t.attempts.length}, changedFiles=0`,
    }
  }

  // F17: cross-file consistency (made changes but verification still fails)
  if (allFailed && t.changedFiles.length > 0) {
    return {
      taskId: t.taskId,
      category: 'F17-cross-file-consistency',
      reason: 'Model made changes but verification still fails — likely missed a dependent file',
      evidence: `attempts=${t.attempts.length}, changedFiles=${t.changedFiles.length}`,
    }
  }

  // F8: repair evidence inadequate (same failure fingerprint across attempts)
  const fingerprints = t.attempts
    .map(a => a.failureFingerprint)
    .filter(f => f !== undefined) as string[]
  if (fingerprints.length > 1 && new Set(fingerprints).size === 1) {
    return {
      taskId: t.taskId,
      category: 'F8-repair-evidence',
      reason: 'Same failure fingerprint across multiple attempts — repair evidence did not help',
      evidence: `fingerprints=${fingerprints.length}, unique=${new Set(fingerprints).size}`,
    }
  }

  // F1: default model reasoning failure
  return {
    taskId: t.taskId,
    category: 'F1-model-reasoning',
    reason: 'Model failed to solve the task across all attempts',
    evidence: `attempts=${t.attempts.length}, flashAttempts=${flashAttempts.length}, proAttempts=${proAttempts.length}`,
  }
}

/** Classify all failed trajectories in a cohort. */
export function classifyAllFailures(trajectories: readonly TaskTrajectory[]): FailureClassification[] {
  return trajectories
    .map(t => classifyFailure(t))
    .filter((c): c is FailureClassification => c !== undefined)
}

/** Count failures by category. */
export function failureCategorySummary(classifications: readonly FailureClassification[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const c of classifications) {
    counts[c.category] = (counts[c.category] ?? 0) + 1
  }
  return counts
}
