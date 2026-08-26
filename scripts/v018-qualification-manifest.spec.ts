/**
 * Tests for v0.18 qualification manifest, prerequisite gate, and
 * manual model authority.
 *
 * @module v018-qualification-manifest.spec
 */

import { describe, expect, it } from 'vitest'
import {
  type PrerequisiteCheck,
  type SmokeResult,
  buildManifest,
  verifyManifest,
  checkRepoClean,
  resolveEffectiveModel,
  prerequisiteGate,
  formatPrerequisiteSummary,
  shouldProceedWithLiveQualification,
} from './v018-qualification-manifest.ts'

// ---------------------------------------------------------------------------
// E21-E23: Manifest
// ---------------------------------------------------------------------------

describe('qualification manifest', () => {
  it('builds a manifest with qualification identity v018-qualification-v1', async () => {
    const manifest = await buildManifest({
      repairControllerVersion: '0.18.0',
      repairRuntimeVersion: '0.18.0',
      eventSchemaVersion: 0,
      pricingVersion: '2026-08-25',
      sandboxPolicyVersion: 'v1',
      fixtureVersion: 'v1',
      holdoutVersion: 'v1',
    })
    expect(manifest.qualificationId).toBe('v018-qualification-v1')
    expect(manifest.sourceCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(manifest.manifestHash).toHaveLength(16)
  })

  it('produces deterministic manifest hash for same inputs', async () => {
    const params = {
      repairControllerVersion: '0.18.0',
      repairRuntimeVersion: '0.18.0',
      eventSchemaVersion: 0,
      pricingVersion: '2026-08-25',
      sandboxPolicyVersion: 'v1',
      fixtureVersion: 'v1',
      holdoutVersion: 'v1',
    }
    const m1 = await buildManifest(params)
    const m2 = await buildManifest(params)
    expect(m1.manifestHash).toBe(m2.manifestHash)
  })

  it('different versions produce different hashes', async () => {
    const m1 = await buildManifest({
      repairControllerVersion: '0.18.0',
      repairRuntimeVersion: '0.18.0',
      eventSchemaVersion: 0,
      pricingVersion: '2026-08-25',
      sandboxPolicyVersion: 'v1',
      fixtureVersion: 'v1',
      holdoutVersion: 'v1',
    })
    const m2 = await buildManifest({
      repairControllerVersion: '0.18.1',
      repairRuntimeVersion: '0.18.0',
      eventSchemaVersion: 0,
      pricingVersion: '2026-08-25',
      sandboxPolicyVersion: 'v1',
      fixtureVersion: 'v1',
      holdoutVersion: 'v1',
    })
    expect(m1.manifestHash).not.toBe(m2.manifestHash)
  })

  it('verifyManifest detects tampered hash', async () => {
    const manifest = await buildManifest({
      repairControllerVersion: '0.18.0',
      repairRuntimeVersion: '0.18.0',
      eventSchemaVersion: 0,
      pricingVersion: '2026-08-25',
      sandboxPolicyVersion: 'v1',
      fixtureVersion: 'v1',
      holdoutVersion: 'v1',
    })
    const tampered = { ...manifest, manifestHash: '0000000000000000' }
    const violations = verifyManifest(tampered, {})
    expect(violations).toContain('manifestHash: tampered or stale')
  })

  it('verifyManifest detects mismatched versions', async () => {
    const manifest = await buildManifest({
      repairControllerVersion: '0.18.0',
      repairRuntimeVersion: '0.18.0',
      eventSchemaVersion: 0,
      pricingVersion: '2026-08-25',
      sandboxPolicyVersion: 'v1',
      fixtureVersion: 'v1',
      holdoutVersion: 'v1',
    })
    const violations = verifyManifest(manifest, { repairControllerVersion: '0.19.0' })
    expect(violations.some(v => v.includes('repairControllerVersion'))).toBe(true)
  })

  it('verifyManifest passes for consistent manifest', async () => {
    const manifest = await buildManifest({
      repairControllerVersion: '0.18.0',
      repairRuntimeVersion: '0.18.0',
      eventSchemaVersion: 0,
      pricingVersion: '2026-08-25',
      sandboxPolicyVersion: 'v1',
      fixtureVersion: 'v1',
      holdoutVersion: 'v1',
    })
    const violations = verifyManifest(manifest, {
      qualificationId: 'v018-qualification-v1',
      repairControllerVersion: '0.18.0',
    })
    expect(violations).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// E22: Repository gate
// ---------------------------------------------------------------------------

describe('repository gate', () => {
  it('checkRepoClean returns a check result', () => {
    const result = checkRepoClean()
    expect(result.name).toBe('repository-clean')
    expect(typeof result.passed).toBe('boolean')
    expect(typeof result.detail).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// E25: Manual model authority
// ---------------------------------------------------------------------------

describe('manual model authority', () => {
  it('manual selection takes priority over durable and heuristic', () => {
    const result = resolveEffectiveModel('deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash')
    expect(result.model).toBe('deepseek-v4-pro')
    expect(result.source).toBe('manual')
  })

  it('durable authority takes priority over heuristic when no manual', () => {
    const result = resolveEffectiveModel(undefined, 'deepseek-v4-pro', 'deepseek-v4-flash')
    expect(result.model).toBe('deepseek-v4-pro')
    expect(result.source).toBe('durable')
  })

  it('heuristic is used when no manual or durable', () => {
    const result = resolveEffectiveModel(undefined, undefined, 'deepseek-v4-flash')
    expect(result.model).toBe('deepseek-v4-flash')
    expect(result.source).toBe('heuristic')
  })
})

// ---------------------------------------------------------------------------
// F29: Prerequisite gate
// ---------------------------------------------------------------------------

describe('prerequisite gate', () => {
  const passingChecks: PrerequisiteCheck[] = [
    { name: 'repository-clean', passed: true, detail: 'clean' },
    { name: 'typecheck', passed: true, detail: 'passed' },
    { name: 'repair-tests', passed: true, detail: 'passed' },
  ]
  const failingChecks: PrerequisiteCheck[] = [
    { name: 'repository-clean', passed: true, detail: 'clean' },
    { name: 'typecheck', passed: false, detail: '3 errors' },
  ]

  it('prerequisiteGate returns true when all checks pass', () => {
    expect(prerequisiteGate(passingChecks)).toBe(true)
  })

  it('prerequisiteGate returns false when any check fails', () => {
    expect(prerequisiteGate(failingChecks)).toBe(false)
  })

  it('formatPrerequisiteSummary shows LIVE QUALIFICATION ENABLED when all pass', () => {
    const summary = formatPrerequisiteSummary(passingChecks)
    expect(summary).toContain('LIVE QUALIFICATION ENABLED')
    expect(summary).toContain('[PASS]')
  })

  it('formatPrerequisiteSummary shows BLOCKED when any fails', () => {
    const summary = formatPrerequisiteSummary(failingChecks)
    expect(summary).toContain('LIVE QUALIFICATION BLOCKED')
    expect(summary).toContain('[FAIL]')
  })
})

describe('live qualification decision', () => {
  const passingSmoke: SmokeResult[] = [
    {
      model: 'deepseek-v4-flash',
      httpOk: true,
      hasAssistantOutput: true,
      hasUsage: true,
      modelIdentity: 'deepseek-v4-flash',
      requestId: 'req-1',
      detail: 'ok',
    },
  ]
  const failingSmoke: SmokeResult[] = [
    {
      model: 'deepseek-v4-flash',
      httpOk: false,
      hasAssistantOutput: false,
      hasUsage: false,
      modelIdentity: undefined,
      requestId: undefined,
      detail: '401 authentication error',
    },
  ]
  const passingPrereqs: PrerequisiteCheck[] = [
    { name: 'repository-clean', passed: true, detail: 'clean' },
  ]

  it('proceeds when smoke and prerequisites pass', () => {
    expect(shouldProceedWithLiveQualification(passingSmoke, passingPrereqs)).toBe(true)
  })

  it('blocks when smoke fails', () => {
    expect(shouldProceedWithLiveQualification(failingSmoke, passingPrereqs)).toBe(false)
  })

  it('blocks when prerequisites fail', () => {
    expect(shouldProceedWithLiveQualification(passingSmoke, [
      { name: 'repository-clean', passed: false, detail: 'dirty' },
    ])).toBe(false)
  })
})
