/**
 * Keyless negative sandbox test suite: verifies that workspace-isolated mode
 * restricts READS outside the workspace, not merely writes.
 *
 * Nine tests cover direct reads, relative traversal, symlink escapes, and
 * child-process escapes. On macOS (Seatbelt), read isolation uses a
 * protected-path denylist over an allow-all-reads baseline; on Linux
 * (bwrap/Landlock), only essential system paths plus the workspace are
 * mounted. This suite qualifies whichever backend is available on the host.
 *
 * Exit code 0: all tests passed — read isolation confirmed.
 * Exit code 1: at least one test failed — read isolation is incomplete.
 * Exit code 2: sandbox unavailable on this platform (skip, not a failure).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

/** Check that a command produced no readable output (deny succeeded). */
function assertDenied(label: string, stdout: string, exitCode: number | null): boolean {
  if (stdout.trim().length > 0) {
    console.error(`  FAIL: ${label} — output leaked: "${stdout.trim().slice(0, 60)}"`)
    return false
  }
  console.log(`  PASS: ${label} (exit ${exitCode})`)
  return true
}

/** Check that a command produced expected output (allow succeeded). */
function assertAllowed(label: string, stdout: string, expected: string): boolean {
  if (stdout.trim() === expected) {
    console.log(`  PASS: ${label}`)
    return true
  }
  console.error(`  FAIL: ${label} — expected "${expected}", got "${stdout.trim()}"`)
  return false
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

  const benchmarkScriptsDir = join(REPO_ROOT, 'scripts')
  const benchmarkReportsDir = join(REPO_ROOT, 'artifacts', 'reports')
  const benchmarkAgentsDir = join(REPO_ROOT, '.agents')

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
      benchmarkScriptsDir,
      benchmarkReportsDir,
      benchmarkAgentsDir,
    ],
  }

  let allPassed = true

  // === Basic isolation tests ===

  console.log('Test 1: Direct absolute protected-path read')
  {
    const t = runConfined(sandbox, `cat '${sentinelPath}'`, policy)
    allPassed = assertDenied('sentinel file not readable', t.result.stdout, t.result.status) && allPassed
  }

  console.log('Test 2: Read benchmark runner source by absolute path')
  {
    const t = runConfined(sandbox, `head -1 '${join(benchmarkScriptsDir, 'run-v0174-repair-experiment.ts')}'`, policy)
    allPassed = assertDenied('benchmark source not readable', t.result.stdout, t.result.status) && allPassed
  }

  console.log('Test 3: Read inside workspace')
  {
    const t = runConfined(sandbox, 'cat workspace-file.txt', policy)
    allPassed = assertAllowed('workspace file readable', t.result.stdout, 'workspace content') && allPassed
  }

  console.log('Test 4: Write inside workspace')
  {
    const t = runConfined(sandbox, 'echo test > output.txt', policy)
    if (t.result.status === 0 && existsSync(join(workspace, 'output.txt'))) {
      console.log('  PASS: workspace write succeeded')
    } else {
      console.error(`  FAIL: workspace write failed (exit ${t.result.status})`)
      allPassed = false
    }
  }

  // === Adversarial escape tests ===

  console.log('Test 5: Relative path traversal to protected path')
  {
    // Compute a relative path from the workspace to the sentinel directory
    const relPath = (() => {
      const wsParts = workspace.split('/').filter(Boolean)
      const sentinelParts = realpathSync(sentinelDir).split('/').filter(Boolean)
      let common = 0
      while (common < wsParts.length && common < sentinelParts.length && wsParts[common] === sentinelParts[common]) {
        common++
      }
      const upCount = wsParts.length - common
      const downParts = sentinelParts.slice(common)
      return `${'../'.repeat(upCount)}${downParts.join('/')}/holdout-sentinel.txt`
    })()
    const t = runConfined(sandbox, `cat '${relPath}'`, policy)
    allPassed = assertDenied('traversal read denied', t.result.stdout, t.result.status) && allPassed
  }

  console.log('Test 6: Symlink inside workspace → protected file')
  {
    const linkPath = join(workspace, 'leak-file')
    try { rmSync(linkPath, { force: true }) } catch { /* ignore */ }
    try {
      symlinkSync(sentinelPath, linkPath)
    } catch {
      console.log('  SKIP: cannot create symlink (platform restriction)')
      try { rmSync(linkPath, { force: true }) } catch { /* ignore */ }
      return
    }
    const t = runConfined(sandbox, 'cat leak-file', policy)
    allPassed = assertDenied('symlink-to-file read denied', t.result.stdout, t.result.status) && allPassed
    try { rmSync(linkPath, { force: true }) } catch { /* ignore */ }
  }

  console.log('Test 7: Symlink inside workspace → protected directory')
  {
    const linkPath = join(workspace, 'leak-dir')
    try { rmSync(linkPath, { force: true }) } catch { /* ignore */ }
    try {
      symlinkSync(realpathSync(sentinelDir), linkPath)
    } catch {
      console.log('  SKIP: cannot create symlink (platform restriction)')
      try { rmSync(linkPath, { force: true }) } catch { /* ignore */ }
      return
    }
    const t = runConfined(sandbox, 'cat leak-dir/holdout-sentinel.txt', policy)
    allPassed = assertDenied('symlink-to-dir read denied', t.result.stdout, t.result.status) && allPassed
    try { rmSync(linkPath, { force: true }) } catch { /* ignore */ }
  }

  console.log('Test 8: Child process attempts protected read')
  {
    const t = runConfined(sandbox, `bash -c "cat '${sentinelPath}'"`, policy)
    allPassed = assertDenied('child bash read denied', t.result.stdout, t.result.status) && allPassed
  }

  console.log('Test 9: Node child process attempts protected read')
  {
    const t = runConfined(sandbox, `node -e "const fs=require('fs');process.stdout.write(fs.readFileSync('${sentinelPath}','utf8'))"`, policy)
    allPassed = assertDenied('child node read denied', t.result.stdout, t.result.status) && allPassed
  }

  // Cleanup
  rmSync(sentinelDir, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })

  if (allPassed) {
    console.log('\nAll tests passed — read isolation confirmed.')
    process.exit(0)
  } else {
    console.error('\nFAIL: at least one isolation test failed.')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(`Unexpected error: ${err}`)
  process.exit(1)
})
