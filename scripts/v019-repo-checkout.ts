/**
 * v0.19 repository checkout system.
 *
 * Clones and checks out repositories at specific commits for evaluation.
 * Caches clones to avoid re-cloning for multiple tasks from the same repo.
 *
 * The model workspace is a plain archive snapshot of the base commit with no
 * `.git` directory, so the model cannot access future Git history (including
 * the reference fix). The cached clone remains available outside the model
 * workspace for verifier-only operations: reference fix diffing, rollback
 * restoration, and provenance hashing.
 *
 * @module v019-repo-checkout
 */

import { mkdir, rm } from 'node:fs/promises'
import { statSync, readdirSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const CLONE_CACHE = new Map<string, string>()

/** A frozen post-setup baseline snapshot for exact rollback restoration. */
export interface BaselineSnapshot {
  /** Path to the tar archive containing the full workspace state at freeze time. */
  readonly archivePath: string
  /** SHA-256 hash of the workspace contents at freeze time (excludes node_modules/.git/dist). */
  readonly hash: string
}

/**
 * Freeze a deterministic baseline snapshot B0 after setup completes. Every
 * repair attempt restores exactly B0, not a reconstruction from git archive
 * plus preserved directories. The snapshot is a tar archive of the full
 * workspace (including node_modules) plus a content hash for verification.
 *
 * @param workspace - the workspace root to snapshot.
 * @returns the snapshot archive path and content hash.
 */
export function freezeBaseline(workspace: string): BaselineSnapshot {
  const archivePath = `${workspace}.baseline.tar`
  execSync(`tar -cf "${archivePath}" -C "${workspace}" .`, { stdio: 'pipe', timeout: 120000 })
  const hash = hashWorkspaceContents(workspace)
  return { archivePath, hash }
}

/**
 * Restore a workspace from a frozen baseline snapshot. Extracts the tar
 * archive over a clean workspace directory, then verifies the restored
 * content hash matches the frozen hash.
 *
 * @param workspace - the workspace root to restore into.
 * @param snapshot - the baseline snapshot to restore from.
 * @returns the restored workspace content hash, or undefined if verification failed.
 */
export function restoreBaseline(workspace: string, snapshot: BaselineSnapshot): { success: boolean; resultHash?: string } {
  try {
    rmSync(workspace, { recursive: true, force: true })
    mkdirSync(workspace, { recursive: true })
    execSync(`tar -xf "${snapshot.archivePath}" -C "${workspace}"`, { stdio: 'pipe', timeout: 120000 })
    const resultHash = hashWorkspaceContents(workspace)
    return { success: resultHash === snapshot.hash, resultHash }
  } catch {
    return { success: false }
  }
}

/**
 * Compute a SHA-256 hash of workspace source files, excluding node_modules,
 * .git, and dist. The canonical workspace hash used for verification,
 * completion authorization, baseline freeze/restore, rollback verification,
 * and composed qualification. All subsystems that need a workspace content
 * hash must use this function to ensure semantic consistency.
 *
 * @param workspace - the workspace root to hash.
 * @returns a hex SHA-256 digest.
 */
export function hashWorkspaceContents(workspace: string): string {
  const hash = createHash('sha256')
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.isFile()) {
        const rel = relative(workspace, fullPath)
        hash.update(rel).update(':')
        try {
          hash.update(readFileSync(fullPath))
        } catch {
          hash.update('[unreadable]')
        }
        hash.update('\n')
      }
    }
  }
  walk(workspace)
  return hash.digest('hex')
}

/** A repository checkout result: the model workspace and the verifier-only clone. */
export interface RepoCheckout {
  /** Model-visible workspace: a plain snapshot of the base commit, no `.git`. */
  readonly workspace: string
  /** Verifier-only clone directory with full `.git` history (never model-visible). */
  readonly cloneDir: string
  /** The base commit SHA the workspace was extracted from. */
  readonly commit: string
}

/**
 * Clone a repository (or reuse a cached clone) and extract a specific commit
 * into a fresh working directory using `git archive`. The workspace has no
 * `.git` directory, so the model cannot see future commits, branches, or tags.
 *
 * @param repoUrl - git clone URL
 * @param commit - commit SHA to extract
 * @param repoName - short name for cache key and directory naming
 * @returns the checkout result with workspace and clone paths
 */
export async function checkoutRepo(
  repoUrl: string,
  commit: string,
  repoName: string,
): Promise<RepoCheckout> {
  const cacheKey = `${repoName}:${repoUrl}`
  let cloneDir = CLONE_CACHE.get(cacheKey)

  if (cloneDir === undefined) {
    cloneDir = join(tmpdir(), `v019-repo-${repoName}-${Date.now()}`)
    execSync(`git clone --no-checkout "${repoUrl}" "${cloneDir}"`, { stdio: 'pipe', timeout: 120000 })
    CLONE_CACHE.set(cacheKey, cloneDir)
  }

  const workspace = join(tmpdir(), `v019-task-${repoName}-${commit.slice(0, 8)}-${Date.now()}`)
  await mkdir(workspace, { recursive: true })
  // Extract the base commit into the workspace without any Git metadata.
  // git archive writes a tar stream of the tree at the given commit; tar -x
  // extracts it into the workspace. No .git directory is created.
  execSync(
    `git --git-dir="${cloneDir}/.git" archive "${commit}" | tar -x -C "${workspace}"`,
    { stdio: 'pipe', timeout: 60000 },
  )
  return { workspace, cloneDir, commit }
}

/**
 * Restore a workspace to the base commit by re-extracting from the cached
 * clone. Used by the rollback provider after a failed repair attempt.
 *
 * @param checkout - the original checkout result
 */
export async function restoreWorkspace(checkout: RepoCheckout): Promise<void> {
  await rm(checkout.workspace, { recursive: true, force: true })
  await mkdir(checkout.workspace, { recursive: true })
  execSync(
    `git --git-dir="${checkout.cloneDir}/.git" archive "${checkout.commit}" | tar -x -C "${checkout.workspace}"`,
    { stdio: 'pipe', timeout: 60000 },
  )
}

/**
 * Install dependencies in a workspace using the detected package manager.
 *
 * @param workspace - absolute path to the repository workspace
 * @param installCommand - override install command (default: auto-detect)
 */
export async function installDependencies(
  workspace: string,
  installCommand?: string,
): Promise<void> {
  const cmd = installCommand ?? detectInstallCommand(workspace)
  execSync(cmd, { cwd: workspace, stdio: 'pipe', timeout: 300000 })
}

function detectInstallCommand(workspace: string): string {
  try {
    if (statSync(join(workspace, 'pnpm-lock.yaml')).isFile()) return 'pnpm install --frozen-lockfile'
    if (statSync(join(workspace, 'yarn.lock')).isFile()) return 'yarn install --frozen-lockfile'
    if (statSync(join(workspace, 'bun.lockb')).isFile()) return 'bun install --frozen-lockfile'
  } catch { /* fall through */ }
  return 'npm install'
}

/** Clean up a workspace after task completion. */
export async function cleanupWorkspace(workspace: string): Promise<void> {
  await rm(workspace, { recursive: true, force: true })
}

/** Record repository metadata for trajectory provenance. */
export interface RepoMetadata {
  readonly name: string
  readonly url: string
  readonly baseCommit: string
  readonly size: 'small' | 'medium' | 'large'
  readonly loc: number
  readonly fileCount: number
  readonly packageCount: number
  readonly testCount: number
}

/** Compute repository metadata from a checked-out workspace. */
export function computeRepoMetadata(workspace: string, manifest: {
  name: string
  url: string
  baseCommit: string
  size: 'small' | 'medium' | 'large'
}): RepoMetadata {
  let loc = 0
  let fileCount = 0
  try {
    const output = execSync(
      'find . -type f \\( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" \\) -not -path "*/node_modules/*" -not -path "*/.git/*" | head -5000',
      { cwd: workspace, encoding: 'utf8', timeout: 30000 },
    )
    const files = output.trim().split('\n').filter(f => f.length > 0)
    fileCount = files.length
    for (const file of files) {
      try {
        const wcOutput = execSync(`wc -l "${file}"`, { cwd: workspace, encoding: 'utf8', timeout: 5000 })
        const lines = parseInt(wcOutput.trim().split(/\s+/)[0] ?? '0', 10)
        loc += lines
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  let packageCount = 0
  try {
    const output = execSync(
      'find . -name "package.json" -not -path "*/node_modules/*" | wc -l',
      { cwd: workspace, encoding: 'utf8', timeout: 10000 },
    )
    packageCount = parseInt(output.trim(), 10)
  } catch { /* skip */ }

  let testCount = 0
  try {
    const output = execSync(
      'find . -type f \\( -name "*.test.ts" -o -name "*.test.tsx" -o -name "*.test.js" -o -name "*.spec.ts" -o -name "*.spec.tsx" -o -name "*.spec.js" \\) -not -path "*/node_modules/*" | wc -l',
      { cwd: workspace, encoding: 'utf8', timeout: 10000 },
    )
    testCount = parseInt(output.trim(), 10)
  } catch { /* skip */ }

  return {
    name: manifest.name,
    url: manifest.url,
    baseCommit: manifest.baseCommit,
    size: manifest.size,
    loc,
    fileCount,
    packageCount,
    testCount,
  }
}
