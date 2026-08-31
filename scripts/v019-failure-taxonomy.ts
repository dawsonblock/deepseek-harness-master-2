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
  | 'F19-control-plane-error'

/**
 * Categories that cannot be automatically detected from trajectory evidence
 * alone and require manual review. `classifyFailure` will never return these;
 * they exist in the union so manual classifications can use them.
 */
export const MANUAL_ONLY_CATEGORIES: ReadonlySet<FailureCategory> = new Set([
  'F2-repo-context',
  'F3-wrong-file',
  'F4-verifier-false-negative',
  'F5-verifier-false-positive',
  'F15-ambiguous-task',
  'F16-decomposition',
])

/** Objective facts extracted from the trajectory, separate from diagnostic interpretation. */
export interface FailureObjectiveFacts {
  readonly attempts: number
  readonly flashAttempts: number
  readonly proAttempts: number
  readonly finalVerified: boolean
  readonly terminalOutcome: string
  readonly controlPlaneStatus: string
  readonly modelCapabilityStatus: string
  readonly aborted: boolean
  readonly abortReason: string | undefined
  readonly changedFiles: number
  readonly totalCostUsd: number
  readonly totalLatencyMs: number
  readonly uniqueFailureFingerprints: number
  readonly lastDiagnosticKind: string | undefined
}

export interface FailureClassification {
  readonly taskId: string
  readonly category: FailureCategory
  /** Diagnostic interpretation of the failure. */
  readonly reason: string
  /** Objective facts from the trajectory, separate from the diagnosis. */
  readonly facts: FailureObjectiveFacts
  /** Legacy evidence string for backward compatibility. */
  readonly evidence: string
}

/** Extract objective facts from a trajectory for structured classification. */
function extractObjectiveFacts(t: TaskTrajectory): FailureObjectiveFacts {
  const flashAttempts = t.attempts.filter(a => a.model === 'deepseek-v4-flash').length
  const proAttempts = t.attempts.filter(a => a.model === 'deepseek-v4-pro').length
  const fingerprints = t.attempts
    .map(a => a.failureFingerprint)
    .filter((f): f is string => f !== undefined)
  const uniqueFingerprints = new Set(fingerprints).size
  const lastAttempt = t.attempts.at(-1)
  return {
    attempts: t.attempts.length,
    flashAttempts,
    proAttempts,
    finalVerified: t.finalVerified,
    terminalOutcome: t.terminalOutcome,
    controlPlaneStatus: t.controlPlaneStatus,
    modelCapabilityStatus: t.modelCapabilityStatus,
    aborted: t.aborted,
    abortReason: t.abortReason,
    changedFiles: t.changedFiles.length,
    totalCostUsd: t.totalCostUsd,
    totalLatencyMs: t.totalLatencyMs,
    uniqueFailureFingerprints: uniqueFingerprints,
    lastDiagnosticKind: lastAttempt?.failedKind,
  }
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
  const facts = extractObjectiveFacts(trajectory)
  if (trajectory.controlPlaneStatus === 'NOT_EVALUATED') {
    return {
      taskId: trajectory.taskId,
      category: 'F6-build-environment',
      reason: `Infrastructure failure: ${trajectory.abortReason ?? 'unknown'}`,
      facts,
      evidence: `taskState=${trajectory.taskState}, controlPlaneStatus=NOT_EVALUATED, abortReason=${trajectory.abortReason}`,
    }
  }
  if (trajectory.controlPlaneStatus === 'FAIL') {
    return classifyControlPlaneFailure(trajectory, facts)
  }
  return classifyModelFailure(trajectory, facts)
}

function classifyControlPlaneFailure(t: TaskTrajectory, facts: FailureObjectiveFacts): FailureClassification {
  // Explicit terminal-outcome mappings. Do not force every runtime failure
  // into F13/F14 — different control-plane failures have different root
  // causes and require different architectural responses.
  switch (t.terminalOutcome) {
    case 'rollback-failed':
      return {
        taskId: t.taskId,
        category: 'F13-rollback',
        reason: `Rollback failed: ${t.abortReason ?? 'unknown'}`,
        facts,
        evidence: `terminalOutcome=rollback-failed, abortReason=${t.abortReason ?? 'undefined'}`,
      }
    case 'model-unavailable':
      return {
        taskId: t.taskId,
        category: 'F14-provider-failure',
        reason: `Provider unavailable: ${t.abortReason ?? t.terminalOutcome}`,
        facts,
        evidence: `terminalOutcome=${t.terminalOutcome}, abortReason=${t.abortReason ?? 'undefined'}`,
      }
    case 'authority-undecidable':
    case 'repair-handler-error':
      return {
        taskId: t.taskId,
        category: 'F19-control-plane-error',
        reason: `Control-plane error: ${t.abortReason ?? t.terminalOutcome}`,
        facts,
        evidence: `terminalOutcome=${t.terminalOutcome}, abortReason=${t.abortReason ?? 'undefined'}`,
      }
    default:
      return {
        taskId: t.taskId,
        category: 'F19-control-plane-error',
        reason: `Unclassified control-plane failure: ${t.abortReason ?? t.terminalOutcome}`,
        facts,
        evidence: `controlPlaneStatus=FAIL, terminalOutcome=${t.terminalOutcome}, aborted=${t.aborted}, abortReason=${t.abortReason ?? 'undefined'}`,
      }
  }
}

function classifyModelFailure(t: TaskTrajectory, facts: FailureObjectiveFacts): FailureClassification {
  const lastAttempt = t.attempts.at(-1)
  const flashAttempts = t.attempts.filter(a => a.model === 'deepseek-v4-flash')
  const proAttempts = t.attempts.filter(a => a.model === 'deepseek-v4-pro')

  // F18: holdout edge-case failure (diagnostic PASS, holdout FAIL)
  if (lastAttempt !== undefined && lastAttempt.diagnosticPass && lastAttempt.holdoutPass === false) {
    return {
      taskId: t.taskId,
      category: 'F18-holdout-edge-case',
      reason: 'Diagnostic passed but unseen holdout detected an edge case',
      facts,
      evidence: `diagnosticPass=true, holdoutPass=false, attempts=${t.attempts.length}`,
    }
  }

  // F12: timeout/latency — task hit a time limit without completing.
  // Detected from terminalOutcome or abort reason containing timeout.
  if (t.terminalOutcome === 'timeout' || (t.abortReason !== undefined && /timeout|timed out|deadline/i.test(t.abortReason))) {
    return {
      taskId: t.taskId,
      category: 'F12-timeout-latency',
      reason: `Task timed out: ${t.abortReason ?? 'terminalOutcome=timeout'}`,
      facts,
      evidence: `terminalOutcome=${t.terminalOutcome}, latency=${t.totalLatencyMs}ms, abortReason=${t.abortReason ?? 'undefined'}`,
    }
  }

  // F11: budget exhaustion
  if (t.terminalOutcome === 'budget-stop') {
    return {
      taskId: t.taskId,
      category: 'F11-budget-exhaustion',
      reason: 'Task stopped due to budget limit (cost, time, or token)',
      facts,
      evidence: `terminalOutcome=budget-stop, cost=$${t.totalCostUsd.toFixed(6)}, latency=${t.totalLatencyMs}ms`,
    }
  }

  // F9: premature escalation (Pro called after only 1 Flash attempt)
  if (proAttempts.length > 0 && flashAttempts.length === 1) {
    return {
      taskId: t.taskId,
      category: 'F9-premature-escalation',
      reason: 'Escalated to Pro after only 1 Flash attempt without trying Flash repair',
      facts,
      evidence: `flashAttempts=${flashAttempts.length}, proAttempts=${proAttempts.length}`,
    }
  }

  // F10: insufficient escalation (Flash exhausted all attempts, Pro never called)
  if (proAttempts.length === 0 && flashAttempts.length >= 3 && !t.finalVerified) {
    return {
      taskId: t.taskId,
      category: 'F10-insufficient-escalation',
      reason: 'Flash exhausted all attempts without success, Pro was not called',
      facts,
      evidence: `flashAttempts=${flashAttempts.length}, proAttempts=0`,
    }
  }

  // F8: repair evidence inadequate (same failure fingerprint across
  // attempts). Check before F1/F17 because a repeated fingerprint is
  // more informative than "made changes but still fails" — it indicates
  // the repair evidence did not help the model make progress.
  const fingerprints = t.attempts
    .map(a => a.failureFingerprint)
    .filter((f): f is string => f !== undefined)
  if (fingerprints.length > 1 && new Set(fingerprints).size === 1) {
    return {
      taskId: t.taskId,
      category: 'F8-repair-evidence',
      reason: 'Same failure fingerprint across multiple attempts — repair evidence did not help',
      facts,
      evidence: `fingerprints=${fingerprints.length}, unique=${new Set(fingerprints).size}`,
    }
  }

  // F2/F3 are manual-only: reference fix files are forensic evidence,
  // not grading authority. A valid alternative solution can touch
  // completely different files from the historical maintainer patch.
  // See MANUAL_ONLY_CATEGORIES above.

  // F7: dependency — model's changes reference missing imports or
  // modules. Detected from actual error evidence (failedCriteria,
  // failingTests, typeErrors, buildErrors), not from ProgressClass
  // which only emits none/partial/regression/resolved.
  const errorEvidence = t.attempts
    .flatMap(a => [...a.failedCriteria, ...a.failingTests, ...a.typeErrors, ...a.buildErrors])
    .join('\n')
  const depErrorPattern = /cannot find module|module not found|unresolved dependency|npm error|pnpm error|package not found/i
  if (depErrorPattern.test(errorEvidence)) {
    return {
      taskId: t.taskId,
      category: 'F7-dependency',
      reason: 'Dependency resolution failure detected in error evidence',
      facts,
      evidence: `errorEvidenceMatch=dependency-error, attempts=${t.attempts.length}, changedFiles=${t.changedFiles.length}`,
    }
  }

  // F1: model reasoning failure (all attempts failed, no changes produced)
  const allFailed = t.attempts.every(a => !a.verified)
  if (allFailed && t.changedFiles.length === 0) {
    return {
      taskId: t.taskId,
      category: 'F1-model-reasoning',
      reason: 'Model produced no valid changes across all attempts',
      facts,
      evidence: `attempts=${t.attempts.length}, changedFiles=0`,
    }
  }

  // F17: cross-file consistency (made changes but verification still fails)
  if (allFailed && t.changedFiles.length > 0) {
    return {
      taskId: t.taskId,
      category: 'F17-cross-file-consistency',
      reason: 'Model made changes but verification still fails — likely missed a dependent file',
      facts,
      evidence: `attempts=${t.attempts.length}, changedFiles=${t.changedFiles.length}`,
    }
  }

  // F1: default model reasoning failure
  return {
    taskId: t.taskId,
    category: 'F1-model-reasoning',
    reason: 'Model failed to solve the task across all attempts',
    facts,
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
