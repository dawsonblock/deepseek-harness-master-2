/**
 * Tests for v0.18 verification security and economics utilities.
 *
 * @module v018-verification-security.spec
 */

import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type DiagnosticVerificationResult,
  type HoldoutVerificationResult,
  type VerifierControlledFiles,
  isDiagnosticResult,
  isHoldoutResult,
  detectHoldoutLeakage,
  extractHoldoutStrings,
  checkAntiCheating,
  recordVerifierSnapshot,
  verifyVerifierSnapshot,
  snapshotWorkspace,
  diffSnapshots,
  sanitizeSecrets,
  filterModelVisibleEvidence,
  aggregateUsage,
  verifyCostInvariant,
  verifyAttemptInvariant,
  hashFixtureContent,
  computeFixtureHashes,
} from './v018-verification-security.ts'

// ---------------------------------------------------------------------------
// C11: Holdout evidence type separation
// ---------------------------------------------------------------------------

describe('holdout evidence type separation', () => {
  const diagnostic: DiagnosticVerificationResult = {
    exposeToRepair: true,
    passed: false,
    evidence: { failedCriteria: ['test-1'], failingTests: [], typeErrors: [], buildErrors: [] },
  }
  const holdout: HoldoutVerificationResult = {
    exposeToRepair: false,
    passed: false,
    evidence: { failedCriteria: ['holdout-1'], failingTests: [], typeErrors: [], buildErrors: [] },
  }

  it('isDiagnosticResult narrows correctly', () => {
    expect(isDiagnosticResult(diagnostic)).toBe(true)
    expect(isDiagnosticResult(holdout)).toBe(false)
  })

  it('isHoldoutResult narrows correctly', () => {
    expect(isHoldoutResult(holdout)).toBe(true)
    expect(isHoldoutResult(diagnostic)).toBe(false)
  })

  it('diagnostic evidence is exposeToRepair: true', () => {
    expect(diagnostic.exposeToRepair).toBe(true)
  })

  it('holdout evidence is exposeToRepair: false', () => {
    expect(holdout.exposeToRepair).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// C12: Holdout leakage detection
// ---------------------------------------------------------------------------

describe('holdout leakage detection', () => {
  it('detects holdout test filename in repair evidence', () => {
    const leaked = detectHoldoutLeakage(
      ['__holdout_test__.test.ts'],
      'The file __holdout_test__.test.ts contains tests',
    )
    expect(leaked).toHaveLength(1)
    expect(leaked[0]).toBe('__holdout_test__.test.ts')
  })

  it('detects holdout assertion strings in repair evidence', () => {
    const leaked = detectHoldoutLeakage(
      ['preserves this context'],
      'The model should preserve: preserves this context',
    )
    expect(leaked).toHaveLength(1)
  })

  it('returns empty when no holdout strings leak', () => {
    const leaked = detectHoldoutLeakage(
      ['__holdout_test__.test.ts', 'secret assertion'],
      'Failed criteria: TypeScript typecheck must pass',
    )
    expect(leaked).toHaveLength(0)
  })

  it('extracts holdout strings from test content', () => {
    const content = `
      describe('holdout suite', () => {
        it('preserves this context', () => {
          expect(result).toBe(42)
        })
      })
    `
    const strings = extractHoldoutStrings(content, '__holdout_test__.test.ts')
    expect(strings).toContain('__holdout_test__.test.ts')
    expect(strings).toContain('holdout suite')
    expect(strings).toContain('preserves this context')
  })

  it('empty holdout strings produce no leaks', () => {
    const leaked = detectHoldoutLeakage([], 'any repair evidence')
    expect(leaked).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// C13: Anti-cheating checks
// ---------------------------------------------------------------------------

describe('anti-cheating checks', () => {
  it('detects modified package.json scripts', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'anti-cheat-1'))
    const initialPkg = JSON.stringify({ name: 'test', scripts: { test: 'vitest' } })
    await writeFile(join(workspace, 'package.json'), JSON.stringify({
      name: 'test',
      scripts: { test: 'echo skip' },
    }))
    const violations = await checkAntiCheating(workspace, initialPkg, '{}', [])
    expect(violations.some(v => v.kind === 'package-scripts-modified')).toBe(true)
  })

  it('detects modified dependencies', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'anti-cheat-2'))
    const initialPkg = JSON.stringify({ name: 'test', dependencies: { vitest: '1.0' } })
    await writeFile(join(workspace, 'package.json'), JSON.stringify({
      name: 'test',
      dependencies: { vitest: '0.0' },
    }))
    const violations = await checkAntiCheating(workspace, initialPkg, '{}', [])
    expect(violations.some(v => v.kind === 'test-framework-mutated')).toBe(true)
  })

  it('detects tsconfig exclude entries', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'anti-cheat-3'))
    await writeFile(join(workspace, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {},
      exclude: ['*.test.ts'],
    }))
    const violations = await checkAntiCheating(workspace, '{}', '{}', [])
    expect(violations.some(v => v.kind === 'tsconfig-exclude-added')).toBe(true)
  })

  it('detects deleted required files', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'anti-cheat-4'))
    await writeFile(join(workspace, 'package.json'), '{}')
    const violations = await checkAntiCheating(workspace, '{}', '{}', ['required.ts'])
    expect(violations.some(v => v.kind === 'required-source-deleted')).toBe(true)
  })

  it('no violations on clean workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'anti-cheat-5'))
    const initialPkg = JSON.stringify({ name: 'test', scripts: { test: 'vitest' } })
    await writeFile(join(workspace, 'package.json'), initialPkg)
    await writeFile(join(workspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }))
    await writeFile(join(workspace, 'required.ts'), 'export {}')
    const violations = await checkAntiCheating(workspace, initialPkg, '{}', ['required.ts'])
    expect(violations).toHaveLength(0)
  })

  it('detects --passWithNoTests disabling test discovery', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'anti-cheat-6'))
    const initialPkg = JSON.stringify({ name: 'test', scripts: { test: 'vitest' } })
    await writeFile(join(workspace, 'package.json'), JSON.stringify({
      name: 'test',
      scripts: { test: 'vitest --passWithNoTests' },
    }))
    const violations = await checkAntiCheating(workspace, initialPkg, '{}', [])
    expect(violations.some(v => v.kind === 'test-discovery-disabled')).toBe(true)
  })

  it('detects required source excluded by tsconfig', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'anti-cheat-7'))
    await writeFile(join(workspace, 'package.json'), '{}')
    await writeFile(join(workspace, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {},
      exclude: ['src/impl.ts'],
    }))
    const violations = await checkAntiCheating(workspace, '{}', '{}', ['src/impl.ts'])
    expect(violations.some(v => v.kind === 'required-source-excluded')).toBe(true)
  })
})

describe('verifier-controlled snapshot', () => {
  it('records immutable hashes of verifier-controlled files', () => {
    const controlled: VerifierControlledFiles = {
      packageJson: '{"name":"test"}',
      tsconfig: '{"compilerOptions":{}}',
      diagnosticVerifier: 'export const verify = () => true',
      holdoutVerifier: 'export const holdout = () => true',
      requiredSources: [{ path: 'src/impl.ts', content: 'export const x = 1' }],
    }
    const snapshot = recordVerifierSnapshot(controlled)
    expect(snapshot.files.length).toBeGreaterThanOrEqual(5)
    expect(snapshot.files.every(f => f.hash.length === 16)).toBe(true)
  })

  it('detects when verifier-controlled file is modified', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'verifier-snap-1'))
    const originalContent = 'export const verify = () => true'
    await writeFile(join(workspace, '__diagnostic_verifier__.ts'), originalContent)
    await writeFile(join(workspace, 'package.json'), '{"name":"test"}')
    await writeFile(join(workspace, 'tsconfig.json'), '{}')
    await writeFile(join(workspace, '__holdout_verifier__.ts'), 'export const h = () => true')
    await mkdir(join(workspace, 'src'), { recursive: true }).then(() => writeFile(join(workspace, 'src/impl.ts'), 'export const x = 1'))

    const snapshot = recordVerifierSnapshot({
      packageJson: '{"name":"test"}',
      tsconfig: '{}',
      diagnosticVerifier: originalContent,
      holdoutVerifier: 'export const h = () => true',
      requiredSources: [{ path: 'src/impl.ts', content: 'export const x = 1' }],
    })

    // Model modifies the diagnostic verifier
    await writeFile(join(workspace, '__diagnostic_verifier__.ts'), 'export const verify = () => false')

    const violations = await verifyVerifierSnapshot(workspace, snapshot)
    expect(violations.some(v => v.kind === 'verifier-file-modified')).toBe(true)
  })

  it('detects when verifier-controlled file is deleted', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'verifier-snap-2'))
    await writeFile(join(workspace, 'package.json'), '{"name":"test"}')
    await writeFile(join(workspace, 'tsconfig.json'), '{}')
    await writeFile(join(workspace, '__diagnostic_verifier__.ts'), 'export const verify = () => true')
    await writeFile(join(workspace, '__holdout_verifier__.ts'), 'export const h = () => true')
    await mkdir(join(workspace, 'src'), { recursive: true }).then(() => writeFile(join(workspace, 'src/impl.ts'), 'export const x = 1'))

    const snapshot = recordVerifierSnapshot({
      packageJson: '{"name":"test"}',
      tsconfig: '{}',
      diagnosticVerifier: 'export const verify = () => true',
      holdoutVerifier: 'export const h = () => true',
      requiredSources: [{ path: 'src/impl.ts', content: 'export const x = 1' }],
    })

    const { unlink } = await import('node:fs/promises')
    await unlink(join(workspace, '__diagnostic_verifier__.ts'))

    const violations = await verifyVerifierSnapshot(workspace, snapshot)
    expect(violations.some(v => v.kind === 'required-source-deleted')).toBe(true)
  })

  it('no violations when verifier-controlled files are unchanged', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'verifier-snap-3'))
    await writeFile(join(workspace, 'package.json'), '{"name":"test"}')
    await writeFile(join(workspace, 'tsconfig.json'), '{}')
    await writeFile(join(workspace, '__diagnostic_verifier__.ts'), 'export const verify = () => true')
    await writeFile(join(workspace, '__holdout_verifier__.ts'), 'export const h = () => true')
    await mkdir(join(workspace, 'src'), { recursive: true }).then(() => writeFile(join(workspace, 'src/impl.ts'), 'export const x = 1'))

    const snapshot = recordVerifierSnapshot({
      packageJson: '{"name":"test"}',
      tsconfig: '{}',
      diagnosticVerifier: 'export const verify = () => true',
      holdoutVerifier: 'export const h = () => true',
      requiredSources: [{ path: 'src/impl.ts', content: 'export const x = 1' }],
    })

    const violations = await verifyVerifierSnapshot(workspace, snapshot)
    expect(violations).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// C14: Workspace hash/checkpoint validation
// ---------------------------------------------------------------------------

describe('workspace snapshot and diff', () => {
  it('snapshots a workspace with deterministic hash', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ws-snap-1'))
    await writeFile(join(workspace, 'file1.ts'), 'export const a = 1')
    await writeFile(join(workspace, 'file2.ts'), 'export const b = 2')
    const snap = await snapshotWorkspace(workspace)
    expect(snap.files).toHaveLength(2)
    expect(snap.workspaceHash).toHaveLength(16)
  })

  it('same content produces same workspace hash', async () => {
    const ws1 = await mkdtemp(join(tmpdir(), 'ws-snap-2a'))
    const ws2 = await mkdtemp(join(tmpdir(), 'ws-snap-2b'))
    await writeFile(join(ws1, 'file.ts'), 'export const x = 1')
    await writeFile(join(ws2, 'file.ts'), 'export const x = 1')
    const snap1 = await snapshotWorkspace(ws1)
    const snap2 = await snapshotWorkspace(ws2)
    expect(snap1.workspaceHash).toBe(snap2.workspaceHash)
  })

  it('diff detects added files', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'ws-diff-1'))
    await writeFile(join(ws, 'file1.ts'), 'content')
    const before = await snapshotWorkspace(ws)
    await writeFile(join(ws, 'file2.ts'), 'new content')
    const after = await snapshotWorkspace(ws)
    const changes = diffSnapshots(before, after)
    expect(changes.some(c => c.kind === 'added' && c.path === 'file2.ts')).toBe(true)
  })

  it('diff detects modified files', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'ws-diff-2'))
    await writeFile(join(ws, 'file.ts'), 'original')
    const before = await snapshotWorkspace(ws)
    await writeFile(join(ws, 'file.ts'), 'modified')
    const after = await snapshotWorkspace(ws)
    const changes = diffSnapshots(before, after)
    expect(changes.some(c => c.kind === 'modified' && c.path === 'file.ts')).toBe(true)
  })

  it('diff detects deleted files', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'ws-diff-3'))
    await writeFile(join(ws, 'file.ts'), 'content')
    const before = await snapshotWorkspace(ws)
    const { unlink } = await import('node:fs/promises')
    await unlink(join(ws, 'file.ts'))
    const after = await snapshotWorkspace(ws)
    const changes = diffSnapshots(before, after)
    expect(changes.some(c => c.kind === 'deleted' && c.path === 'file.ts')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// C26: Secret sanitization
// ---------------------------------------------------------------------------

describe('secret sanitization', () => {
  it('redacts API keys', () => {
    expect(sanitizeSecrets('key: sk-abcdefghijklmnopqrstuvwxyz123456')).toBe('key: <redacted-api-key>')
  })

  it('redacts Bearer tokens', () => {
    const result = sanitizeSecrets('Authorization: Bearer abc123.456.789')
    expect(result).toContain('<redacted>')
    expect(result).not.toContain('abc123.456.789')
  })

  it('redacts passwords', () => {
    const result = sanitizeSecrets('password="secret123"')
    expect(result).toContain('<redacted>')
    expect(result).not.toContain('secret123')
  })

  it('redacts database URLs', () => {
    expect(sanitizeSecrets('DATABASE_URL=postgres://user:pass@host:5432/db'))
      .toBe('DATABASE_URL=<redacted>')
  })

  it('redacts AWS keys', () => {
    expect(sanitizeSecrets('AWS_KEY: AKIAABCDEFGHIJKLMNOP')).toBe('AWS_KEY: <redacted-aws-key>')
  })

  it('preserves non-secret text', () => {
    expect(sanitizeSecrets('TypeScript typecheck must pass')).toBe('TypeScript typecheck must pass')
  })
})

// ---------------------------------------------------------------------------
// C27: Model-visible evidence filtering
// ---------------------------------------------------------------------------

describe('model-visible evidence filtering', () => {
  it('filters out secrets from evidence', () => {
    const filtered = filterModelVisibleEvidence({
      failedCriteria: ['TypeScript typecheck must pass'],
      failingTests: ['test with sk-abcdefghijklmnopqrstuvwxyz123456'],
      typeErrors: [],
      buildErrors: [],
      changedFiles: [],
    })
    expect(filtered.failingTests[0]).toBe('test with <redacted-api-key>')
  })

  it('strips absolute paths from changed files', () => {
    const filtered = filterModelVisibleEvidence({
      failedCriteria: [],
      failingTests: [],
      typeErrors: [],
      buildErrors: [],
      changedFiles: ['/Users/dawsonblock/workspace/src/index.ts'],
    })
    expect(filtered.changedFiles[0]).toBe('workspace/src/index.ts')
  })
})

// ---------------------------------------------------------------------------
// D16-D19: Economics
// ---------------------------------------------------------------------------

describe('canonical usage accounting', () => {
  it('aggregates usage from multiple events', () => {
    const total = aggregateUsage([
      { inputTokens: 100, outputTokens: 50, reasoningTokens: 0, totalTokens: 150, cacheReadTokens: 0, cacheMissTokens: 100 },
      { inputTokens: 200, outputTokens: 100, reasoningTokens: 10, totalTokens: 310, cacheReadTokens: 50, cacheMissTokens: 150 },
    ])
    expect(total.inputTokens).toBe(300)
    expect(total.outputTokens).toBe(150)
    expect(total.totalTokens).toBe(460)
    expect(total.cacheReadTokens).toBe(50)
  })

  it('empty usage produces zeros', () => {
    const total = aggregateUsage([])
    expect(total.inputTokens).toBe(0)
    expect(total.totalTokens).toBe(0)
  })
})

describe('cost invariants', () => {
  it('valid when task cost equals sum of attempt costs', () => {
    const result = verifyCostInvariant(0.03, [0.01, 0.01, 0.01])
    expect(result.valid).toBe(true)
  })

  it('invalid when task cost does not match', () => {
    const result = verifyCostInvariant(0.05, [0.01, 0.01, 0.01])
    expect(result.valid).toBe(false)
    expect(result.expected).toBe(0.03)
    expect(result.actual).toBe(0.05)
  })
})

describe('attempt invariants', () => {
  it('valid when total = flash + pro', () => {
    expect(verifyAttemptInvariant(5, 3, 2)).toBe(true)
  })

  it('invalid when total != flash + pro', () => {
    expect(verifyAttemptInvariant(5, 2, 2)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// E20: Fixture hashing
// ---------------------------------------------------------------------------

describe('fixture hashing', () => {
  it('produces deterministic 16-hex-char hash', () => {
    const hash = hashFixtureContent('implement debounce')
    expect(hash).toHaveLength(16)
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('same content produces same hash', () => {
    expect(hashFixtureContent('test')).toBe(hashFixtureContent('test'))
  })

  it('different content produces different hash', () => {
    expect(hashFixtureContent('test1')).not.toBe(hashFixtureContent('test2'))
  })

  it('computeFixtureHashes produces all four hashes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'fixture-hash'))
    await writeFile(join(workspace, 'file.ts'), 'content')
    const snap = await snapshotWorkspace(workspace)
    const hashes = computeFixtureHashes('task', 'diagnostic', 'holdout', snap)
    expect(hashes.taskHash).toHaveLength(16)
    expect(hashes.diagnosticTestHash).toHaveLength(16)
    expect(hashes.holdoutTestHash).toHaveLength(16)
    expect(hashes.workspaceHash).toHaveLength(16)
  })
})
