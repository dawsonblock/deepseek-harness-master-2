/**
 * Keyless negative sandbox test: verifies that workspace-write mode restricts
 * READS outside the workspace, not merely writes.
 *
 * Creates a sentinel file outside the workspace, then attempts to read it
 * from inside the sandbox. Also verifies normal reads/writes inside the
 * workspace still succeed.
 *
 * Exit code 0: read isolation confirmed (sentinel read denied, workspace OK).
 * Exit code 1: read isolation missing (sentinel read succeeded — FAIL).
 * Exit code 2: sandbox unavailable on this platform (skip, not a failure).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

/** Confine a shell command under `policy` and run it for real. */
function runConfined(sandbox: LocalSandboxProvider, command: string, policy: SandboxPolicy) {
  const confined = sandbox.confine(['bash', '-c', command], policy)
  const result = spawnSync(confined.argv[0] as string, confined.argv.slice(1), {
    timeout: 30_000,
    encoding: 'utf8',
    cwd: policy.workspaceRoot,
  })
  return { result, confined }
}

async function main(): Promise<void> {
  const sentinelDir = join(tmpdir(), 'benchmark-secret')
  const sentinelPath = join(sentinelDir, 'holdout-sentinel.txt')
  const sentinelContent = 'SECRET-HOLDOUT-DATA-DO-NOT-EXPOSE'

  rmSync(sentinelDir, { recursive: true, force: true })
  mkdirSync(sentinelDir, { recursive: true })
  writeFileSync(sentinelPath, sentinelContent, 'utf8')

  const workspace = mkdtempSync(join(tmpdir(), 'sandbox-isolation-ws-'))
  writeFileSync(join(workspace, 'workspace-file.txt'), 'workspace content', 'utf8')

  const benchmarkSource = join(REPO_ROOT, 'scripts', 'run-v0174-repair-experiment.ts')

  const ctx = new Context()
  let sandbox: LocalSandboxProvider
  try {
    await ctx.plugin(LocalSandboxProvider, {})
    sandbox = ctx.sandbox as LocalSandboxProvider
  } catch (err) {
    console.error(`SKIP: sandbox unavailable on this platform: ${(err as Error).message}`)
    rmSync(sentinelDir, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
    process.exit(2)
  }

  const policy: SandboxPolicy = {
    mode: 'workspace-isolated',
    workspaceRoot: workspace,
    protectedReadPaths: [
      realpathSync(sentinelDir),
      join(REPO_ROOT, 'scripts'),
    ],
  }
  let allPassed = true

  // Test 1: Read sentinel file outside workspace — MUST be denied
  console.log('Test 1: Read sentinel file outside workspace')
  const t1 = runConfined(sandbox, `cat '${sentinelPath}'`, policy)
  if (t1.result.stdout.trim() === sentinelContent) {
    console.error(`  FAIL: sentinel file was readable! Got: "${t1.result.stdout.trim().slice(0, 40)}"`)
    allPassed = false
  } else {
    console.log(`  PASS: sentinel file not readable (exit ${t1.result.status})`)
  }

  // Test 2: Read benchmark runner source — MUST be denied
  console.log('Test 2: Read benchmark runner source by absolute path')
  const t2 = runConfined(sandbox, `head -1 '${benchmarkSource}'`, policy)
  if (t2.result.stdout.trim().length > 0) {
    console.error(`  FAIL: benchmark source was readable! Got: "${t2.result.stdout.trim().slice(0, 60)}"`)
    allPassed = false
  } else {
    console.log(`  PASS: benchmark source not readable (exit ${t2.result.status})`)
  }

  // Test 3: Read inside workspace — MUST succeed
  console.log('Test 3: Read file inside workspace')
  const t3 = runConfined(sandbox, 'cat workspace-file.txt', policy)
  if (t3.result.stdout.trim() === 'workspace content') {
    console.log('  PASS: workspace file readable')
  } else {
    console.error(`  FAIL: workspace file not readable! Got: "${t3.result.stdout.trim()}"`)
    allPassed = false
  }

  // Test 4: Write inside workspace — MUST succeed
  console.log('Test 4: Write file inside workspace')
  const t4 = runConfined(sandbox, 'echo test > output.txt', policy)
  if (t4.result.status === 0 && existsSync(join(workspace, 'output.txt'))) {
    console.log('  PASS: workspace write succeeded')
  } else {
    console.error(`  FAIL: workspace write failed (exit ${t4.result.status})`)
    allPassed = false
  }

  rmSync(sentinelDir, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })

  if (allPassed) {
    console.log('\nAll tests passed — read isolation confirmed.')
    process.exit(0)
  } else {
    console.error('\nFAIL: read isolation is missing — sandbox allows reads outside workspace.')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(`Unexpected error: ${err}`)
  process.exit(1)
})
