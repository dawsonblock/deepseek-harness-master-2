import type { KernelEvent } from './types.js'
import { asRecord, fingerprint } from './util.js'

export interface HeaderEpoch {
  readonly seq: number
  readonly fingerprint: string
  readonly reason?: string
}

export interface RequestPrefixSample {
  readonly seq: number
  readonly headerFingerprint: string | null
}

export interface CacheStabilityReport {
  readonly epochs: readonly HeaderEpoch[]
  readonly requests: readonly RequestPrefixSample[]
  readonly headerCount: number
  readonly headerChanges: number
  readonly requestCount: number
  readonly stableTransitions: number
  readonly changedTransitions: number
  /** Null for old logs that contain no per-request lifecycle events. */
  readonly stabilityRatio: number | null
}

/**
 * Derive request-prefix stability over ACTUAL model dispatches.
 *
 * `request/header` is epoch-based and intentionally sparse, so header-event
 * counts are never used as the request denominator. New runtimes emit the
 * ignorable `model/request` record immediately before every model dispatch.
 * Older logs correctly report `stabilityRatio: null` rather than inventing a
 * misleading estimate.
 */
export function analyzeHeaderStability(events: readonly KernelEvent[]): CacheStabilityReport {
  const epochs: HeaderEpoch[] = []
  const requests: RequestPrefixSample[] = []
  let currentHeader: string | null = null
  let previousHeaderEvent: string | undefined
  let headerChanges = 0

  for (const event of events) {
    if (event.type === 'request/header') {
      const data = asRecord(event.data)
      if (!data || data.header === undefined) continue
      const fp = fingerprint(data.header)
      const reason = typeof data.reason === 'string' ? data.reason : undefined
      epochs.push(reason === undefined
        ? { seq: event.seq, fingerprint: fp }
        : { seq: event.seq, fingerprint: fp, reason })
      if (previousHeaderEvent !== undefined && previousHeaderEvent !== fp) headerChanges += 1
      previousHeaderEvent = fp
      currentHeader = fp
      continue
    }
    if (event.type === 'model/request') {
      requests.push({ seq: event.seq, headerFingerprint: currentHeader })
    }
  }

  let stableTransitions = 0
  let changedTransitions = 0
  for (let i = 1; i < requests.length; i += 1) {
    const previous = requests[i - 1]?.headerFingerprint
    const current = requests[i]?.headerFingerprint
    // Missing a preceding header means the log cannot establish prefix identity.
    if (previous === null || current === null || previous === undefined || current === undefined) continue
    if (previous === current) stableTransitions += 1
    else changedTransitions += 1
  }
  const measuredTransitions = stableTransitions + changedTransitions
  return {
    epochs,
    requests,
    headerCount: epochs.length,
    headerChanges,
    requestCount: requests.length,
    stableTransitions,
    changedTransitions,
    stabilityRatio: measuredTransitions === 0 ? null : stableTransitions / measuredTransitions,
  }
}
