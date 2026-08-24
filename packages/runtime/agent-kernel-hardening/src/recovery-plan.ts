import type { KernelEvent } from './types.js'
import { asRecord, int, stringValue } from './util.js'

export type RecoveryDisposition = 'clean' | 'retryable' | 'blocked'

export interface RecoveryPlanCall {
  readonly callId: string
  readonly name: string
  readonly operationKey?: string
}

export interface RecoveryPlan {
  readonly receiptSeq: number
  readonly repairedTurn: number
  readonly repairedStep?: number
  readonly checkpointSeq?: number
  readonly checkpointBasisSeq?: number
  readonly tailStartSeq: number
  readonly tailEventCount: number
  readonly disposition: RecoveryDisposition
  readonly canAutoResume: boolean
  readonly notStartedCalls: readonly RecoveryPlanCall[]
  readonly retrySafeCalls: readonly RecoveryPlanCall[]
  readonly reconciliationRequiredCalls: readonly RecoveryPlanCall[]
  readonly legacyAmbiguousCalls: readonly RecoveryPlanCall[]
}

function calls(value: unknown): RecoveryPlanCall[] {
  if (!Array.isArray(value)) return []
  const output: RecoveryPlanCall[] = []
  for (const candidate of value) {
    const row = asRecord(candidate)
    const callId = row ? stringValue(row.callId) : undefined
    const name = row ? stringValue(row.name) : undefined
    if (callId === undefined || name === undefined) continue
    const operationKey = stringValue(row?.operationKey)
    output.push({ callId, name, ...(operationKey === undefined ? {} : { operationKey }) })
  }
  return output
}

/**
 * Project the newest durable `session/recovery` receipt into an operator-facing
 * resume plan. This function never guesses from human-readable synthetic tool
 * errors: it consumes the machine-readable repair receipt only.
 */
export function deriveLatestRecoveryPlan(events: readonly KernelEvent[]): RecoveryPlan | null {
  const receipt = [...events].reverse().find(event => event.type === 'session/recovery')
  if (receipt === undefined) return null
  const data = asRecord(receipt.data)
  if (data === undefined || int(data.version) !== 1) return null

  const repairedTurn = int(data.repairedTurn)
  const tailStartSeq = int(data.tailStartSeq)
  const tailEventCount = int(data.tailEventCount)
  if (repairedTurn === undefined || tailStartSeq === undefined || tailEventCount === undefined) return null

  const notStartedCalls = calls(data.notStartedCalls)
  const retrySafeCalls = calls(data.retrySafeCalls)
  const reconciliationRequiredCalls = calls(data.reconciliationRequiredCalls)
  const legacyAmbiguousCalls = calls(data.legacyAmbiguousCalls)

  const blocked = reconciliationRequiredCalls.length > 0 || legacyAmbiguousCalls.length > 0
  const retryable = notStartedCalls.length > 0 || retrySafeCalls.length > 0
  const disposition: RecoveryDisposition = blocked ? 'blocked' : retryable ? 'retryable' : 'clean'

  const repairedStep = int(data.repairedStep)
  const checkpointSeq = int(data.checkpointSeq)
  const checkpointBasisSeq = int(data.checkpointBasisSeq)
  return {
    receiptSeq: receipt.seq,
    repairedTurn,
    ...(repairedStep === undefined ? {} : { repairedStep }),
    ...(checkpointSeq === undefined ? {} : { checkpointSeq }),
    ...(checkpointBasisSeq === undefined ? {} : { checkpointBasisSeq }),
    tailStartSeq,
    tailEventCount,
    disposition,
    canAutoResume: !blocked,
    notStartedCalls,
    retrySafeCalls,
    reconciliationRequiredCalls,
    legacyAmbiguousCalls,
  }
}
