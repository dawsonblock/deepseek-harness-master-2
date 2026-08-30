/**
 * Spec for the v0.19 composed runtime qualification gate.
 *
 * Verifies that the qualification script exports the expected artifact
 * schema, that the Batch A runner enforces it, and that the 15 runtime
 * checks are present and categorized correctly.
 *
 * @module v019-composed-runtime-qualification.spec
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  COMPOSED_QUALIFICATION_ID,
  type ComposedQualificationRecord,
  type ComposedCheck,
} from './v019-composed-runtime-qualification.ts'

const REPO_ROOT = join(import.meta.dirname, '..')

function readQualificationSource(): string {
  return readFileSync(join(REPO_ROOT, 'scripts', 'v019-composed-runtime-qualification.ts'), 'utf8')
}

function readBatchARunnerSource(): string {
  return readFileSync(join(REPO_ROOT, 'scripts', 'run-v019-batch-a-evaluation.ts'), 'utf8')
}

describe('v019 composed runtime qualification', () => {
  const source = readQualificationSource()
  const batchRunnerSource = readBatchARunnerSource()

  it('exports the correct qualification ID', () => {
    expect(COMPOSED_QUALIFICATION_ID).toBe('v019-composed-runtime-qualification-v1')
  })

  it('defines all 15 runtime checks (C1-C15)', () => {
    for (let i = 1; i <= 15; i++) {
      expect(source).toContain(`'C${i}'`)
    }
  })

  it('boots the exact Batch A config via generateRepoConfig', () => {
    expect(source).toContain('generateRepoConfig')
    expect(source).toContain("boot('v019-composed-qual'")
  })

  it('mounts the production RepairRuntime plugin', () => {
    expect(source).toContain('repairRuntimePlugin')
    expect(source).toContain('ctx.plugin(repairRuntimePlugin')
  })

  it('queries the running context for service identity (not source strings)', () => {
    expect(source).toContain("ctx.get('fs')")
    expect(source).toContain("ctx.get('shell')")
    expect(source).toContain("ctx.get('sandboxPolicy')")
    expect(source).toContain("ctx.get('goals')")
    expect(source).toContain("ctx.get('repairController')")
  })

  it('exercises the real filesystem tool through the registered provider', () => {
    expect(source).toContain('sandboxFs.resolve')
    expect(source).toContain('sandboxFs.readText')
    expect(source).toContain('sandboxFs.writeText')
  })

  it('exercises the real Bash tool through the registered provider', () => {
    expect(source).toContain('shell.resolve')
    expect(source).toContain('shell.run')
  })

  it('tests network denial through a deterministic local TCP listener', () => {
    expect(source).toContain('createTcpServer')
    expect(source).toContain('127.0.0.1')
    expect(source).toContain('networkDenied')
  })

  it('verifies model workspace has no Git history', () => {
    expect(source).toContain("'.git'")
    expect(source).toContain('git log')
  })

  it('verifies holdout secrecy from both tool planes', () => {
    expect(source).toContain('holdout')
    expect(source).toContain('agentFsReadDenied')
    expect(source).toContain('agentBashReadDenied')
    expect(source).toContain('verifierCanRead')
  })

  it('uses synthetic sessions with real repair runtime APIs for lifecycle checks', () => {
    expect(source).toContain('handleVerificationPass')
    expect(source).toContain('handleVerificationFailure')
    expect(source).toContain('reconstructRepairState')
  })

  it('tests rollback failure stops repair', () => {
    expect(source).toContain('createFailingRollbackProvider')
    expect(source).toContain('rollback-failed')
  })

  it('tests authority ambiguity denies model transition', () => {
    expect(source).toContain('releaseToAuto')
    expect(source).toContain('authoritySchemaVersion')
  })

  it('tests workspace-bound verification with mutation', () => {
    expect(source).toContain('workspaceHash')
    expect(source).toContain('MUTATED')
  })

  it('tests ledger secret sanitization by scanning durable events', () => {
    expect(source).toContain('secretPatterns')
    expect(source).toContain('JSON.stringify(session.events)')
  })

  it('tests unpriced usage throws UNPRICED_USAGE', () => {
    expect(source).toContain('UNPRICED_USAGE')
    expect(source).toContain('nonexistent-model-v999')
  })

  it('produces a qualification artifact with the expected schema', () => {
    expect(source).toContain('qualificationId')
    expect(source).toContain('sourceCommit')
    expect(source).toContain('passedCount')
    expect(source).toContain('failedCount')
    expect(source).toContain('ready')
    expect(source).toContain('backend')
    expect(source).toContain('filesystem')
    expect(source).toContain('holdout')
    expect(source).toContain('repair')
  })

  it('includes composed-runtime scenario checks through the real plugin', () => {
    expect(source).toContain('checkScenarioOneShotPass')
    expect(source).toContain('checkScenarioHoldoutFail')
    expect(source).toContain('checkScenarioPostMutationDenied')
    expect(source).toContain('checkScenarioHoldoutDenied')
    expect(source).toContain('checkScenarioWorkspaceBoundCompletion')
    expect(source).toContain('checkScenarioRollbackFailureStops')
    expect(source).toContain('checkScenarioAuthorityAmbiguity')
    expect(source).toContain('checkScenarioProEscalation')
    expect(source).toContain('verifyCompletion')
    expect(source).toContain('registerAcceptanceVerifier')
    expect(source).toContain('goals.create')
  })

  it('persists and reads the composed qualification artifact', () => {
    expect(source).toContain('writeComposedQualificationRecord')
    expect(source).toContain('readComposedQualificationRecord')
  })

  it('Batch A runner uses persisted freeze and composed qualification', () => {
    expect(batchRunnerSource).toContain('readFreezeRecord')
    expect(batchRunnerSource).toContain('writeFreezeRecord')
    expect(batchRunnerSource).toContain('writeComposedQualificationRecord')
  })

  it('Batch A runner enforces the composed-runtime qualification gate on every launch', () => {
    expect(batchRunnerSource).toContain('runComposedRuntimeQualification')
    expect(batchRunnerSource).toContain('COMPOSED_QUALIFICATION_ID')
  })

  it('Batch A runner exits with failure when composed qualification is not ready', () => {
    expect(batchRunnerSource).toContain('COMPOSED RUNTIME QUALIFICATION FAILED')
    expect(batchRunnerSource).toContain('process.exit(1)')
  })

  it('ComposedCheck type has the required fields', () => {
    const check: ComposedCheck = {
      id: 'C1',
      name: 'test',
      status: 'pass',
      evidence: 'test evidence',
    }
    expect(check.id).toBe('C1')
    expect(check.status).toBe('pass')
  })

  it('ComposedQualificationRecord type has the required fields', () => {
    const record: ComposedQualificationRecord = {
      qualificationId: COMPOSED_QUALIFICATION_ID,
      sourceCommit: 'abc123',
      timestamp: '2026-01-01T00:00:00.000Z',
      checks: [],
      passedCount: 0,
      failedCount: 0,
      skipCount: 0,
      passed: true,
      backend: {
        runner: 'seatbelt',
        runnerPath: '/usr/bin/sandbox-exec',
        runnerVersion: '15.0',
        networkIsolation: 'sandbox-denied',
        enforcement: 'full',
        networkDenied: true,
        probed: true,
      },
      filesystem: { modelReadFence: true, modelWriteFence: true },
      holdout: { modelReadable: false },
      repair: { productionRuntime: true, rollbackRequired: true, provenanceRequired: true },
      environment: { platform: 'test', arch: 'x64', nodeVersion: 'v22.0.0', runner: 'test' },
      snapshot: { algorithm: 'sha256-tree-v2', exclusions: 'verifier-snapshot-exclusions-v1' },
      ready: true,
    }
    expect(record.qualificationId).toBe(COMPOSED_QUALIFICATION_ID)
    expect(record.ready).toBe(true)
  })
})
