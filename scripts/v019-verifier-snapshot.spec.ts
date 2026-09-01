/**
 * Multi-file verifier regression test.
 *
 * Tests that the VerifierSnapshot correctly handles the scenario where:
 * 1. Baseline has an existing test file (immutable).
 * 2. Model creates a new test file (allowed).
 * 3. Model modifies an existing test file (rejected).
 * 4. Model creates a file in mustRemainAbsent (rejected).
 *
 * @module v019-verifier-snapshot.spec
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { freezeVerifierSnapshot, verifyAgainstSnapshot } from './v019-trajectory-collector.ts'

function makeBaselineWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'v019-verifier-snap-'))
  mkdirSync(join(dir, 'src'))
  mkdirSync(join(dir, 'tests'))
  writeFileSync(join(dir, 'package.json'), '{"name":"test","version":"1.0.0"}')
  writeFileSync(join(dir, 'tsconfig.json'), '{"compilerOptions":{}}')
  writeFileSync(join(dir, 'vitest.config.ts'), 'export default {}')
  writeFileSync(join(dir, 'src/index.ts'), 'export const x = 1')
  writeFileSync(join(dir, 'tests/existing.test.ts'), 'it("passes", () => {})')
  return dir
}

describe('v019 VerifierSnapshot multi-file regression', () => {
  it('PASS: model creates a new test file (tests/Stack.test.ts) without modifying existing tests', () => {
    const workspace = makeBaselineWorkspace()
    try {
      const snapshot = freezeVerifierSnapshot(workspace)

      // Model creates a new test file — this should be allowed.
      writeFileSync(join(workspace, 'tests/Stack.test.ts'), 'it("stacks", () => {})')
      // Model creates a new source file — this should be allowed.
      writeFileSync(join(workspace, 'src/Stack.ts'), 'export class Stack {}')

      expect(verifyAgainstSnapshot(workspace, snapshot)).toBe(true)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('DENY: model modifies an existing test file (tests/existing.test.ts)', () => {
    const workspace = makeBaselineWorkspace()
    try {
      const snapshot = freezeVerifierSnapshot(workspace)

      // Model modifies an existing test file — this must be rejected.
      writeFileSync(join(workspace, 'tests/existing.test.ts'), 'it("hacked", () => {})')

      expect(verifyAgainstSnapshot(workspace, snapshot)).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('DENY: model modifies package.json', () => {
    const workspace = makeBaselineWorkspace()
    try {
      const snapshot = freezeVerifierSnapshot(workspace)

      // Model modifies package.json — this must be rejected.
      writeFileSync(join(workspace, 'package.json'), '{"name":"hacked","version":"2.0.0"}')

      expect(verifyAgainstSnapshot(workspace, snapshot)).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('DENY: model deletes an existing test file', () => {
    const workspace = makeBaselineWorkspace()
    try {
      const snapshot = freezeVerifierSnapshot(workspace)

      // Model deletes an existing test file — this must be rejected.
      rmSync(join(workspace, 'tests/existing.test.ts'))

      expect(verifyAgainstSnapshot(workspace, snapshot)).toBe(false)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('PASS: snapshot is deterministic for identical workspaces', () => {
    const ws1 = makeBaselineWorkspace()
    const ws2 = makeBaselineWorkspace()
    try {
      const snap1 = freezeVerifierSnapshot(ws1)
      const snap2 = freezeVerifierSnapshot(ws2)

      expect(snap1.controlledHash).toBe(snap2.controlledHash)
      expect(snap1.controlledPaths).toEqual(snap2.controlledPaths)
    } finally {
      rmSync(ws1, { recursive: true, force: true })
      rmSync(ws2, { recursive: true, force: true })
    }
  })

  it('PASS: model creates files in src/ without touching verifier-controlled files', () => {
    const workspace = makeBaselineWorkspace()
    try {
      const snapshot = freezeVerifierSnapshot(workspace)

      // Model creates multiple new source files.
      writeFileSync(join(workspace, 'src/new1.ts'), 'export const a = 1')
      writeFileSync(join(workspace, 'src/new2.ts'), 'export const b = 2')
      mkdirSync(join(workspace, 'src/sub'))
      writeFileSync(join(workspace, 'src/sub/deep.ts'), 'export const c = 3')

      expect(verifyAgainstSnapshot(workspace, snapshot)).toBe(true)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
