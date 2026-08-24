/**
 * Real SIGKILL durability tests for SQLite: spawn an actual child process,
 * issue a model-selection mutation, wait for the SUCCESS signal to cross the
 * process boundary, then immediately send SIGKILL — no dispose(), no delay.
 * A second child process loads the same SQLite database and prints the
 * reconstructed state.
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

function spawnAndKill(
  dbPath: string,
  scenario: string,
  sessionId: string,
): Promise<{ signal: string | null; code: number | null }> {
  return new Promise((resolve, reject) => {
    const launch = resolveExampleLaunch({
      srcBin: hostScript,
      mode: 'src',
      tsconfigPath: join(repoRoot, 'tsconfig.json'),
      configArgs: [dbPath, scenario, sessionId],
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
      if ((stdout.includes('SUCCESS') || stdout.includes('FLUSH_FAILED')) && !killed) {
        killed = true
        clearTimeout(timer)
        child.kill('SIGKILL')
      }
    })

    child.stderr.on('data', (chunk: Buffer) => {
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

function spawnLoad(dbPath: string, sessionId: string): Promise<LoadResult> {
  return new Promise((resolve, reject) => {
    const launch = resolveExampleLaunch({
      srcBin: hostScript,
      mode: 'src',
      tsconfigPath: join(repoRoot, 'tsconfig.json'),
      configArgs: [dbPath, 'load', sessionId],
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

describe('v0.15.5 real SIGKILL durability (SQLite)', () => {
  let dbDir: string
  let dbPath: string

  async function freshDb(): Promise<string> {
    dbDir = await mkdtemp(join(tmpdir(), 'dsh-sigkill-sqlite-'))
    dbPath = join(dbDir, 'sessions.db')
    return dbPath
  }

  async function cleanup(): Promise<void> {
    if (dbDir !== undefined) await rm(dbDir, { recursive: true, force: true })
  }

  it('manual selection survives immediate SIGKILL after RPC success', async () => {
    const path = await freshDb()
    try {
      const { signal } = await spawnAndKill(path, 'manual', 'sigkill-manual')
      expect(signal).toBe('SIGKILL')
      const result = await spawnLoad(path, 'sigkill-manual')
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
    const path = await freshDb()
    try {
      const { signal } = await spawnAndKill(path, 'auto', 'sigkill-auto')
      expect(signal).toBe('SIGKILL')
      const result = await spawnLoad(path, 'sigkill-auto')
      expect(result.found).toBe(true)
      expect(result.state).toMatchObject({ mode: 'auto' })
    } finally {
      await cleanup()
    }
  }, scenarioTimeoutMs)

  it('manual reselection survives immediate SIGKILL after RPC success', async () => {
    const path = await freshDb()
    try {
      const { signal } = await spawnAndKill(path, 'reselect', 'sigkill-reselect')
      expect(signal).toBe('SIGKILL')
      const result = await spawnLoad(path, 'sigkill-reselect')
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
    const path = await freshDb()
    try {
      const { signal } = await spawnAndKill(path, 'foreign', 'sigkill-foreign')
      expect(signal).toBe('SIGKILL')
      const result = await spawnLoad(path, 'sigkill-foreign')
      expect(result.found).toBe(true)
      expect(result.state).toMatchObject({ mode: 'auto' })
    } finally {
      await cleanup()
    }
  }, scenarioTimeoutMs)

  it('flush-failure → SIGKILL → reload produces valid complete state (old or new, never malformed)', async () => {
    const path = await freshDb()
    try {
      const { signal } = await spawnAndKill(path, 'flush-fail', 'sigkill-flushfail')
      expect(signal).toBe('SIGKILL')
      const result = await spawnLoad(path, 'sigkill-flushfail')
      expect(result.found).toBe(true)
      if (result.state === undefined) {
        // Old state: no authority event was persisted. Valid.
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
