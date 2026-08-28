/**
 * v0.19 repository checkout system.
 *
 * Clones and checks out repositories at specific commits for evaluation.
 * Caches clones to avoid re-cloning for multiple tasks from the same repo.
 *
 * @module v019-repo-checkout
 */

import { mkdir, rm } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const CLONE_CACHE = new Map<string, string>()

/**
 * Clone a repository (or reuse a cached clone) and checkout a specific commit
 * into a fresh working directory.
 *
 * @param repoUrl - git clone URL
 * @param commit - commit SHA to checkout
 * @param repoName - short name for cache key and directory naming
 * @returns absolute path to the checked-out workspace
 */
export async function checkoutRepo(
  repoUrl: string,
  commit: string,
  repoName: string,
): Promise<string> {
  const cacheKey = `${repoName}:${repoUrl}`
  let cachePath = CLONE_CACHE.get(cacheKey)

  if (cachePath === undefined) {
    cachePath = join(tmpdir(), `v019-repo-${repoName}-${Date.now()}`)
    execSync(`git clone --no-checkout "${repoUrl}" "${cachePath}"`, { stdio: 'pipe', timeout: 120000 })
    CLONE_CACHE.set(cacheKey, cachePath)
  }

  const workspace = join(tmpdir(), `v019-task-${repoName}-${commit.slice(0, 8)}-${Date.now()}`)
  await mkdir(workspace, { recursive: true })
  execSync(`git --git-dir="${cachePath}/.git" worktree add --detach "${workspace}" "${commit}"`, {
    stdio: 'pipe',
    timeout: 60000,
  })
  return workspace
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
  try {
    execSync(`git worktree remove --force "${workspace}"`, { stdio: 'pipe', timeout: 30000 })
  } catch { /* ignore */ }
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
