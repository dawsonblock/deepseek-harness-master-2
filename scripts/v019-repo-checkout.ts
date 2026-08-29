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
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const CLONE_CACHE = new Map<string, string>()

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
