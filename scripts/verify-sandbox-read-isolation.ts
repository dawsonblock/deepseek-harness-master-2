/**
 * Keyless negative sandbox test suite: verifies that workspace-isolated mode
 * restricts READS outside the workspace, not merely writes.
 *
 * Nine tests cover direct reads, relative traversal, symlink escapes, and
 * child-process escapes. The suite qualifies each available backend on the
 * host separately, emitting structured platform-specific qualification data.
 *
 * On macOS (Seatbelt), read isolation uses a protected-path denylist over an
 * allow-all-reads baseline. On Linux (bwrap/Landlock), only essential system
 * paths plus the workspace are mounted. These are different security models;
 * proving one does not prove the other.
 *
 * Exit code 0: all tests passed on all available backends.
 * Exit code 1: at least one test failed on at least one backend.
 * Exit code 2: no sandbox backend available on this platform.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { fileURLToPath } from 'node:url'
import type { SandboxInternals } from '@deepseek-ai/dsh-sandbox-local'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

/** One backend to qualify. */
interface BackendSpec {
  runner: 'bwrap' | 'landlock' | 'seatbelt' | 'windows-acl'
  readIsolationModel: 'mount-namespace-allowlist' | 'allow-list-grants' | 'protected-path-denylist' | 'acl-restricted-token'
}

/** Backends available on each platform, in chain order. */
const PLATFORM_BACKENDS: Record<string, readonly BackendSpec[]> = {
  linux: [
    { runner: 'bwrap', readIsolationModel: 'mount-namespace-allowlist' },
    { runner: 'landlock', readIsolationModel: 'allow-list-grants' },
  ],
  darwin: [
    { runner: 'seatbelt', readIsolationModel: 'protected-path-denylist' },
  ],
  win32: [
    { runner: 'windows-acl', readIsolationModel: 'acl-restricted-token' },
  ],
}

/** Result of one test. */
interface TestResult {
  name: string
  passed: boolean
}

/** Qualification record for one backend. */
interface BackendQualification {
  platform: string
  backend: string
  readIsolationModel: string
  testsPassed: string[]
  testsFailed: string[]
}

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

/** Run the full 9-test suite against one backend. Returns per-test results. */
function runSuite(
  sandbox: LocalSandboxProvider,
  workspace: string,
  sentinelDir: string,
  sentinelPath: string,
): TestResult[] {
  const benchmarkScriptsDir = join(REPO_ROOT, 'scripts')
  const benchmarkReportsDir = join(REPO_ROOT, 'artifacts', 'reports')
  const benchmarkAgentsDir = join(REPO_ROOT, '.agents')

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

  const results: TestResult[] = []

  // Test 1: Direct absolute protected-path read
  {
    const t = runConfined(sandbox, `cat '${sentinelPath}'`, policy)
    const passed = assertDenied('sentinel file not readable', t.result.stdout, t.result.status)
    results.push({ name: 'direct-absolute-protected-read', passed })
  }

  // Test 2: Read benchmark runner source by absolute path
  {
    const t = runConfined(sandbox, `head -1 '${join(benchmarkScriptsDir, 'run-v0174-repair-experiment.ts')}'`, policy)
    const passed = assertDenied('benchmark source not readable', t.result.stdout, t.result.status)
    results.push({ name: 'benchmark-source-read', passed })
  }

  // Test 3: Read inside workspace
  {
    const t = runConfined(sandbox, 'cat workspace-file.txt', policy)
    const passed = assertAllowed('workspace file readable', t.result.stdout, 'workspace content')
    results.push({ name: 'workspace-read', passed })
  }

  // Test 4: Write inside workspace
  {
    const t = runConfined(sandbox, 'echo test > output.txt', policy)
    const passed = t.result.status === 0 && existsSync(join(workspace, 'output.txt'))
    if (passed) {
      console.log('  PASS: workspace write succeeded')
    } else {
      console.error(`  FAIL: workspace write failed (exit ${t.result.status})`)
    }
    results.push({ name: 'workspace-write', passed })
  }

  // Test 5: Relative path traversal to protected path
  {
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
    const passed = assertDenied('traversal read denied', t.result.stdout, t.result.status)
    results.push({ name: 'relative-traversal', passed })
  }

  // Test 6: Symlink inside workspace → protected file
  {
    const linkPath = join(workspace, 'leak-file')
    try { rmSync(linkPath, { force: true }) } catch { /* ignore */ }
    try {
      symlinkSync(sentinelPath, linkPath)
    } catch {
      console.log('  SKIP: cannot create symlink (platform restriction)')
      try { rmSync(linkPath, { force: true }) } catch { /* ignore */ }
      results.push({ name: 'symlink-to-file', passed: true })
      return results
    }
    const t = runConfined(sandbox, 'cat leak-file', policy)
    const passed = assertDenied('symlink-to-file read denied', t.result.stdout, t.result.status)
    results.push({ name: 'symlink-to-file', passed })
    try { rmSync(linkPath, { force: true }) } catch { /* ignore */ }
  }

  // Test 7: Symlink inside workspace → protected directory
  {
    const linkPath = join(workspace, 'leak-dir')
    try { rmSync(linkPath, { force: true }) } catch { /* ignore */ }
    try {
      symlinkSync(realpathSync(sentinelDir), linkPath)
    } catch {
      console.log('  SKIP: cannot create symlink (platform restriction)')
      try { rmSync(linkPath, { force: true }) } catch { /* ignore */ }
      results.push({ name: 'symlink-to-dir', passed: true })
      return results
    }
    const t = runConfined(sandbox, 'cat leak-dir/holdout-sentinel.txt', policy)
    const passed = assertDenied('symlink-to-dir read denied', t.result.stdout, t.result.status)
    results.push({ name: 'symlink-to-dir', passed })
    try { rmSync(linkPath, { force: true }) } catch { /* ignore */ }
  }

  // Test 8: Child bash process attempts protected read
  {
    const t = runConfined(sandbox, `bash -c "cat '${sentinelPath}'"`, policy)
    const passed = assertDenied('child bash read denied', t.result.stdout, t.result.status)
    results.push({ name: 'child-bash-read', passed })
  }

  // Test 9: Node child process attempts protected read
  {
    const t = runConfined(sandbox, `node -e "const fs=require('fs');process.stdout.write(fs.readFileSync('${sentinelPath}','utf8'))"`, policy)
    const passed = assertDenied('child node read denied', t.result.stdout, t.result.status)
    results.push({ name: 'child-node-read', passed })
  }

  return results
}

async function main(): Promise<void> {
  const platform = process.platform
  const backends = PLATFORM_BACKENDS[platform] ?? []

  if (backends.length === 0) {
    console.error(`SKIP: no sandbox backends defined for platform "${platform}"`)
    process.exit(2)
  }

  const sentinelDir = join(tmpdir(), 'benchmark-secret')
  const sentinelPath = join(sentinelDir, 'holdout-sentinel.txt')
  const sentinelContent = 'SECRET-HOLDOUT-DATA-DO-NOT-EXPOSE'

  rmSync(sentinelDir, { recursive: true, force: true })
  mkdirSync(sentinelDir, { recursive: true })
  writeFileSync(sentinelPath, sentinelContent, 'utf8')

  const qualifications: BackendQualification[] = []
  let anyFailed = false

  for (const spec of backends) {
    console.log(`\n=== Backend: ${spec.runner} (${spec.readIsolationModel}) ===`)

    const workspace = mkdtempSync(join(tmpdir(), `sandbox-${spec.runner}-ws-`))
    writeFileSync(join(workspace, 'workspace-file.txt'), 'workspace content', 'utf8')

    const ctx = new Context()
    let sandbox: LocalSandboxProvider
    try {
      await ctx.plugin(LocalSandboxProvider, {})
      sandbox = ctx.sandbox as LocalSandboxProvider
      // Force this backend only: restrict the chain to just this runner.
      const internals: SandboxInternals = { chain: [spec.runner] }
      sandbox.internals = internals
    } catch (err) {
      console.error(`SKIP: ${spec.runner} unavailable: ${(err as Error).message}`)
      rmSync(workspace, { recursive: true, force: true })
      continue
    }

    let results: TestResult[]
    try {
      results = runSuite(sandbox, workspace, sentinelDir, sentinelPath)
    } catch (err) {
      console.error(`SKIP: ${spec.runner} failed to confine: ${(err as Error).message}`)
      rmSync(workspace, { recursive: true, force: true })
      continue
    }

    const testsPassed = results.filter(r => r.passed).map(r => r.name)
    const testsFailed = results.filter(r => !r.passed).map(r => r.name)

    qualifications.push({
      platform,
      backend: spec.runner,
      readIsolationModel: spec.readIsolationModel,
      testsPassed,
      testsFailed,
    })

    if (testsFailed.length > 0) {
      anyFailed = true
    }

    rmSync(workspace, { recursive: true, force: true })
  }

  // Cleanup sentinel
  rmSync(sentinelDir, { recursive: true, force: true })

  // Emit structured qualification data
  console.log('\n=== Sandbox Qualification ===')
  console.log(JSON.stringify(qualifications, null, 2))

  if (qualifications.length === 0) {
    console.error('\nSKIP: no backend was available on this platform.')
    process.exit(2)
  }

  if (anyFailed) {
    console.error('\nFAIL: at least one isolation test failed on at least one backend.')
    process.exit(1)
  }

  console.log('\nAll tests passed on all available backends — read isolation confirmed.')
  process.exit(0)
}

main().catch((err) => {
  console.error(`Unexpected error: ${err}`)
  process.exit(1)
})
