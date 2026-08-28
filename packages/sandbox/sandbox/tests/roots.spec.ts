/**
 * Tests for the writable-root derivation: the mode's meaning as a canonical
 * allow-list. Pinned here so the fs fence and the Seatbelt profile — both
 * deriving from `writableRoots` — cannot drift.
 */

import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalPath, readableRoots, writableRoots } from '@deepseek-ai/dsh-sandbox'

describe('canonicalPath', () => {
  it('resolves symlinks (an existing path realpaths)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-roots-'))
    expect(canonicalPath(dir)).toBe(realpathSync.native(dir))
  })

  it('returns the spelling as-is when the path cannot be resolved (conservative — matches nothing until it exists)', () => {
    expect(canonicalPath('/does/not/exist/anywhere-xyz')).toBe('/does/not/exist/anywhere-xyz')
  })
})

describe('writableRoots', () => {
  it('read-only grants nothing', () => {
    expect(writableRoots({ mode: 'read-only', workspaceRoot: process.cwd() })).toEqual([])
  })

  it('workspace-write grants the workspace root plus the platform temp areas, canonical and deduplicated', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    const roots = writableRoots({ mode: 'workspace-write', workspaceRoot: ws })
    expect(roots).toContain(realpathSync.native(ws))
    expect(roots).toContain(canonicalPath('/tmp'))
    expect(roots).toContain(realpathSync.native(tmpdir()))
    // Deduplicated after canonicalization (/tmp and os.tmpdir() may coincide).
    expect(new Set(roots).size).toBe(roots.length)
  })

  it('workspace-isolated grants only the workspace root, excluding host /tmp and os.tmpdir()', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-iso-'))
    const roots = writableRoots({ mode: 'workspace-isolated', workspaceRoot: ws })
    expect(roots).toEqual([realpathSync.native(ws)])
    expect(roots).not.toContain(canonicalPath('/tmp'))
    expect(roots).not.toContain(realpathSync.native(tmpdir()))
  })
})

describe('readableRoots', () => {
  it('workspace-isolated allows only the workspace root', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-iso-read-'))
    const roots = readableRoots({ mode: 'workspace-isolated', workspaceRoot: ws })
    expect(roots).toEqual([realpathSync.native(ws)])
  })

  it('workspace-write returns empty (reads are unfenced)', () => {
    expect(readableRoots({ mode: 'workspace-write', workspaceRoot: process.cwd() })).toEqual([])
  })

  it('read-only returns empty (reads are unfenced)', () => {
    expect(readableRoots({ mode: 'read-only', workspaceRoot: process.cwd() })).toEqual([])
  })
})
