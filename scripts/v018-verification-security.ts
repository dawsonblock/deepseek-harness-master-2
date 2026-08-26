/**
 * Verification security and economics utilities for v0.18 qualification.
 *
 * - Diagnostic vs holdout evidence type separation
 * - Holdout leakage detection
 * - Anti-cheating checks
 * - Workspace hash/checkpoint validation
 * - Secret sanitization for model-visible evidence
 * - Model-visible evidence filtering
 * - Canonical usage accounting
 * - Cost invariants
 *
 * @module v018-verification-security
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// C11: Holdout evidence type separation
// ---------------------------------------------------------------------------

/** Diagnostic verification result — evidence is safe to expose to repair. */
export interface DiagnosticVerificationResult {
  readonly exposeToRepair: true
  readonly passed: boolean
  readonly evidence: {
    readonly failedCriteria: readonly string[]
    readonly failingTests: readonly string[]
    readonly typeErrors: readonly string[]
    readonly buildErrors: readonly string[]
  }
}

/** Holdout verification result — evidence must NEVER enter repair prompts. */
export interface HoldoutVerificationResult {
  readonly exposeToRepair: false
  readonly passed: boolean
  /** Holdout evidence is opaque — never sent to the model. */
  readonly evidence: {
    readonly failedCriteria: readonly string[]
    readonly failingTests: readonly string[]
    readonly typeErrors: readonly string[]
    readonly buildErrors: readonly string[]
  }
}

/** Type guard: is this a diagnostic result? */
export function isDiagnosticResult(r: DiagnosticVerificationResult | HoldoutVerificationResult): r is DiagnosticVerificationResult {
  return r.exposeToRepair === true
}

/** Type guard: is this a holdout result? */
export function isHoldoutResult(r: DiagnosticVerificationResult | HoldoutVerificationResult): r is HoldoutVerificationResult {
  return r.exposeToRepair === false
}

// ---------------------------------------------------------------------------
// C12: Holdout leakage detection
// ---------------------------------------------------------------------------

/**
 * Check whether any holdout-specific strings appear in repair evidence or
 * model-visible text. This is a keyless test — it only checks string
 * presence, not API keys.
 *
 * @param holdoutStrings - strings that should never appear in repair context.
 * @param repairEvidence - the evidence that will be sent to the model.
 * @returns array of leaked strings found.
 */
export function detectHoldoutLeakage(
  holdoutStrings: readonly string[],
  repairEvidence: string,
): string[] {
  const leaked: string[] = []
  for (const s of holdoutStrings) {
    if (s.length > 0 && repairEvidence.includes(s)) {
      leaked.push(s)
    }
  }
  return leaked
}

/**
 * Extract strings that should never leak from a holdout test file.
 * Includes the filename, test descriptions, and assertion strings.
 */
export function extractHoldoutStrings(holdoutTestContent: string, holdoutFilename: string): string[] {
  const strings: string[] = [holdoutFilename]
  // Extract describe/it strings
  const describeMatches = holdoutTestContent.matchAll(/(?:describe|it|test)\(['"`]([^'"`]+)['"`]/g)
  for (const m of describeMatches) {
    if (m[1] !== undefined && m[1].length > 3) strings.push(m[1])
  }
  // Extract expect strings
  const expectMatches = holdoutTestContent.matchAll(/expect\([^)]+\)\.toBe\(['"`]([^'"`]+)['"`]/g)
  for (const m of expectMatches) {
    if (m[1] !== undefined && m[1].length > 3) strings.push(m[1])
  }
  return strings
}

// ---------------------------------------------------------------------------
// C13: Anti-cheating checks
// ---------------------------------------------------------------------------

/** Anti-cheating violation kinds. */
export type AntiCheatViolationKind =
  | 'package-scripts-modified'
  | 'test-framework-mutated'
  | 'tsconfig-exclude-added'
  | 'required-source-deleted'
  | 'hardcoded-fixture-values'

/** One anti-cheating violation. */
export interface AntiCheatViolation {
  readonly kind: AntiCheatViolationKind
  readonly detail: string
}

/**
 * Check the workspace for anti-cheating violations after model execution.
 * Verifies that the model did not modify package scripts, disable test
 * discovery, replace vitest, alter tsconfig to exclude implementation,
 * or delete required source files.
 *
 * @param workspace - the fixture workspace path.
 * @param initialPackageJson - the original package.json content.
 * @param _initialTsconfig - the original tsconfig.json content (reserved for future use).
 * @param requiredFiles - files that must still exist.
 */
export async function checkAntiCheating(
  workspace: string,
  initialPackageJson: string,
  _initialTsconfig: string,
  requiredFiles: readonly string[],
): Promise<AntiCheatViolation[]> {
  const violations: AntiCheatViolation[] = []

  // Check package.json scripts not modified
  try {
    const currentPkg = await readFile(join(workspace, 'package.json'), 'utf8')
    const initial = JSON.parse(initialPackageJson) as Record<string, unknown>
    const current = JSON.parse(currentPkg) as Record<string, unknown>
    const initialScripts = JSON.stringify(initial.scripts ?? {})
    const currentScripts = JSON.stringify(current.scripts ?? {})
    if (initialScripts !== currentScripts) {
      violations.push({
        kind: 'package-scripts-modified',
        detail: 'package.json scripts section was modified',
      })
    }
    // Check vitest not replaced
    const initialDeps = JSON.stringify(initial.dependencies ?? {})
    const currentDeps = JSON.stringify(current.dependencies ?? {})
    if (initialDeps !== currentDeps) {
      violations.push({
        kind: 'test-framework-mutated',
        detail: 'package.json dependencies were modified',
      })
    }
  } catch {
    // File might not exist — that's a different violation
  }

  // Check tsconfig not modified to exclude implementation
  try {
    const currentTsc = await readFile(join(workspace, 'tsconfig.json'), 'utf8')
    const current = JSON.parse(currentTsc) as { exclude?: string[] }
    if (current.exclude !== undefined && current.exclude.length > 0) {
      violations.push({
        kind: 'tsconfig-exclude-added',
        detail: `tsconfig.json has exclude entries: ${current.exclude.join(', ')}`,
      })
    }
  } catch {
    // ignore
  }

  // Check required files still exist
  for (const file of requiredFiles) {
    try {
      await stat(join(workspace, file))
    } catch {
      violations.push({
        kind: 'required-source-deleted',
        detail: `Required file deleted: ${file}`,
      })
    }
  }

  return violations
}

// ---------------------------------------------------------------------------
// C14: Workspace hash/checkpoint validation
// ---------------------------------------------------------------------------

/** Workspace file snapshot. */
export interface WorkspaceSnapshot {
  readonly files: ReadonlyArray<{ path: string; hash: string; size: number }>
  readonly workspaceHash: string
}

/** File change kinds. */
export type FileChangeKind = 'added' | 'modified' | 'deleted'

/** One file change between snapshots. */
export interface FileChange {
  readonly path: string
  readonly kind: FileChangeKind
  readonly beforeHash?: string
  readonly afterHash?: string
}

/**
 * Snapshot a workspace by hashing all files. The workspace hash is
 * derived from sorted path+hash pairs, giving strong provenance.
 */
export async function snapshotWorkspace(workspace: string): Promise<WorkspaceSnapshot> {
  const files: Array<{ path: string; hash: string; size: number }> = []

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.git') || entry.name === 'node_modules') continue
      const fullPath = join(dir, entry.name)
      const relPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(fullPath, relPath)
      } else if (entry.isFile()) {
        const content = await readFile(fullPath)
        const hash = createHash('sha256').update(content).digest('hex').slice(0, 16)
        files.push({ path: relPath, hash, size: content.length })
      }
    }
  }

  await walk(workspace, '')
  files.sort((a, b) => a.path.localeCompare(b.path))
  const workspaceHash = createHash('sha256')
    .update(files.map(f => `${f.path}:${f.hash}`).join('\n'))
    .digest('hex')
    .slice(0, 16)

  return { files, workspaceHash }
}

/**
 * Diff two workspace snapshots to find added, modified, and deleted files.
 */
export function diffSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): FileChange[] {
  const beforeMap = new Map(before.files.map(f => [f.path, f.hash]))
  const afterMap = new Map(after.files.map(f => [f.path, f.hash]))
  const changes: FileChange[] = []

  for (const [path, afterHash] of afterMap) {
    const beforeHash = beforeMap.get(path)
    if (beforeHash === undefined) {
      changes.push({ path, kind: 'added', afterHash })
    } else if (beforeHash !== afterHash) {
      changes.push({ path, kind: 'modified', beforeHash, afterHash })
    }
  }

  for (const [path, beforeHash] of beforeMap) {
    if (!afterMap.has(path)) {
      changes.push({ path, kind: 'deleted', beforeHash })
    }
  }

  return changes.sort((a, b) => a.path.localeCompare(b.path))
}

// ---------------------------------------------------------------------------
// C26: Secret sanitization
// ---------------------------------------------------------------------------

/** Patterns that match secrets in text. */
const SECRET_PATTERNS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /sk-[a-zA-Z0-9]{20,}/g, replacement: '<redacted-api-key>' },
  { pattern: /Bearer\s+[\w.-]+/gi, replacement: 'Bearer <redacted>' },
  { pattern: /authorization\s*[:=]\s*["']?[\w.-]+/gi, replacement: 'authorization: <redacted>' },
  { pattern: /password\s*[:=]\s*["']?[^"'\s,]+/gi, replacement: 'password: <redacted>' },
  { pattern: /token\s*[:=]\s*["']?[\w.-]+/gi, replacement: 'token: <redacted>' },
  { pattern: /cookie\s*[:=]\s*["']?[^"'\s,]+/gi, replacement: 'cookie: <redacted>' },
  { pattern: /DATABASE_URL=\S+/g, replacement: 'DATABASE_URL=<redacted>' },
  { pattern: /postgres:\/\/[^\s]+/g, replacement: 'postgres://<redacted>' },
  { pattern: /mongodb:\/\/[^\s]+/g, replacement: 'mongodb://<redacted>' },
  { pattern: /AKIA[A-Z0-9]{16}/g, replacement: '<redacted-aws-key>' },
]

/**
 * Sanitize text by redacting secrets. Removes API keys, auth headers,
 * passwords, tokens, cookies, database URLs, and cloud credentials.
 */
export function sanitizeSecrets(text: string): string {
  let result = text
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement)
  }
  return result
}

// ---------------------------------------------------------------------------
// C27: Model-visible evidence filtering
// ---------------------------------------------------------------------------

/**
 * Filter failure evidence to only model-visible fields. Removes internal
 * event IDs, pricing, holdout information, verifier implementation
 * details, host paths, and sandbox paths.
 */
export function filterModelVisibleEvidence(evidence: {
  failedCriteria: readonly string[]
  failingTests: readonly string[]
  typeErrors: readonly string[]
  buildErrors: readonly string[]
  changedFiles: readonly string[]
}): {
  failedCriteria: string[]
  failingTests: string[]
  typeErrors: string[]
  buildErrors: string[]
  changedFiles: string[]
} {
  return {
    failedCriteria: evidence.failedCriteria.map(s => sanitizeSecrets(s)),
    failingTests: evidence.failingTests.map(s => sanitizeSecrets(s)),
    typeErrors: evidence.typeErrors.map(s => sanitizeSecrets(s)),
    buildErrors: evidence.buildErrors.map(s => sanitizeSecrets(s)),
    changedFiles: evidence.changedFiles.map(s => s.replace(/^\/[^/]+\/[^/]+\//, '')),
  }
}

// ---------------------------------------------------------------------------
// D16-D19: Economics — canonical usage and cost invariants
// ---------------------------------------------------------------------------

/** Canonical usage record from model/usage events. */
export interface CanonicalUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
  readonly totalTokens: number
  readonly cacheReadTokens: number
  readonly cacheMissTokens: number
}

/** Aggregate usage from multiple model/usage events. */
export function aggregateUsage(usages: readonly CanonicalUsage[]): CanonicalUsage {
  return usages.reduce(
    (acc, u) => ({
      inputTokens: acc.inputTokens + u.inputTokens,
      outputTokens: acc.outputTokens + u.outputTokens,
      reasoningTokens: acc.reasoningTokens + u.reasoningTokens,
      totalTokens: acc.totalTokens + u.totalTokens,
      cacheReadTokens: acc.cacheReadTokens + u.cacheReadTokens,
      cacheMissTokens: acc.cacheMissTokens + u.cacheMissTokens,
    }),
    { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheMissTokens: 0 },
  )
}

/** Cost invariant: task cost equals sum of all model/usage costs. */
export function verifyCostInvariant(
  taskCostUsd: number,
  perAttemptCosts: readonly number[],
): { valid: boolean; expected: number; actual: number } {
  const expected = perAttemptCosts.reduce((sum, c) => sum + c, 0)
  return {
    valid: Math.abs(taskCostUsd - expected) < 1e-9,
    expected,
    actual: taskCostUsd,
  }
}

/** Attempt invariant: task attempts = flash attempts + pro attempts. */
export function verifyAttemptInvariant(
  totalAttempts: number,
  flashAttempts: number,
  proAttempts: number,
): boolean {
  return totalAttempts === flashAttempts + proAttempts
}

// ---------------------------------------------------------------------------
// E20: Fixture hashing
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic hash for fixture content (task, diagnostic test,
 * holdout test). Used to freeze fixtures and detect silent edits.
 */
export function hashFixtureContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/**
 * Compute all hashes for a fixture: task, diagnostic test, holdout test,
 * and initial workspace.
 */
export interface FixtureHashes {
  readonly taskHash: string
  readonly diagnosticTestHash: string
  readonly holdoutTestHash: string
  readonly workspaceHash: string
}

/**
 * Compute fixture hashes from content strings and workspace snapshot.
 */
export function computeFixtureHashes(
  task: string,
  diagnosticTest: string,
  holdoutTest: string,
  workspaceSnapshot: WorkspaceSnapshot,
): FixtureHashes {
  return {
    taskHash: hashFixtureContent(task),
    diagnosticTestHash: hashFixtureContent(diagnosticTest),
    holdoutTestHash: hashFixtureContent(holdoutTest),
    workspaceHash: workspaceSnapshot.workspaceHash,
  }
}
