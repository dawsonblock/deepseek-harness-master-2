import type { KernelEvent, ReconciliationResult, RecoveryPolicyMap, UnmatchedToolCall } from './types.js'
import { asRecord, int, stringValue } from './util.js'

interface CallRecord {
  callId: string
  name: string
  turn: number
  step: number
  seq: number
  /** New-runtime marker: absence means a legacy call with unknown dispatch tracking. */
  dispatchTracked: boolean
  recoveryMode?: 'idempotent' | 'reconcile'
  operationKey?: string
}

/**
 * Pair durable call/dispatch/result records and classify unresolved calls.
 *
 * Compatibility rule: old logs did not emit `tool/dispatch`; an unmatched old
 * `tool/call` therefore remains outcome-unknown. New calls carry
 * `lifecycleVersion: 1`; only those may be classified not-started when no
 * dispatch record exists.
 */
export function findUnmatchedToolCalls(
  events: readonly KernelEvent[],
  policies: RecoveryPolicyMap = {},
): readonly UnmatchedToolCall[] {
  const calls = new Map<string, CallRecord>()
  const dispatched = new Set<string>()
  const results = new Set<string>()

  for (const event of events) {
    const data = asRecord(event.data)
    if (!data) continue
    if (event.type === 'tool/call') {
      const callId = stringValue(data.callId)
      const name = stringValue(data.name)
      const turn = int(data.turn)
      const step = int(data.step)
      if (callId === undefined || name === undefined || turn === undefined || step === undefined) continue
      const recoveryMode = data.recoveryMode === 'idempotent' || data.recoveryMode === 'reconcile'
        ? data.recoveryMode
        : undefined
      const operationKey = stringValue(data.operationKey)
      calls.set(callId, {
        callId, name, turn, step, seq: event.seq,
        dispatchTracked: data.lifecycleVersion === 1,
        ...(recoveryMode === undefined ? {} : { recoveryMode }),
        ...(operationKey === undefined ? {} : { operationKey }),
      })
    } else if (event.type === 'tool/dispatch') {
      const callId = stringValue(data.callId)
      if (callId !== undefined) dispatched.add(callId)
    } else if (event.type === 'tool/result') {
      const callId = toolResultCallId(data)
      if (callId !== undefined) results.add(callId)
    }
  }

  const unresolved: UnmatchedToolCall[] = []
  for (const call of calls.values()) {
    if (results.has(call.callId)) continue
    const didDispatch = dispatched.has(call.callId)
    const state = call.dispatchTracked && !didDispatch ? 'not-started' : 'outcome-unknown'
    const policy = policies[call.name]
    const nativeIdempotent = call.recoveryMode === 'idempotent'
    const nativeReconcile = call.recoveryMode === 'reconcile'
    const safeToRetry = state === 'not-started' || nativeIdempotent || policy?.idempotent === true
    const requiresReconciliation = state === 'outcome-unknown'
      && !safeToRetry
      && (nativeReconcile || typeof policy?.reconcile === 'function')
    unresolved.push({ ...call, state, safeToRetry, requiresReconciliation })
  }
  return unresolved.sort((a, b) => a.seq - b.seq)
}

/** Invoke a deployment-owned external-state reconciler for one ambiguous call. */
export async function reconcileUnmatchedToolCall(
  call: UnmatchedToolCall,
  policies: RecoveryPolicyMap,
): Promise<ReconciliationResult> {
  if (call.state === 'not-started') return { state: 'not-executed', evidence: 'no tool/dispatch record' }
  const reconcile = policies[call.name]?.reconcile
  if (reconcile === undefined) return { state: 'unknown', evidence: 'no reconciliation policy registered' }
  return reconcile(call)
}

function toolResultCallId(data: Record<string, unknown>): string | undefined {
  const message = asRecord(data.message)
  if (!message) return undefined
  const source = asRecord(message.source)
  const direct = source ? stringValue(source.callId) : undefined
  if (direct !== undefined) return direct
  // Structural fallback for older/synthetic fixtures.
  return stringValue(message.callId)
}
