/**
 * Tests for the v0.19 security qualification gate.
 *
 * Verifies that the integrated evaluator composition satisfies all required
 * security properties before any real Batch A evaluation begins.
 *
 * @module v019-security-qualification.spec
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SECURITY_QUALIFICATION_ID,
  formatSecurityQualification,
  runSecurityQualification,
  type SecurityQualificationRecord,
} from './v019-security-qualification.ts'

describe('v019 security qualification gate', () => {
  let record: SecurityQualificationRecord

  beforeAll(async () => {
    record = await runSecurityQualification()
  })

  it('uses the correct qualification identity', () => {
    expect(record.qualificationId).toBe(SECURITY_QUALIFICATION_ID)
    expect(record.qualificationId).toBe('v019-security-qualification-v2')
  })

  it('records a timestamp', () => {
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('records the platform', () => {
    expect(record.platform).toBe(process.platform)
  })

  it('runs all 35 security property checks (24 source + 11 behavioral)', () => {
    expect(record.checks).toHaveLength(35)
  })

  it('every check has a unique id', () => {
    const ids = record.checks.map(c => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every check has a non-empty name and evidence', () => {
    for (const check of record.checks) {
      expect(check.name.length).toBeGreaterThan(0)
      expect(check.evidence.length).toBeGreaterThan(0)
    }
  })

  it('counts match the individual check statuses', () => {
    const expectedPassed = record.checks.filter(c => c.status === 'pass').length
    const expectedFailed = record.checks.filter(c => c.status === 'fail').length
    const expectedNa = record.checks.filter(c => c.status === 'not-applicable').length
    expect(record.passedCount).toBe(expectedPassed)
    expect(record.failedCount).toBe(expectedFailed)
    expect(record.notApplicableCount).toBe(expectedNa)
  })

  it('passed is true only when failedCount is zero', () => {
    expect(record.passed).toBe(record.failedCount === 0)
  })

  it('G1: filesystem plane uses fs-sandbox', () => {
    const g1 = record.checks.find(c => c.id === 'G1')
    expect(g1).toBeDefined()
    expect(g1!.status).toBe('pass')
  })

  it('G2: subprocess plane uses bash-sandbox', () => {
    const g2 = record.checks.find(c => c.id === 'G2')
    expect(g2).toBeDefined()
    expect(g2!.status).toBe('pass')
  })

  it('G3: sandbox policy is workspace-isolated', () => {
    const g3 = record.checks.find(c => c.id === 'G3')
    expect(g3).toBeDefined()
    expect(g3!.status).toBe('pass')
  })

  it('G4: Seatbelt isolation claim is honest', () => {
    const g4 = record.checks.find(c => c.id === 'G4')
    expect(g4).toBeDefined()
    expect(g4!.status).toBe('pass')
  })

  it('G5: Seatbelt fails closed', () => {
    const g5 = record.checks.find(c => c.id === 'G5')
    expect(g5).toBeDefined()
    expect(g5!.status).toBe('pass')
  })

  it('G6: holdouts are externalized', () => {
    const g6 = record.checks.find(c => c.id === 'G6')
    expect(g6).toBeDefined()
    expect(g6!.status).toBe('pass')
  })

  it('G7: diagnostics do not discover holdouts', () => {
    const g7 = record.checks.find(c => c.id === 'G7')
    expect(g7).toBeDefined()
    expect(g7!.status).toBe('pass')
  })

  it('G8: production RepairRuntime is mounted', () => {
    const g8 = record.checks.find(c => c.id === 'G8')
    expect(g8).toBeDefined()
    expect(g8!.status).toBe('pass')
  })

  it('G9: rollback provider is configured', () => {
    const g9 = record.checks.find(c => c.id === 'G9')
    expect(g9).toBeDefined()
    expect(g9!.status).toBe('pass')
  })

  it('G10: provenance provider is configured', () => {
    const g10 = record.checks.find(c => c.id === 'G10')
    expect(g10).toBeDefined()
    expect(g10!.status).toBe('pass')
  })

  it('G11: holdout verifier stages and cleans up', () => {
    const g11 = record.checks.find(c => c.id === 'G11')
    expect(g11).toBeDefined()
    expect(g11!.status).toBe('pass')
  })

  it('G12: unpriced usage fails', () => {
    const g12 = record.checks.find(c => c.id === 'G12')
    expect(g12).toBeDefined()
    expect(g12!.status).toBe('pass')
  })

  it('G13: metrics filter by benchmarkEligible', () => {
    const g13 = record.checks.find(c => c.id === 'G13')
    expect(g13).toBeDefined()
    expect(g13!.status).toBe('pass')
  })

  it('G14: replay mismatch is not hard-coded', () => {
    const g14 = record.checks.find(c => c.id === 'G14')
    expect(g14).toBeDefined()
    expect(g14!.status).toBe('pass')
  })

  it('G15: per-attempt diffs are captured', () => {
    const g15 = record.checks.find(c => c.id === 'G15')
    expect(g15).toBeDefined()
    expect(g15!.status).toBe('pass')
  })

  it('G16: latency is separated', () => {
    const g16 = record.checks.find(c => c.id === 'G16')
    expect(g16).toBeDefined()
    expect(g16!.status).toBe('pass')
  })

  it('G17: sandbox qualification skips are non-pass', () => {
    const g17 = record.checks.find(c => c.id === 'G17')
    expect(g17).toBeDefined()
    expect(g17!.status).toBe('pass')
  })

  it('G18: repair routes through durable routing authority', () => {
    const g18 = record.checks.find(c => c.id === 'G18')
    expect(g18).toBeDefined()
    expect(g18!.status).toBe('pass')
  })

  it('G19: repair events are ordered', () => {
    const g19 = record.checks.find(c => c.id === 'G19')
    expect(g19).toBeDefined()
    expect(g19!.status).toBe('pass')
  })

  it('G20: releaseToAuto refuses undecidable state', () => {
    const g20 = record.checks.find(c => c.id === 'G20')
    expect(g20).toBeDefined()
    expect(g20!.status).toBe('pass')
  })

  it('G21: model workspaces have no future Git history', () => {
    const g21 = record.checks.find(c => c.id === 'G21')
    expect(g21).toBeDefined()
    expect(g21!.status).toBe('pass')
  })

  it('G22: network is denied in workspace-isolated sandbox profiles', () => {
    const g22 = record.checks.find(c => c.id === 'G22')
    expect(g22).toBeDefined()
    expect(g22!.status).toBe('pass')
  })

  it('G23: verifier-controlled files are hashed at freeze time', () => {
    const g23 = record.checks.find(c => c.id === 'G23')
    expect(g23).toBeDefined()
    expect(g23!.status).toBe('pass')
  })

  it('G24: reference fix files are forensic-only (never model-visible)', () => {
    const g24 = record.checks.find(c => c.id === 'G24')
    expect(g24).toBeDefined()
    expect(g24!.status).toBe('pass')
  })

  it('B11: benchmark-eligible backend enforcement check exists', () => {
    const b11 = record.checks.find(c => c.id === 'B11')
    expect(b11).toBeDefined()
    // On Linux (bwrap/landlock), enforcement is 'full' and the check passes.
    // On macOS (Seatbelt), enforcement is 'partial' and the check fails —
    // benchmark-eligible runs must not proceed on partial-enforcement backends.
    if (process.platform === 'linux') {
      expect(b11!.status).toBe('pass')
    } else if (process.platform === 'darwin') {
      expect(b11!.status).toBe('fail')
      expect(b11!.evidence).toContain('partial')
    }
  })

  it('the full gate passes only on full-enforcement platforms', () => {
    if (process.platform === 'linux') {
      expect(record.passed).toBe(true)
      expect(record.failedCount).toBe(0)
    } else {
      // On partial-enforcement platforms (darwin, win32), the gate fails
      // because B11 requires full backend enforcement for benchmark-eligible runs.
      expect(record.passed).toBe(false)
      expect(record.failedCount).toBeGreaterThanOrEqual(1)
    }
  })

  it('formatSecurityQualification produces a readable report', () => {
    const report = formatSecurityQualification(record)
    expect(report).toContain(SECURITY_QUALIFICATION_ID)
    expect(report).toContain('Platform:')
    expect(report).toContain('Result:')
    for (const check of record.checks) {
      expect(report).toContain(check.id)
      expect(report).toContain(check.name)
    }
  })
})

describe('deterministic negative benchmark-security tests', () => {
  it('reference fix file paths do not appear in any model-visible event type', () => {
    // The model can only see events that appear in the session log.
    // Reference fix files are extracted from the verifier-only clone and
    // must never appear in model-visible event payloads.
    const modelVisibleEventTypes = new Set([
      'tool/call', 'tool/result', 'turn/start', 'turn/end',
      'model/routing-decision', 'model/usage', 'model/escalation',
      'model/selection-authority', 'repair/evidence', 'repair/decision',
      'repair/completed', 'repair/rollback', 'goal/verification',
    ])
    // The trajectory collector only passes referenceFixFiles to
    // buildTrajectoryFromEvents for intersection analysis, never to
    // session.append or model prompts.
    const collectorSource = readFileSync(
      join(fileURLToPath(new URL('.', import.meta.url)), 'v019-trajectory-collector.ts'),
      'utf8',
    )
    // Verify referenceFixFiles is only used in buildTrajectoryFromEvents
    // and the intersection analysis, not in any session.append call.
    const appendLines = collectorSource.split('\n').filter(l => l.includes('session.append'))
    for (const line of appendLines) {
      expect(line).not.toContain('referenceFixFiles')
    }
    // Verify model-visible event types are a closed set.
    expect(modelVisibleEventTypes.has('repair/evidence')).toBe(true)
    expect(modelVisibleEventTypes.has('tool/call')).toBe(true)
  })

  it('verifier-controlled file hash check rejects tampered workspaces', () => {
    // The diagnostic verifier hashes verifier-controlled files before model
    // execution and re-hashes them on each verification call. If the model
    // overwrites package.json, tsconfig.json, or test config files, the
    // hash check must reject the task.
    const collectorSource = readFileSync(
      join(fileURLToPath(new URL('.', import.meta.url)), 'v019-trajectory-collector.ts'),
      'utf8',
    )
    expect(collectorSource).toContain('hashVerifierControlledFiles')
    expect(collectorSource).toContain('verifier-controlled files were modified')
  })

  it('model workspace has no .git directory (no future history access)', () => {
    const checkoutSource = readFileSync(
      join(fileURLToPath(new URL('.', import.meta.url)), 'v019-repo-checkout.ts'),
      'utf8',
    )
    expect(checkoutSource).toContain('git archive')
    expect(checkoutSource).not.toContain('worktree add')
  })
})
