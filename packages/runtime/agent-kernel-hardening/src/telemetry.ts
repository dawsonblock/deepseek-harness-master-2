import type { KernelEvent } from './types.js'
import { asRecord, int, stringValue } from './util.js'

/** Structural projection of the existing dsh-session-telemetry record contract. */
export interface SessionTelemetryRecordLike {
  readonly channel: string
  readonly time: number
  readonly attributes: Record<string, string | number>
  readonly body: unknown
}

/**
 * Reconstruct hardening-analysis events from the canonical session-telemetry
 * ledger stream. This package does not install a second capture pipeline.
 */
export function eventsFromTelemetryRecords(
  records: readonly SessionTelemetryRecordLike[],
  sessionId?: string,
): readonly KernelEvent[] {
  const events: KernelEvent[] = []
  for (const record of records) {
    if (record.channel !== 'ledger') continue
    const recordSession = stringValue(record.attributes['session.id'])
    if (sessionId !== undefined && recordSession !== sessionId) continue
    const type = stringValue(record.attributes['event.type'])
    const seq = int(record.attributes['event.seq'])
    if (type === undefined || seq === undefined) continue
    const envelope = asRecord(record.body)
    // session-telemetry's ledger body is the event.data payload itself.
    events.push({ type, seq, time: record.time, data: envelope ?? record.body })
  }
  return events.sort((left, right) => left.seq - right.seq)
}
