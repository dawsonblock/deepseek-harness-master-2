/**
 * v0.19 session-event extraction for repository-observation tracking.
 *
 * Extracts files inspected, files modified, commands executed, and tests
 * executed from the durable session event stream. The extractor examines
 * `tool/call` events and their arguments to determine which files the agent
 * observed and which it changed.
 *
 * Only file-content access counts as inspection — a filename appearing in an
 * error message or tool result does not. Paths are normalized to
 * repository-relative form before comparison.
 *
 * @module v019-session-extraction
 */

import { resolve, relative, normalize, isAbsolute } from 'node:path'

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Result of extracting repository observations from session events. */
export interface RepositoryObservation {
  /** Repository-relative paths of files whose content was inspected. */
  readonly filesInspected: readonly string[]
  /** Repository-relative paths of files that were modified or created. */
  readonly filesModified: readonly string[]
  /** Shell commands executed via the bash tool. */
  readonly commandsExecuted: readonly string[]
  /** Subset of commands that appear to run tests. */
  readonly testsExecuted: readonly string[]
}

/** Tool names that read file content. */
const FILE_READ_TOOLS = new Set(['read', 'read_image'])

/** Tool names that modify or create files. */
const FILE_WRITE_TOOLS = new Set(['edit', 'write'])

/** str_replace_editor commands that inspect file content. */
const STR_REPLACE_VIEW_COMMANDS = new Set(['view'])

/** str_replace_editor commands that modify or create files. */
const STR_REPLACE_WRITE_COMMANDS = new Set(['create', 'str_replace', 'insert'])

/** Shell-command patterns that indicate a test run. */
const TEST_COMMAND_PATTERNS = [
  /\bnpm\s+test\b/,
  /\bnpm\s+run\s+test/,
  /\bnpx\s+vitest\b/,
  /\bnpx\s+jest\b/,
  /\bpytest\b/,
  /\bcargo\s+test\b/,
  /\bgo\s+test\b/,
  /\bmvn\s+test\b/,
  /\bgradle\s+test\b/,
  /\bdotnet\s+test\b/,
  /\bruby\s+-Itest\b/,
  /\brake\s+test\b/,
]

/**
 * Normalize a path to repository-relative form.
 *
 * - Absolute paths are resolved against the workspace root.
 * - `./` prefixes are stripped.
 * - Backslash separators are converted to forward slashes.
 * - Paths outside the repository are rejected (returned as undefined).
 */
export function normalizeToRepoPath(
  rawPath: string,
  workspace: string,
): string | undefined {
  if (rawPath.length === 0) return undefined

  let p = rawPath.trim()
  if (p.length === 0) return undefined

  // Strip surrounding quotes.
  if ((p.startsWith("'") && p.endsWith("'")) || (p.startsWith('"') && p.endsWith('"'))) {
    p = p.slice(1, -1)
  }

  // Normalize separators.
  p = p.replace(/\\/g, '/')

  // Strip leading ./
  while (p.startsWith('./')) {
    p = p.slice(2)
  }

  if (isAbsolute(p)) {
    const rel = relative(resolve(workspace), resolve(p))
    if (rel.startsWith('..') || rel === '') return undefined
    return rel.replace(/\\/g, '/')
  }

  // Relative path — normalize and ensure it doesn't escape.
  const normalized = normalize(p).replace(/\\/g, '/')
  if (normalized.startsWith('../') || normalized === '..') return undefined

  return normalized
}

/**
 * Extract file paths from a bash command string.
 *
 * Recognizes common file-reading commands: cat, head, tail, sed (without -i),
 * less, more, grep, rg, ack, find with -name, and similar. Returns only paths
 * that look like file references, not flags or command names.
 */
function extractFilesFromBashCommand(command: string, workspace: string): string[] {
  const paths: string[] = []

  // Match cat/head/tail/less/more followed by file paths.
  // Avoid matching flags (starting with -) and command names.
  const catPattern = /(?:^|\s)(?:cat|head|tail|less|more|nl)\s+([^\s|;&<>]+)/g
  let match: RegExpExecArray | null
  while ((match = catPattern.exec(command)) !== null) {
    const candidate = match[1] ?? ''
    if (candidate.length > 0 && !candidate.startsWith('-')) {
      const normalized = normalizeToRepoPath(candidate, workspace)
      if (normalized !== undefined) paths.push(normalized)
    }
  }

  // Match sed -n 'Np' file or sed 's/.../.../ ' file (non-in-place only).
  const sedPattern = /(?:^|\s)sed\s+(?:-n\s+)?'[^']*'\s+([^\s|;&<>]+)/g
  while ((match = sedPattern.exec(command)) !== null) {
    const candidate = match[1] ?? ''
    if (candidate.length > 0 && !candidate.startsWith('-')) {
      const normalized = normalizeToRepoPath(candidate, workspace)
      if (normalized !== undefined) paths.push(normalized)
    }
  }

  // Match grep/rg/ack with file arguments.
  // These tools take a pattern and optional flags followed by file paths.
  // We extract all non-flag arguments after the command and check which
  // ones look like file paths (contain / or have a file extension).
  const grepPattern = /(?:^|\s)(?:grep|rg|ack)\s+(.*)/g
  while ((match = grepPattern.exec(command)) !== null) {
    const rest = match[1] ?? ''
    // Split on whitespace and find file-like arguments.
    const parts = rest.split(/\s+/).filter(p => p.length > 0)
    for (const part of parts) {
      // Skip flags.
      if (part.startsWith('-')) continue
      // Skip quoted patterns.
      if (part.startsWith("'") || part.startsWith('"')) continue
      // Must look like a file path (has / or a file extension).
      if (part.includes('/') || /\.\w+$/.test(part)) {
        const normalized = normalizeToRepoPath(part, workspace)
        if (normalized !== undefined) paths.push(normalized)
      }
    }
  }

  return paths
}

/** Check if a bash command appears to run tests. */
function isTestCommand(command: string): boolean {
  return TEST_COMMAND_PATTERNS.some(pattern => pattern.test(command))
}

/**
 * Extract repository observations from a session event stream.
 *
 * Examines `tool/call` events for file-read and file-write tools, plus
 * bash commands that read files or run tests. Returns normalized
 * repository-relative paths.
 */
export function extractRepositoryObservation(
  events: readonly SessionEvent[],
  workspace: string,
): RepositoryObservation {
  const inspected = new Set<string>()
  const modified = new Set<string>()
  const commands: string[] = []
  const tests: string[] = []

  for (const event of events) {
    if (event.type !== 'tool/call') continue

    const data = event.data as {
      name: string
      arguments: string
    }
    const toolName = data.name

    let args: Record<string, unknown>
    try {
      args = JSON.parse(data.arguments) as Record<string, unknown>
    } catch {
      continue
    }

    if (FILE_READ_TOOLS.has(toolName)) {
      const filePath = typeof args.file_path === 'string' ? args.file_path : undefined
      if (filePath !== undefined) {
        const normalized = normalizeToRepoPath(filePath, workspace)
        if (normalized !== undefined) inspected.add(normalized)
      }
    } else if (FILE_WRITE_TOOLS.has(toolName)) {
      const filePath = typeof args.file_path === 'string' ? args.file_path : undefined
      if (filePath !== undefined) {
        const normalized = normalizeToRepoPath(filePath, workspace)
        if (normalized !== undefined) {
          modified.add(normalized)
          // Writing/editing also counts as inspecting — the tool reads the file
          // content to perform the edit.
          inspected.add(normalized)
        }
      }
    } else if (toolName === 'str_replace_editor') {
      const command = typeof args.command === 'string' ? args.command : undefined
      const path = typeof args.path === 'string' ? args.path : undefined
      if (path !== undefined && command !== undefined) {
        const normalized = normalizeToRepoPath(path, workspace)
        if (normalized !== undefined) {
          if (STR_REPLACE_VIEW_COMMANDS.has(command)) {
            inspected.add(normalized)
          } else if (STR_REPLACE_WRITE_COMMANDS.has(command)) {
            modified.add(normalized)
            inspected.add(normalized)
          }
        }
      }
    } else if (toolName === 'bash' || toolName === 'pwsh') {
      const command = typeof args.command === 'string' ? args.command : undefined
      if (command !== undefined) {
        commands.push(command)
        if (isTestCommand(command)) {
          tests.push(command)
        }
        // Extract file paths from bash commands that read files.
        const bashFiles = extractFilesFromBashCommand(command, workspace)
        for (const f of bashFiles) inspected.add(f)
      }
    }
  }

  return {
    filesInspected: [...inspected].sort(),
    filesModified: [...modified].sort(),
    commandsExecuted: commands,
    testsExecuted: tests,
  }
}

/**
 * Compute the intersection of two path lists.
 * Both lists must be normalized to repository-relative form.
 */
export function intersectPaths(
  a: readonly string[],
  b: readonly string[],
): readonly string[] {
  const set = new Set(a)
  return b.filter(p => set.has(p))
}
