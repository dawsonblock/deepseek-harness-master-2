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
  } else if (httpStatus === 400) {
    kind = 'invalid-request'
    retryable = false
  } else if (httpStatus === 402) {
    kind = 'billing'
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
 * The policy follows the v0.18 verified-escalation rules:
 * 1. If the last attempt passed, complete.
 * 2. If the total attempt limit is reached, stop.
 * 3. If the last Flash failure repeats the prior Flash failure (same
 *    fingerprint or no progress), escalate to Pro.
 * 4. If Flash attempts remain and there is progress, allow another Flash
 *    repair.
 * 5. If Flash attempts are exhausted, escalate to Pro.
 * 6. If Pro attempts are exhausted, stop.
 *
 * @param input - repair decision input with attempt history and limits.
 * @returns the next action: complete, flash-repair, pro-escalate, or stop.
 */
export function decideRepair(input: RepairDecisionInput): RepairDecision {
  const { attempts, latestFailure, limits } = input

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

  // Rule 2: total attempt limit reached → stop
  if (attempts.length >= limits.maxTotalAttempts) {
    return { action: 'stop', reason: 'attempt-limit' }
  }

  if (latestFailure === undefined) {
    return { action: 'stop', reason: 'verification-impossible' }
  }

  const flashAttempts = attempts.filter(a => isFlash(a.model, input.initialModel))
  const proAttempts = attempts.filter(a => isPro(a.model, input.currentModel) && !isFlash(a.model, input.initialModel))
  const lastIsFlash = isFlash(lastAttempt.model, input.initialModel)

  if (lastIsFlash) {
    // Rule 3: two consecutive Flash failures with same/no progress → Pro
    const flashFailures = flashAttempts.filter(a => !a.verified)
    if (flashFailures.length >= 2) {
      const prior = flashFailures.at(-2)
      const current = flashFailures.at(-1)
      if (prior?.failureFingerprint !== undefined && current?.failureFingerprint !== undefined) {
        if (isSameFailure(prior.failureFingerprint, current.failureFingerprint)) {
          if (proAttempts.length < limits.maxProAttempts) {
            return { action: 'pro-escalate', evidence: latestFailure, reason: 'same-failure-no-progress' }
          }
          return { action: 'stop', reason: 'pro-exhausted' }
        }
      }
      if (current?.progress === 'none' || current?.progress === 'regression') {
        if (proAttempts.length < limits.maxProAttempts) {
          return { action: 'pro-escalate', evidence: latestFailure, reason: current.progress === 'regression' ? 'regression-detected' : 'same-failure-no-progress' }
        }
        return { action: 'stop', reason: 'pro-exhausted' }
      }
    }

    // Rule 4: Flash attempts remain and there is progress → Flash repair
    if (flashAttempts.length < limits.maxFlashAttempts) {
      return { action: 'flash-repair', evidence: latestFailure }
    }

    // Rule 5: Flash exhausted → Pro
    if (proAttempts.length < limits.maxProAttempts) {
      return { action: 'pro-escalate', evidence: latestFailure, reason: 'flash-limit-exhausted' }
    }

    return { action: 'stop', reason: 'pro-exhausted' }
  }

  // Last attempt was Pro
  if (proAttempts.length < limits.maxProAttempts) {
    // Pro repair: allow one more Pro attempt
    return { action: 'pro-escalate', evidence: latestFailure, reason: 'flash-limit-exhausted' }
  }

  // Rule 6: Pro exhausted → stop
  return { action: 'stop', reason: 'pro-exhausted' }
}

export { DEFAULT_REPAIR_LIMITS }
export type { RepairLimits }
