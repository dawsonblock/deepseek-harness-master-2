/**
 * Tests for v0.19 session-event repository-observation extraction.
 *
 * @module v019-session-extraction.spec
 */

import { describe, it, expect } from 'vitest'

import {
  normalizeToRepoPath,
  extractRepositoryObservation,
  intersectPaths,
} from './v019-session-extraction.ts'

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { CallId } from '@deepseek-ai/dsh-llm'

/** Build a synthetic tool/call event. */
function toolCall(name: string, args: Record<string, unknown>): SessionEvent<'tool/call'> {
  return {
    type: 'tool/call',
    seq: 0,
    time: Date.now(),
    data: {
      turn: 1,
      step: 1,
      callId: CallId('call-1'),
      name,
      arguments: JSON.stringify(args),
    },
  }
}

const WORKSPACE = '/repo'

describe('v019-session-extraction', () => {
  describe('normalizeToRepoPath', () => {
    it('normalizes a relative path', () => {
      expect(normalizeToRepoPath('src/index.ts', WORKSPACE)).toBe('src/index.ts')
    })

    it('strips ./ prefix', () => {
      expect(normalizeToRepoPath('./src/foo.ts', WORKSPACE)).toBe('src/foo.ts')
    })

    it('normalizes backslashes to forward slashes', () => {
      expect(normalizeToRepoPath('src\\foo.ts', WORKSPACE)).toBe('src/foo.ts')
    })

    it('normalizes an absolute path inside the workspace', () => {
      expect(normalizeToRepoPath('/repo/src/index.ts', WORKSPACE)).toBe('src/index.ts')
    })

    it('rejects an absolute path outside the workspace', () => {
      expect(normalizeToRepoPath('/etc/passwd', WORKSPACE)).toBeUndefined()
    })

    it('rejects a path that escapes via ..', () => {
      expect(normalizeToRepoPath('../../../etc/passwd', WORKSPACE)).toBeUndefined()
    })

    it('rejects an empty path', () => {
      expect(normalizeToRepoPath('', WORKSPACE)).toBeUndefined()
    })

    it('strips surrounding quotes', () => {
      expect(normalizeToRepoPath("'src/foo.ts'", WORKSPACE)).toBe('src/foo.ts')
      expect(normalizeToRepoPath('"src/foo.ts"', WORKSPACE)).toBe('src/foo.ts')
    })
  })

  describe('extractRepositoryObservation', () => {
    it('captures a direct read of a reference-fix file', () => {
      const events = [toolCall('read', { file_path: 'src/index.ts' })]
      const obs = extractRepositoryObservation(events, WORKSPACE)
      expect(obs.filesInspected).toContain('src/index.ts')
    })

    it('captures grep/search surfacing a file', () => {
      const events = [toolCall('bash', { command: 'grep -r "sortNumbers" src/index.ts' })]
      const obs = extractRepositoryObservation(events, WORKSPACE)
      expect(obs.filesInspected).toContain('src/index.ts')
    })

    it('captures cat/head/tail reading a file', () => {
      const events = [toolCall('bash', { command: 'cat src/index.ts' })]
      const obs = extractRepositoryObservation(events, WORKSPACE)
      expect(obs.filesInspected).toContain('src/index.ts')
    })

    it('captures modifying a file without previously reading it', () => {
      const events = [toolCall('edit', { file_path: 'src/index.ts', old_string: 'a', new_string: 'b' })]
      const obs = extractRepositoryObservation(events, WORKSPACE)
      expect(obs.filesModified).toContain('src/index.ts')
      // Editing also counts as inspection — the tool reads the file content.
      expect(obs.filesInspected).toContain('src/index.ts')
    })

    it('does not count an unrelated file as a reference-fix file', () => {
      const events = [toolCall('read', { file_path: 'README.md' })]
      const obs = extractRepositoryObservation(events, WORKSPACE)
      expect(obs.filesInspected).toContain('README.md')
      expect(obs.filesInspected).not.toContain('src/index.ts')
    })

    it('normalizes absolute paths to repo-relative', () => {
      const events = [toolCall('read', { file_path: '/repo/src/index.ts' })]
      const obs = extractRepositoryObservation(events, WORKSPACE)
      expect(obs.filesInspected).toContain('src/index.ts')
    })

    it('normalizes ./src/foo.ts to src/foo.ts', () => {
      const events = [toolCall('read', { file_path: './src/foo.ts' })]
      const obs = extractRepositoryObservation(events, WORKSPACE)
      expect(obs.filesInspected).toContain('src/foo.ts')
      expect(obs.filesInspected).not.toContain('./src/foo.ts')
    })

    it('rejects outside-workspace paths', () => {
      const events = [toolCall('read', { file_path: '/etc/passwd' })]
      const obs = extractRepositoryObservation(events, WORKSPACE)
      expect(obs.filesInspected).toEqual([])
    })

    it('collapses duplicate reads to one path', () => {
      const events = [
        toolCall('read', { file_path: 'src/index.ts' }),
        toolCall('read', { file_path: 'src/index.ts' }),
        toolCall('read', { file_path: 'src/index.ts' }),
      ]
      const obs = extractRepositoryObservation(events, WORKSPACE)
      expect(obs.filesInspected).toEqual(['src/index.ts'])
    })

    it('handles a reference fix touching multiple files', () => {
      const events = [
        toolCall('read', { file_path: 'src/a.ts' }),
        toolCall('read', { file_path: 'src/b.ts' }),
        toolCall('edit', { file_path: 'src/c.ts', old_string: 'x', new_string: 'y' }),
      ]
      const obs = extractRepositoryObservation(events, WORKSPACE)
      expect(obs.filesInspected).toContain('src/a.ts')
      expect(obs.filesInspected).toContain('src/b.ts')
      expect(obs.filesInspected).toContain('src/c.ts')
      expect(obs.filesModified).toEqual(['src/c.ts'])
    })

    it('captures str_replace_editor view as inspection', () => {
      const events = [toolCall('str_replace_editor', { command: 'view', path: 'src/index.ts' })]
      const obs = extractRepositoryObservation(events, WORKSPACE)
      expect(obs.filesInspected).toContain('src/index.ts')
      expect(obs.filesModified).toEqual([])
    })

    it('captures str_replace_editor create as modification', () => {
      const events = [toolCall('str_replace_editor', { command: 'create', path: 'src/new.ts', file_text: 'x' })]
      const obs = extractRepositoryObservation(events, WORKSPACE)
      expect(obs.filesModified).toContain('src/new.ts')
      expect(obs.filesInspected).toContain('src/new.ts')
    })

    it('captures str_replace_editor str_replace as modification', () => {
      const events = [toolCall('str_replace_editor', { command: 'str_replace', path: 'src/index.ts', old_str: 'a', new_str: 'b' })]
      const obs = extractRepositoryObservation(events, WORKSPACE)
      expect(obs.filesModified).toContain('src/index.ts')
    })

    it('captures test commands', () => {
      const events = [toolCall('bash', { command: 'npm test' })]
      const obs = extractRepositoryObservation(events, WORKSPACE)
      expect(obs.testsExecuted).toContain('npm test')
    })

    it('captures non-test commands separately', () => {
      const events = [toolCall('bash', { command: 'ls -la' })]
      const obs = extractRepositoryObservation(events, WORKSPACE)
      expect(obs.commandsExecuted).toContain('ls -la')
      expect(obs.testsExecuted).toEqual([])
    })

    it('does not count a filename in an error message as inspected', () => {
      // A tool/result event with a filename in the text — not a tool/call.
      // The extractor only looks at tool/call events, so this is ignored.
      const event = {
        type: 'tool/result',
        seq: 1,
        time: Date.now(),
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'tool',
            content: [{ type: 'text', text: 'Error in src/index.ts:10' }],
          },
        },
      } as unknown as SessionEvent
      const obs = extractRepositoryObservation([event], WORKSPACE)
      expect(obs.filesInspected).toEqual([])
    })

    it('handles malformed JSON arguments gracefully', () => {
      const event = {
        type: 'tool/call',
        seq: 0,
        time: Date.now(),
        data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: 'not json' },
      } as unknown as SessionEvent
      const obs = extractRepositoryObservation([event], WORKSPACE)
      expect(obs.filesInspected).toEqual([])
    })

    it('ignores non-tool/call events', () => {
      const event = {
        type: 'model/usage',
        seq: 0,
        time: Date.now(),
        data: { turn: 1, step: 1, attempt: 1, provider: 'deepseek', model: 'flash', usage: {} },
      } as unknown as SessionEvent
      const obs = extractRepositoryObservation([event], WORKSPACE)
      expect(obs.filesInspected).toEqual([])
    })
  })

  describe('intersectPaths', () => {
    it('returns the intersection of two path lists', () => {
      expect(intersectPaths(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual(['b', 'c'])
    })

    it('returns empty when no overlap', () => {
      expect(intersectPaths(['a', 'b'], ['c', 'd'])).toEqual([])
    })

    it('handles empty lists', () => {
      expect(intersectPaths([], ['a'])).toEqual([])
      expect(intersectPaths(['a'], [])).toEqual([])
    })
  })
})
