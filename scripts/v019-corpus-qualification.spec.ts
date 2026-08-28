/**
 * Tests for v0.19 corpus qualification pipeline.
 *
 * @module v019-corpus-qualification.spec
 */

import { describe, it, expect } from 'vitest'

import {
  qualifyLeakageChecked,
  qualifyFrozen,
  type QualificationResult,
} from './v019-corpus-qualification.ts'

import { buildTaskManifest, FROZEN_V018_LIMITS } from './v019-task-manifest.ts'

function makeManifest(overrides: Partial<Parameters<typeof buildTaskManifest>[0]> = {}): ReturnType<typeof buildTaskManifest> {
  return buildTaskManifest({
    taskId: 'test-001',
    category: 'bug-fix',
    benchmarkEligible: true,
    repository: {
      name: 'test-repo',
      url: 'file:///tmp/test',
      baseCommit: 'abc123def456789',
      referenceFixCommit: 'def456abc789012',
    },
    repoSize: 'small',
    task: {
      title: 'Fix a bug',
      description: 'The sort function does not sort numbers correctly. Fix it so tests pass.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [{ command: 'npm test', expectedExitCode: 0 }],
      holdout: [],
      strength: 'V2',
    },
    limits: { ...FROZEN_V018_LIMITS },
    ...overrides,
  })
}

describe('v019-corpus-qualification', () => {
  describe('qualifyLeakageChecked', () => {
    it('passes when description does not leak the solution', () => {
      const manifest = makeManifest()
      const result = qualifyLeakageChecked(manifest, ['src/index.ts'])
      expect(result.passed).toBe(true)
    })

    it('rejects when description contains the reference fix commit hash', () => {
      const manifest = makeManifest({
        task: {
          title: 'Fix a bug',
          description: 'The fix is in commit def456ab. Apply that fix.',
          source: 'synthetic',
        },
      })
      const result = qualifyLeakageChecked(manifest, ['src/index.ts'])
      expect(result.passed).toBe(false)
      expect(result.reason).toContain('commit hash')
    })

    it('rejects when description contains solution-leak pattern', () => {
      const manifest = makeManifest({
        task: {
          title: 'Fix a bug',
          description: 'Fix by changing the comparison to use numeric sort.',
          source: 'synthetic',
        },
      })
      const result = qualifyLeakageChecked(manifest, ['src/index.ts'])
      expect(result.passed).toBe(false)
      expect(result.reason).toContain('solution-leak')
    })

    it('passes when no reference fix commit is specified', () => {
      const manifest = makeManifest({
        repository: {
          name: 'test-repo',
          url: 'file:///tmp/test',
          baseCommit: 'abc123def456789',
          referenceFixCommit: undefined,
        },
      })
      const result = qualifyLeakageChecked(manifest, [])
      expect(result.passed).toBe(true)
    })
  })

  describe('qualifyFrozen', () => {
    it('freezes a valid benchmark-eligible manifest', () => {
      const manifest = makeManifest()
      const history: QualificationResult[] = [
        {
          taskId: 'test-001',
          state: 'REPRODUCED',
          gate: 'REPRODUCED',
          passed: true,
          reason: 'ok',
          details: [],
        },
        {
          taskId: 'test-001',
          state: 'VERIFIER_VALIDATED',
          gate: 'VERIFIER_VALIDATED',
          passed: true,
          reason: 'ok',
          details: [],
        },
        {
          taskId: 'test-001',
          state: 'LEAKAGE_CHECKED',
          gate: 'LEAKAGE_CHECKED',
          passed: true,
          reason: 'ok',
          details: [],
        },
      ]
      const record = qualifyFrozen(manifest, history)
      expect(record.currentState).toBe('FROZEN')
      expect(record.qualifiedAt).toBeDefined()
      expect(record.history).toHaveLength(4)
    })

    it('rejects a non-benchmark-eligible manifest', () => {
      const manifest = makeManifest({ benchmarkEligible: false })
      const record = qualifyFrozen(manifest, [])
      expect(record.currentState).toBe('REJECTED')
      expect(record.qualifiedAt).toBeUndefined()
    })
  })
})
