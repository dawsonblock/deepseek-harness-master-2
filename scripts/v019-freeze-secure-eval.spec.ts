/**
 * Tests for the v0.19 secure evaluation freeze record.
 *
 * Verifies that the freeze record correctly captures the qualified state
 * and marks the secure evaluation as ready for real Batch A.
 *
 * @module v019-freeze-secure-eval.spec
 */

import { describe, expect, it } from 'vitest'
import {
  FREEZE_ID,
  formatFreezeRecord,
  generateFreezeRecord,
} from './v019-freeze-secure-eval.ts'

describe('v019 secure evaluation freeze', () => {
  const record = generateFreezeRecord()

  it('uses the correct freeze identity', () => {
    expect(record.freezeId).toBe(FREEZE_ID)
    expect(record.freezeId).toBe('v019-secure-eval-v1')
  })

  it('records a timestamp', () => {
    expect(record.frozenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('references the security qualification gate', () => {
    expect(record.securityQualificationId).toBe('v019-security-qualification-v1')
  })

  it('security qualification passed', () => {
    expect(record.securityQualificationPassed).toBe(true)
  })

  it('all 20 security properties passed', () => {
    expect(record.securityPropertyCount).toBe(20)
    expect(record.securityPassedCount).toBe(20)
    expect(record.securityFailedCount).toBe(0)
  })

  it('B0 smoke test count is 12', () => {
    expect(record.b0SmokeTestCount).toBe(12)
  })

  it('corpus has 25 frozen tasks', () => {
    expect(record.corpusFrozenTasks).toBe(25)
  })

  it('corpus has 0 rejected tasks', () => {
    expect(record.corpusRejectedTasks).toBe(0)
  })

  it('effective composition uses fs-sandbox', () => {
    expect(record.effectiveComposition.filesystemPlane).toBe('fs-sandbox')
  })

  it('effective composition uses bash-sandbox', () => {
    expect(record.effectiveComposition.subprocessPlane).toBe('bash-sandbox')
  })

  it('effective composition uses workspace-isolated policy', () => {
    expect(record.effectiveComposition.sandboxPolicy).toBe('workspace-isolated')
  })

  it('effective composition reports partial Seatbelt enforcement', () => {
    expect(record.effectiveComposition.seatbeltEnforcement).toBe('partial')
  })

  it('effective composition uses external holdouts', () => {
    expect(record.effectiveComposition.holdoutLocation).toBe('external')
  })

  it('effective composition uses production RepairRuntime', () => {
    expect(record.effectiveComposition.repairRuntime).toBe('production')
  })

  it('effective composition uses harness-owned rollback', () => {
    expect(record.effectiveComposition.rollbackProvider).toBe('harness-owned')
  })

  it('effective composition uses SHA-256 provenance', () => {
    expect(record.effectiveComposition.provenanceProvider).toBe('sha256-content-hash')
  })

  it('effective composition uses durable routing authority', () => {
    expect(record.effectiveComposition.routingAuthority).toBe('durable')
  })

  it('freeze record is ready', () => {
    expect(record.ready).toBe(true)
  })

  it('formatFreezeRecord produces a readable report', () => {
    const report = formatFreezeRecord(record)
    expect(report).toContain(FREEZE_ID)
    expect(report).toContain('Ready: YES')
    expect(report).toContain('SECURE EVAL IS FROZEN')
    expect(report).toContain('fs-sandbox')
    expect(report).toContain('bash-sandbox')
    expect(report).toContain('workspace-isolated')
    expect(report).toContain('production')
    expect(report).toContain('durable')
  })
})
