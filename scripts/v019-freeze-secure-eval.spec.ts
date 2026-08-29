/**
 * Tests for the v0.19 secure evaluation freeze record.
 *
 * Verifies that the freeze record correctly captures the qualified state
 * and marks the secure evaluation as ready for real Batch A only when the
 * platform backend provides full enforcement.
 *
 * @module v019-freeze-secure-eval.spec
 */

import { beforeAll, describe, expect, it } from 'vitest'
import {
  FREEZE_ID,
  computeVerifierIntegrityHash,
  formatFreezeRecord,
  generateFreezeRecord,
  verifyVerifierIntegrity,
  type SecureEvalFreezeRecord,
} from './v019-freeze-secure-eval.ts'

describe('v019 secure evaluation freeze', () => {
  let record: SecureEvalFreezeRecord

  beforeAll(async () => {
    record = await generateFreezeRecord()
  })

  it('uses the correct freeze identity', () => {
    expect(record.freezeId).toBe(FREEZE_ID)
    expect(record.freezeId).toBe('v019-secure-eval-v2')
  })

  it('records a timestamp', () => {
    expect(record.frozenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('references the security qualification gate', () => {
    expect(record.securityQualificationId).toBe('v019-security-qualification-v2')
  })

  it('security qualification has 34 properties', () => {
    expect(record.securityPropertyCount).toBe(34)
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

  it('effective composition reports backend enforcement', () => {
    expect(record.effectiveComposition.backendEnforcement).toBeDefined()
    // On Linux: 'full' (bwrap). On macOS: 'partial' (Seatbelt).
    if (process.platform === 'linux') {
      expect(record.effectiveComposition.backendEnforcement).toBe('full')
    } else if (process.platform === 'darwin') {
      expect(record.effectiveComposition.backendEnforcement).toBe('partial')
    }
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

  it('backendFullEnforcement reflects platform capability', () => {
    if (process.platform === 'linux') {
      expect(record.backendFullEnforcement).toBe(true)
    } else {
      expect(record.backendFullEnforcement).toBe(false)
    }
  })

  it('freeze record is ready only on full-enforcement platforms', () => {
    if (process.platform === 'linux') {
      expect(record.ready).toBe(true)
    } else {
      expect(record.ready).toBe(false)
    }
  })

  it('formatFreezeRecord produces a readable report', () => {
    const report = formatFreezeRecord(record)
    expect(report).toContain(FREEZE_ID)
    expect(report).toContain('Backend enforcement:')
    expect(report).toContain('fs-sandbox')
    expect(report).toContain('bash-sandbox')
    expect(report).toContain('workspace-isolated')
    expect(report).toContain('production')
    expect(report).toContain('durable')
  })

  it('includes a verifier integrity hash', () => {
    expect(record.verifierIntegrityHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('verifier integrity hash is reproducible', () => {
    expect(verifyVerifierIntegrity(record.verifierIntegrityHash)).toBe(true)
    expect(computeVerifierIntegrityHash()).toBe(record.verifierIntegrityHash)
  })

  it('formatFreezeRecord includes the verifier integrity hash', () => {
    const report = formatFreezeRecord(record)
    expect(report).toContain('Verifier Integrity Hash:')
    expect(report).toContain(record.verifierIntegrityHash)
  })
})
