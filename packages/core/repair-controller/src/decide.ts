/**
 * Pure repair decision logic. No model calls, no file mutations, no event
 * writes, no verification. The {@link decideRepair} function is deterministic
 * given its inputs.
 *
 * First runtime policy (v0.18):
 *
 * Flash #1 → verify
 *   pass → complete
 *   fail → Flash #2 with evidence
 * Flash #2 → verify
 *   pass → complete
 *   fail + same/no-progress → Pro
 *   fail + progress → Flash #3
 * Flash #3 → verify
 *   pass → complete
 *   fail → Pro
 * Pro #1 → verify
 *   pass → complete
 *   fail → Pro #2
 * Pro #2 → verify
 *   fail → stop (pro-exhausted)
 *
 * Hard limits are runtime-owned: max 3 Flash, 2 Pro, 5 total.
 *
 * @module @deepseek-ai/dsh-repair-controller/decide
 */

import { createHash } from 'node:crypto'
import type {
  FailurePackage,
  ProgressClass,
  ProgressMetrics,
  ProviderFailure,
  ProviderFailureKind,
  RepairDecision,
  RepairDecisionInput,
  RepairLimits,
} from './types.ts'
import { DEFAULT_REPAIR_LIMITS } from './types.ts'

/**
 * Normalize one failure text line for fingerprinting. Strips absolute file
 * paths, line:col positions, timing, and collapses whitespace.
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
 * the same fingerprint.
 */
export function computeFailureFingerprint(evidence: FailurePackage): string {
  const parts = [
    ...evidence.failedCriteria.map(normalizeFailureText).sort(),
    ...evidence.failingTests.map(normalizeFailureText).sort(),
    ...evidence.typeErrors.map(normalizeFailureText).sort(),
    ...evidence.buildErrors.map(normalizeFailureText).sort(),
  ]
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16)
}

/** Count total failure items across all evidence categories. */
export function countFailures(evidence: FailurePackage): number {
  return evidence.failedCriteria.length
    + evidence.failingTests.length
    + evidence.typeErrors.length
    + evidence.buildErrors.length
}

/**
 * Classify progress of a failed attempt relative to the prior failed attempt.
 * Returns `none` for the first failure or same substantive failure, `partial`
 * when fewer or different failures remain, `regression` when more failures
 * appeared, and `resolved` when no failures remain.
 */
export function classifyProgress(
  priorEvidence: FailurePackage | undefined,
  currentEvidence: FailurePackage,
): ProgressClass {
  if (priorEvidence === undefined) return 'none'
  const priorCount = countFailures(priorEvidence)
  const currentCount = countFailures(currentEvidence)
  if (currentCount === 0) return 'resolved'
  if (currentCount > priorCount) return 'regression'
  if (currentCount < priorCount) return 'partial'
  if (computeFailureFingerprint(priorEvidence) === computeFailureFingerprint(currentEvidence)) {
    return 'none'
  }
  return 'partial'
}

/** Whether two fingerprints represent the same substantive failure. */
export function isSameFailure(priorFingerprint: string, currentFingerprint: string): boolean {
  return priorFingerprint === currentFingerprint
}

/**
 * Compute a deterministic failure-package ID from the session, turn, and
 * originating routing decision. This ID is stable across crashes and
 * restarts, enabling idempotent event emission.
 */
export function computeFailurePackageId(
  sessionId: string,
  turn: number,
  routingDecisionId: string,
): string {
  return createHash('sha256')
    .update(`${sessionId}:${turn}:${routingDecisionId}`)
    .digest('hex')
    .slice(0, 16)
}

/**
 * Compute quantitative progress metrics between two failure packages.
 * Stores the underlying numbers so repair decisions can be debugged
 * later without re-running the model.
 */
export function computeProgressMetrics(
  prior: FailurePackage,
  current: FailurePackage,
): ProgressMetrics {
  const priorItems = new Set([
    ...prior.failedCriteria.map(normalizeFailureText),
    ...prior.failingTests.map(normalizeFailureText),
    ...prior.typeErrors.map(normalizeFailureText),
    ...prior.buildErrors.map(normalizeFailureText),
  ])
  const currentItems = new Set([
    ...current.failedCriteria.map(normalizeFailureText),
    ...current.failingTests.map(normalizeFailureText),
    ...current.typeErrors.map(normalizeFailureText),
    ...current.buildErrors.map(normalizeFailureText),
  ])
  const intersection = [...priorItems].filter(x => currentItems.has(x)).length
  const union = new Set([...priorItems, ...currentItems]).size
  const resolvedFailureCount = [...priorItems].filter(x => !currentItems.has(x)).length
  const newFailureCount = [...currentItems].filter(x => !priorItems.has(x)).length
  return {
    priorFailureCount: priorItems.size,
    currentFailureCount: currentItems.size,
    intersectionCount: intersection,
    unionCount: union,
    jaccard: union > 0 ? intersection / union : 1,
    newFailureCount,
    resolvedFailureCount,
  }
}

/**
 * Classify a raw provider error into a canonical {@link ProviderFailure}.
 * Maps HTTP status codes and common error patterns to failure kinds and
 * retryability. Abort-worthy failures (authentication, authorization,
 * billing, invalid-request) are never retryable. Server errors, rate
 * limits, timeouts, and network errors are retryable.
 *
 * @param provider - the provider name (e.g. `'deepseek'`).
 * @param error - the raw error: HTTP status, code, message, and optional model/request ID.
 * @returns a canonical provider failure with `retryable` set.
 */
export function classifyProviderFailure(
  provider: string,
  error: {
    httpStatus?: number
    providerCode?: string
    message: string
    model?: string
    requestId?: string
  },
): ProviderFailure {
  const { httpStatus, message } = error
  let kind: ProviderFailureKind
  let retryable: boolean

  if (httpStatus === 401) {
    kind = 'authentication'
    retryable = false
  } else if (httpStatus === 403) {
    kind = 'authorization'
    retryable = false
  } else if (httpStatus === 400 || httpStatus === 402) {
    kind = httpStatus === 400 ? 'invalid-request' : 'billing'
    retryable = false
  } else if (httpStatus === 429) {
    kind = 'rate-limit'
    retryable = true
  } else if (httpStatus !== undefined && httpStatus >= 500) {
    kind = 'server'
    retryable = true
  } else if (httpStatus !== undefined && httpStatus >= 404) {
    kind = 'invalid-request'
    retryable = false
  } else if (/timeout|timed out|etimedout/i.test(message)) {
    kind = 'timeout'
    retryable = true
  } else if (/econnreset|econnrefused|enotfound|eai_again|network|fetch failed/i.test(message)) {
    kind = 'network'
    retryable = true
  } else if (/empty|no content|no output|no assistant/i.test(message)) {
    kind = 'empty-response'
    retryable = false
  } else if (/protocol|invalid response|parse error|json/i.test(message)) {
    kind = 'protocol'
    retryable = false
  } else {
    kind = 'unknown'
    retryable = false
  }

  return {
    provider,
    ...(error.model !== undefined ? { model: error.model } : {}),
    kind,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(error.providerCode !== undefined ? { providerCode: error.providerCode } : {}),
    retryable,
    ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
    message,
  }
}

type ModelLike = { readonly provider: string; readonly model: string }

/** Whether the model ref is the Flash tier. */
function isFlash(model: ModelLike, flash: ModelLike): boolean {
  return model.provider === flash.provider && model.model === flash.model
}

/** Whether the model ref is the Pro tier. */
function isPro(model: ModelLike, pro: ModelLike): boolean {
  return model.provider === pro.provider && model.model === pro.model
}

/**
 * Decide the next repair action after a verification result. Pure and
 * deterministic: same inputs always produce the same decision.
 *
 * Decision priority: hard policy → budget → attempt limits → repair logic.
 *
 * The policy follows the v0.18 verified-escalation rules:
 * 1. If the last attempt passed, complete.
 * 2. If the cost budget is exceeded, stop (cost-limit).
 * 3. If the time budget is exceeded, stop (time-limit).
 * 4. If the total attempt limit is reached, stop.
 * 5. If the last Flash failure repeats the prior Flash failure (same
 *    fingerprint or no progress), escalate to Pro.
 * 6. If Flash attempts remain and there is progress, allow another Flash
 *    repair.
 * 7. If Flash attempts are exhausted, escalate to Pro.
 * 8. If Pro attempts are exhausted or Pro is unavailable, stop.
 *
 * Manual model selection is respected: if the user manually selected a
 * model, the controller does not escalate to a different model unless
 * the policy explicitly requires it.
 *
 * @param input - repair decision input with attempt history and limits.
 * @returns the next action: complete, flash-repair, pro-escalate, or stop.
 */
export function decideRepair(input: RepairDecisionInput): RepairDecision {
  const { attempts, latestFailure, limits, budget } = input

  if (attempts.length === 0) {
    return { action: 'stop', reason: 'verification-impossible' }
  }

  const lastAttempt = attempts.at(-1)
  if (lastAttempt === undefined) {
    return { action: 'stop', reason: 'verification-impossible' }
  }

  // Rule 1: last attempt passed → complete
  if (lastAttempt.verified) {
    return { action: 'complete' }
  }

  // Rule 2: cost budget exceeded → stop
  if (limits.maxTaskCostUsd !== undefined && budget.totalCostUsd >= limits.maxTaskCostUsd) {
    return { action: 'stop', reason: 'cost-limit' }
  }

  // Rule 3: time budget exceeded → stop
  if (limits.maxElapsedMs !== undefined && budget.elapsedMs >= limits.maxElapsedMs) {
    return { action: 'stop', reason: 'time-limit' }
  }

  // Rule 4: total attempt limit reached → stop
  if (attempts.length >= limits.maxTotalAttempts) {
    return { action: 'stop', reason: 'attempt-limit' }
  }

  if (latestFailure === undefined) {
    return { action: 'stop', reason: 'verification-impossible' }
  }

  const flashAttempts = attempts.filter(a => isFlash(a.model, input.initialModel))
  const proAttempts = attempts.filter(a => isPro(a.model, input.currentModel) && !isFlash(a.model, input.initialModel))
  const lastIsFlash = isFlash(lastAttempt.model, input.initialModel)
  const proAvailable = input.proModelAvailable ?? true

  if (lastIsFlash) {
    // Rule 5: two consecutive Flash failures with same/no progress → Pro
    const flashFailures = flashAttempts.filter(a => !a.verified)
    if (flashFailures.length >= 2) {
      const prior = flashFailures.at(-2)
      const current = flashFailures.at(-1)
      if (prior?.failureFingerprint !== undefined && current?.failureFingerprint !== undefined) {
        if (isSameFailure(prior.failureFingerprint, current.failureFingerprint)) {
          if (proAvailable && proAttempts.length < limits.maxProAttempts) {
            return { action: 'pro-escalate', evidence: latestFailure, reason: 'same-failure-no-progress' }
          }
          if (!proAvailable) return { action: 'stop', reason: 'escalation-model-unavailable' }
          return { action: 'stop', reason: 'pro-exhausted' }
        }
      }
      if (current?.progress === 'none' || current?.progress === 'regression') {
        if (proAvailable && proAttempts.length < limits.maxProAttempts) {
          return { action: 'pro-escalate', evidence: latestFailure, reason: current.progress === 'regression' ? 'regression-detected' : 'same-failure-no-progress' }
        }
        if (!proAvailable) return { action: 'stop', reason: 'escalation-model-unavailable' }
        return { action: 'stop', reason: 'pro-exhausted' }
      }
    }

    // Rule 6: Flash attempts remain and there is progress → Flash repair
    if (flashAttempts.length < limits.maxFlashAttempts) {
      return { action: 'flash-repair', evidence: latestFailure }
    }

    // Rule 7: Flash exhausted → Pro
    if (proAvailable && proAttempts.length < limits.maxProAttempts) {
      return { action: 'pro-escalate', evidence: latestFailure, reason: 'flash-limit-exhausted' }
    }
    if (!proAvailable) return { action: 'stop', reason: 'escalation-model-unavailable' }

    return { action: 'stop', reason: 'pro-exhausted' }
  }

  // Last attempt was Pro
  if (proAttempts.length < limits.maxProAttempts) {
    // Pro repair: allow one more Pro attempt
    return { action: 'pro-escalate', evidence: latestFailure, reason: 'flash-limit-exhausted' }
  }

  // Rule 8: Pro exhausted → stop
  return { action: 'stop', reason: 'pro-exhausted' }
}

export { DEFAULT_REPAIR_LIMITS }
export type { RepairLimits }
