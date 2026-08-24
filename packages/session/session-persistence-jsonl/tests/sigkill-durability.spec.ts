/**
 * Real SIGKILL durability tests: spawn an actual child process, issue a
 * model-selection mutation, wait for the SUCCESS signal to cross the process
 * boundary, then immediately send SIGKILL — no dispose(), no delay. A second
 * child process loads the same JSONL storage and prints the reconstructed
 * state. This proves the flush barrier makes the RPC success response a
 * commit boundary: if the caller is told success, the selection survived
 * immediate process death.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const hostScript = fileURLToPath(new URL('./fixtures/sigkill-host.ts', import.meta.url))
const scenarioTimeoutMs = 30_000

interface LoadResult {
  found: boolean
  state: unknown
}

/**
 * Spawn a child process for one scenario, wait for SUCCESS on stdout, then
 * immediately SIGKILL the child. Returns the child's exit signal.
 */
function spawnAndKill(
  rootDir: string,
  scenario: string,
  sessionId: string,
): Promise<{ signal: string | null; code: number | null }> {
  return new Promise((resolve, reject) => {
    const launch = resolveExampleLaunch({
      srcBin: hostScript,
      mode: 'src',
      tsconfigPath: join(repoRoot, 'tsconfig.json'),
      configArgs: [rootDir, scenario, sessionId],
    })
    const child = spawn(launch.command, launch.args, {
      cwd: repoRoot,
      env: launch.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let killed = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`timeout waiting for SUCCESS in scenario ${scenario}`))
    }, scenarioTimeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      // The child prints either SUCCESS or FLUSH_FAILED; both signal readiness
      // for the parent to send SIGKILL.
      if ((stdout.includes('SUCCESS') || stdout.includes('FLUSH_FAILED')) && !killed) {
        killed = true
        clearTimeout(timer)
        // Immediate SIGKILL — no dispose, no graceful shutdown, no delay.
        child.kill('SIGKILL')
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
      // Surface child errors for debugging.
      process.stderr.write(chunk)
    })

    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (!killed && !stdout.includes('SUCCESS')) {
        reject(new Error(`child exited before SUCCESS in scenario ${scenario}: code=${code}, signal=${signal}, stdout=${stdout}`))
        return
      }
      resolve({ signal, code })
    })

    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

/**
 * Spawn a second child process that loads the session from the same storage
 * and prints the reconstructed state as JSON.
 */
function spawnLoad(rootDir: string, sessionId: string): Promise<LoadResult> {
  return new Promise((resolve, reject) => {
    const launch = resolveExampleLaunch({
      srcBin: hostScript,
      mode: 'src',
      tsconfigPath: join(repoRoot, 'tsconfig.json'),
      configArgs: [rootDir, 'load', sessionId],
    })
    const child = spawn(launch.command, launch.args, {
      cwd: repoRoot,
      env: launch.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('timeout waiting for load result'))
    }, scenarioTimeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk)
    })

    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`load child exited with code ${code}: ${stdout}`))
        return
      }
      try {
        resolve(JSON.parse(stdout) as LoadResult)
      } catch (error) {
        reject(new Error(`failed to parse load output: ${stdout}: ${error}`))
      }
    })

    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

describe('v0.15.5 real SIGKILL durability (JSONL)', () => {
  let rootDir: string

  async function freshRoot(): Promise<string> {
    rootDir = await mkdtemp(join(tmpdir(), 'dsh-sigkill-jsonl-'))
    return rootDir
  }

  async function cleanup(): Promise<void> {
    if (rootDir !== undefined) await rm(rootDir, { recursive: true, force: true })
  }

  it('manual selection survives immediate SIGKILL after RPC success', async () => {
    const dir = await freshRoot()
    try {
      const { signal } = await spawnAndKill(dir, 'manual', 'sigkill-manual')
      expect(signal).toBe('SIGKILL')
      const result = await spawnLoad(dir, 'sigkill-manual')
      expect(result.found).toBe(true)
      expect(result.state).toMatchObject({
        mode: 'manual',
        selection: { provider: 'deepseek-official', model: 'deepseek-pro' },
      })
    } finally {
      await cleanup()
    }
  }, scenarioTimeoutMs)

  it('Auto release survives immediate SIGKILL after RPC success', async () => {
    const dir = await freshRoot()
    try {
      const { signal } = await spawnAndKill(dir, 'auto', 'sigkill-auto')
      expect(signal).toBe('SIGKILL')
      const result = await spawnLoad(dir, 'sigkill-auto')
      expect(result.found).toBe(true)
      expect(result.state).toMatchObject({ mode: 'auto' })
    } finally {
      await cleanup()
    }
  }, scenarioTimeoutMs)

  it('manual reselection survives immediate SIGKILL after RPC success', async () => {
    const dir = await freshRoot()
    try {
      const { signal } = await spawnAndKill(dir, 'reselect', 'sigkill-reselect')
      expect(signal).toBe('SIGKILL')
      const result = await spawnLoad(dir, 'sigkill-reselect')
      expect(result.found).toBe(true)
      expect(result.state).toMatchObject({
        mode: 'manual',
        selection: { provider: 'deepseek-official', model: 'deepseek-flash' },
      })
    } finally {
      await cleanup()
    }
  }, scenarioTimeoutMs)

  it('foreign route cannot resurrect after SIGKILL and restart', async () => {
    const dir = await freshRoot()
    try {
      const { signal } = await spawnAndKill(dir, 'foreign', 'sigkill-foreign')
      expect(signal).toBe('SIGKILL')
      const result = await spawnLoad(dir, 'sigkill-foreign')
      expect(result.found).toBe(true)
      expect(result.state).toMatchObject({ mode: 'auto' })
    } finally {
      await cleanup()
    }
  }, scenarioTimeoutMs)

  it('flush-failure → SIGKILL → reload produces valid complete state (old or new, never malformed)', async () => {
    // A flush failure means durability could not be confirmed; it does not
    // prove the attempted event was absent from durable storage. JSONL
    // appends synchronously, so the event is likely on disk even though
    // flush reported failure. The reload must find either the old state
    // (no authority event) or the new state (manual Pro), but never a
    // malformed or partial state.
    const dir = await freshRoot()
    try {
      const { signal } = await spawnAndKill(dir, 'flush-fail', 'sigkill-flushfail')
      expect(signal).toBe('SIGKILL')
      const result = await spawnLoad(dir, 'sigkill-flushfail')
      expect(result.found).toBe(true)
      // The state must be either undefined (old — nothing was written) or
      // a valid manual Pro state (new — the append succeeded before flush).
      // It must never be malformed, partial, or broken.
      if (result.state === undefined) {
        // Old state: no authority event was persisted. This is valid.
      } else if (typeof result.state === 'object' && result.state !== null) {
        const state = result.state as { mode?: string; selection?: { provider?: string; model?: string } }
        expect(state.mode).toBe('manual')
        expect(state.selection).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-pro' })
      } else {
        throw new Error(`unexpected malformed state: ${JSON.stringify(result.state)}`)
      }
    } finally {
      await cleanup()
    }
  }, scenarioTimeoutMs)
})
