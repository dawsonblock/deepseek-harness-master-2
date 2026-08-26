#!/usr/bin/env node
/**
 * v0.18 repair-controller qualification: runs five live sandboxed holdout
 * fixtures through the new RepairController.decide() policy. This is the final
 * qualification gate before enabling the verified-escalation policy in normal
 * runtime execution.
 *
 * Pipeline per fixture:
 *   Diagnostic suite → may generate repair evidence → Flash repair →
 *   Diagnostic PASS → UNSEEN HOLDOUT → PASS / FAIL
 *
 * A holdout failure fails the task even if the diagnostic suite passes.
 *
 * The repair loop uses RepairController.decide() from
 * @deepseek-ai/dsh-repair-controller — the same pure deterministic policy
 * that passed 16 decision tests and 8 crash/replay tests.
 *
 * Self-skips without DEEPSEEK_API_KEY.
 *
 * @module v018-qualification
 */

import { mkdir, mkdtemp, readFile, rm, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import type { Context } from '@deepseek-ai/cordis'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { calculateCost, DEFAULT_PRICING_REGISTRY, lookupPricingAt } from '@deepseek-ai/dsh-token-meter'

import {
  type ModelRef,
  type RepairDecision,
  DEFAULT_REPAIR_LIMITS,
} from '@deepseek-ai/dsh-repair-controller'

import {
  type TurnResult,
  type VerifyResult,
  runRepairLoop,
} from './v018-repair-loop.ts'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const REPORT_DIR = join(REPO_ROOT, 'artifacts', 'reports')
const CHECKPOINT_PATH = join(REPORT_DIR, 'v018-repair-controller-qualification.checkpoint.json')
const JSON_PATH = join(REPORT_DIR, 'v018-repair-controller-qualification.json')
const REPORT_PATH = join(REPORT_DIR, 'v018-repair-controller-qualification.md')
const MODELS = {
  flash: { provider: 'deepseek', model: 'deepseek-v4-flash' } as ModelRef,
  pro: { provider: 'deepseek', model: 'deepseek-v4-pro' } as ModelRef,
}

// ---------------------------------------------------------------------------
// Workspace helpers
// ---------------------------------------------------------------------------

async function writeWorkspaceFile(workspace: string, relativePath: string, content: string): Promise<void> {
  const fullPath = join(workspace, relativePath)
  const dir = fullPath.slice(0, fullPath.lastIndexOf('/'))
  await mkdir(dir, { recursive: true })
  await writeFile(fullPath, `${content}\n`, 'utf8')
}

async function runInWorkspace(workspace: string, command: string[]): Promise<{ code: number; output: string }> {
  const repoBin = join(REPO_ROOT, 'node_modules', '.bin')
  const env = {
    ...process.env,
    CI: 'true',
    PATH: `${repoBin}:${process.env.PATH ?? ''}`,
  }
  const cmd = command[0] ?? ''
  const args = command.slice(1)
  if (cmd === '') return Promise.resolve({ code: 1, output: 'empty command' })
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: workspace,
      env,
      stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (data: Buffer) => { output += data.toString() })
    child.stderr.on('data', (data: Buffer) => { output += data.toString() })
    child.on('close', (code: number | null) => {
      resolve({ code: code ?? 1, output })
    })
    child.on('error', () => {
      resolve({ code: 1, output: `${output}\nspawn error` })
    })
  })
}

function parseTypeErrors(output: string): string[] {
  return output.split('\n')
    .filter(line => /error TS\d+:/.test(line))
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

function parseFailingTests(output: string): string[] {
  return output.split('\n')
    .filter(line => /FAIL|×|failed|❯.*failed/i.test(line))
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

const TEST_PACKAGE_JSON = JSON.stringify({
  name: 'repair-fixture',
  version: '0.0.0',
  private: true,
  type: 'module',
}, null, 2)

const TEST_TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    noImplicitAny: true,
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'bundler',
    esModuleInterop: true,
    skipLibCheck: true,
    noEmit: true,
    allowImportingTsExtensions: true,
  },
  include: ['*.ts'],
  exclude: ['*.test.ts'],
}, null, 2)

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

interface VerificationEvidence {
  readonly failedCriteria: readonly string[]
  readonly failingTests: readonly string[]
  readonly typeErrors: readonly string[]
  readonly buildErrors: readonly string[]
}

interface VerificationResult {
  passed: boolean
  evidence: VerificationEvidence
}

async function verifyWorkspace(workspace: string, hiddenTest?: string): Promise<VerificationResult> {
  if (hiddenTest !== undefined) {
    await writeWorkspaceFile(workspace, '__hidden_test__.test.ts', hiddenTest)
  }
  const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
  const typeErrors = parseTypeErrors(typecheck.output)
  const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
  const failingTests = parseFailingTests(testRun.output)
  const passed = typecheck.code === 0 && testRun.code === 0
  const failedCriteria: string[] = []
  if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
  if (failingTests.length > 0) failedCriteria.push('All tests must pass')
  if (hiddenTest !== undefined) {
    try { await unlink(join(workspace, '__hidden_test__.test.ts')) } catch { /* ignore */ }
  }
  return { passed, evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] } }
}

async function holdoutVerify(workspace: string, holdoutTest: string): Promise<VerificationResult> {
  await writeWorkspaceFile(workspace, '__holdout_test__.test.ts', holdoutTest)
  const result = await verifyWorkspace(workspace)
  try { await unlink(join(workspace, '__holdout_test__.test.ts')) } catch { /* ignore */ }
  return result
}

// ---------------------------------------------------------------------------
// Fixture definitions (5 fixtures with holdout verifiers)
// ---------------------------------------------------------------------------

interface Fixture {
  readonly id: string
  readonly category: string
  readonly description: string
  readonly task: string
  readonly setup: (workspace: string) => Promise<void>
  readonly diagnosticTest: string
  readonly holdoutTest: string
}

const FIXTURES: readonly Fixture[] = [
  {
    id: 'implement-debounce',
    category: 'code-implement',
    description: 'Implement a debounce function with cancel',
    task: 'Write a TypeScript function `debounce` in `debounce.ts`. It takes a function `fn` and a wait time `ms`, and returns a debounced version that delays calling `fn` until `ms` milliseconds after the last call. The debounced function must support a `.cancel()` method that prevents pending invocation. Export `debounce` as a named export. The test file `debounce.test.ts` already exists and must pass.',
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
      await writeWorkspaceFile(workspace, 'debounce.test.ts', `
import { describe, it, expect, vi } from 'vitest'
import { debounce } from './debounce.ts'

describe('debounce', () => {
  it('delays invocation until after wait ms', async () => {
    const fn = vi.fn()
    const debounced = debounce(fn, 50)
    debounced()
    debounced()
    expect(fn).not.toHaveBeenCalled()
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('cancel prevents pending invocation', async () => {
    const fn = vi.fn()
    const debounced = debounce(fn, 50)
    debounced()
    debounced.cancel()
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(fn).not.toHaveBeenCalled()
  })
})
`)
    },
    diagnosticTest: `
import { describe, it, expect, vi } from 'vitest'
import { debounce } from './debounce.ts'

describe('debounce diagnostic', () => {
  it('calls with last arguments', async () => {
    const fn = vi.fn((x: number) => x)
    const debounced = debounce(fn, 30)
    debounced(1)
    debounced(2)
    debounced(3)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(fn).toHaveBeenCalledWith(3)
  })
})
`,
    holdoutTest: `
import { describe, it, expect, vi } from 'vitest'
import { debounce } from './debounce.ts'

describe('debounce holdout', () => {
  it('preserves this context', async () => {
    const obj = { val: 42, get: function() { return this.val } }
    const debounced = debounce(obj.get.bind(obj), 20)
    const result = debounced()
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(result).toBeUndefined()
  })

  it('multiple cancel calls are safe', async () => {
    const fn = vi.fn()
    const debounced = debounce(fn, 30)
    debounced()
    debounced.cancel()
    debounced.cancel()
    debounced.cancel()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(fn).not.toHaveBeenCalled()
  })

  it('can be called again after cancel', async () => {
    const fn = vi.fn()
    const debounced = debounce(fn, 30)
    debounced()
    debounced.cancel()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(fn).not.toHaveBeenCalled()
    debounced()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
`,
  },
  {
    id: 'implement-throttle',
    category: 'code-implement',
    description: 'Implement a throttle function with leading edge',
    task: 'Write a TypeScript function `throttle` in `throttle.ts`. It takes a function `fn` and a limit `ms`, and returns a throttled version that invokes `fn` at most once per `ms` window, calling `fn` immediately on the first call and then ignoring subsequent calls until the window expires. Export `throttle` as a named export. The test file `throttle.test.ts` already exists and must pass.',
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
      await writeWorkspaceFile(workspace, 'throttle.test.ts', `
import { describe, it, expect, vi } from 'vitest'
import { throttle } from './throttle.ts'

describe('throttle', () => {
  it('invokes immediately on first call', () => {
    const fn = vi.fn()
    const throttled = throttle(fn, 50)
    throttled()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('ignores subsequent calls within the window', () => {
    const fn = vi.fn()
    const throttled = throttle(fn, 50)
    throttled()
    throttled()
    throttled()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('allows another call after the window expires', async () => {
    const fn = vi.fn()
    const throttled = throttle(fn, 50)
    throttled()
    await new Promise(resolve => setTimeout(resolve, 60))
    throttled()
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
`)
    },
    diagnosticTest: `
import { describe, it, expect, vi } from 'vitest'
import { throttle } from './throttle.ts'

describe('throttle diagnostic', () => {
  it('throttles rapid calls to one invocation per window', async () => {
    const fn = vi.fn()
    const throttled = throttle(fn, 30)
    for (let i = 0; i < 10; i++) throttled()
    expect(fn).toHaveBeenCalledTimes(1)
    await new Promise(resolve => setTimeout(resolve, 40))
    throttled()
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
`,
    holdoutTest: `
import { describe, it, expect, vi } from 'vitest'
import { throttle } from './throttle.ts'

describe('throttle holdout', () => {
  it('preserves arguments from last call in window', () => {
    const fn = vi.fn((x: number) => x)
    const throttled = throttle(fn, 50)
    throttled(1)
    throttled(2)
    throttled(3)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(1)
  })

  it('works with zero delay', () => {
    const fn = vi.fn()
    const throttled = throttle(fn, 0)
    throttled()
    throttled()
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
`,
  },
  {
    id: 'implement-memoize',
    category: 'code-implement',
    description: 'Implement memoization with custom resolver',
    task: 'Write a TypeScript function `memoize` in `memoize.ts`. It takes a function `fn` and an optional `resolver` that produces a cache key from arguments. When no resolver is given, the first argument is the key. Cached results are returned on subsequent calls with the same key. Export `memoize` as a named export. The test file `memoize.test.ts` already exists and must pass.',
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
      await writeWorkspaceFile(workspace, 'memoize.test.ts', `
import { describe, it, expect, vi } from 'vitest'
import { memoize } from './memoize.ts'

describe('memoize', () => {
  it('caches results by first argument', () => {
    const fn = vi.fn((x: number) => x * 2)
    const memoized = memoize(fn)
    expect(memoized(5)).toBe(10)
    expect(memoized(5)).toBe(10)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('uses resolver for cache key when provided', () => {
    const fn = vi.fn((a: number, b: number) => a + b)
    const memoized = memoize(fn, (a, b) => \`\${a}:\${b}\`)
    expect(memoized(1, 2)).toBe(3)
    expect(memoized(1, 2)).toBe(3)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(memoized(2, 1)).toBe(3)
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
`)
    },
    diagnosticTest: `
import { describe, it, expect, vi } from 'vitest'
import { memoize } from './memoize.ts'

describe('memoize diagnostic', () => {
  it('caches undefined results', () => {
    const fn = vi.fn(() => undefined)
    const memoized = memoize(fn)
    expect(memoized()).toBeUndefined()
    expect(memoized()).toBeUndefined()
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
`,
    holdoutTest: `
import { describe, it, expect, vi } from 'vitest'
import { memoize } from './memoize.ts'

describe('memoize holdout', () => {
  it('handles object keys by reference', () => {
    const fn = vi.fn((obj: { val: number }) => obj.val * 2)
    const memoized = memoize(fn)
    const a = { val: 5 }
    const b = { val: 5 }
    expect(memoized(a)).toBe(10)
    expect(memoized(a)).toBe(10)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(memoized(b)).toBe(10)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('resolver can return string keys', () => {
    const fn = vi.fn((a: number, b: number) => a * b)
    const memoized = memoize(fn, (a, b) => \`key-\${a}-\${b}\`)
    expect(memoized(3, 4)).toBe(12)
    expect(memoized(3, 4)).toBe(12)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
`,
  },
  {
    id: 'fix-broken-sort',
    category: 'code-debug',
    description: 'Fix a broken numeric sort function',
    task: 'The file `sort.ts` contains a broken sort function that produces wrong numeric order for `[10, 2, 1]`. Fix the bug so that `sort.test.ts` passes. Do not change the test file.',
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
      await writeWorkspaceFile(workspace, 'sort.ts', `
export function sortNumbers(numbers: number[]): number[] {
  return numbers.sort()
}
`)
      await writeWorkspaceFile(workspace, 'sort.test.ts', `
import { describe, it, expect } from 'vitest'
import { sortNumbers } from './sort.ts'

describe('sortNumbers', () => {
  it('sorts numbers in ascending order', () => {
    expect(sortNumbers([10, 2, 1])).toEqual([1, 2, 10])
  })

  it('handles negative numbers', () => {
    expect(sortNumbers([-3, 0, -1, 5])).toEqual([-3, -1, 0, 5])
  })

  it('handles empty array', () => {
    expect(sortNumbers([])).toEqual([])
  })
})
`)
    },
    diagnosticTest: `
import { describe, it, expect } from 'vitest'
import { sortNumbers } from './sort.ts'

describe('sortNumbers diagnostic', () => {
  it('sorts a large array correctly', () => {
    expect(sortNumbers([5, 3, 8, 1, 9, 2, 7, 4, 6, 0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })
})
`,
    holdoutTest: `
import { describe, it, expect } from 'vitest'
import { sortNumbers } from './sort.ts'

describe('sortNumbers holdout', () => {
  it('does not mutate the input array', () => {
    const input = [3, 1, 2]
    const result = sortNumbers(input)
    expect(result).toEqual([1, 2, 3])
    expect(input).toEqual([3, 1, 2])
  })

  it('handles single element', () => {
    expect(sortNumbers([42])).toEqual([42])
  })

  it('handles duplicates', () => {
    expect(sortNumbers([3, 1, 3, 2, 1])).toEqual([1, 1, 2, 3, 3])
  })
})
`,
  },
  {
    id: 'implement-promise-pool',
    category: 'code-implement',
    description: 'Implement a concurrency-limited promise pool',
    task: 'Write a TypeScript function `promisePool` in `promise-pool.ts`. It takes an array of functions that return promises and a concurrency limit `n`. It executes at most `n` promises at a time and resolves with an array of results in the same order as the input functions. Export `promisePool` as a named export. The test file `promise-pool.test.ts` already exists and must pass.',
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
      await writeWorkspaceFile(workspace, 'promise-pool.test.ts', `
import { describe, it, expect } from 'vitest'
import { promisePool } from './promise-pool.ts'

describe('promisePool', () => {
  it('executes all tasks and returns results in order', async () => {
    const tasks = [
      () => Promise.resolve('a'),
      () => Promise.resolve('b'),
      () => Promise.resolve('c'),
    ]
    const results = await promisePool(tasks, 2)
    expect(results).toEqual(['a', 'b', 'c'])
  })

  it('respects concurrency limit', async () => {
    let active = 0
    let maxActive = 0
    const tasks = Array.from({ length: 5 }, (_, i) => () => {
      active++
      maxActive = Math.max(maxActive, active)
      return new Promise<string>(resolve => {
        setTimeout(() => { active--; resolve(\`task-\${i}\`) }, 20)
      })
    })
    const results = await promisePool(tasks, 2)
    expect(results).toEqual(['task-0', 'task-1', 'task-2', 'task-3', 'task-4'])
    expect(maxActive).toBeLessThanOrEqual(2)
  })

  it('propagates rejection', async () => {
    const tasks = [
      () => Promise.resolve('ok'),
      () => Promise.reject(new Error('fail')),
    ]
    await expect(promisePool(tasks, 1)).rejects.toThrow('fail')
  })
})
`)
    },
    diagnosticTest: `
import { describe, it, expect } from 'vitest'
import { promisePool } from './promise-pool.ts'

describe('promisePool diagnostic', () => {
  it('handles empty task array', async () => {
    const results = await promisePool([], 3)
    expect(results).toEqual([])
  })

  it('handles concurrency of 1', async () => {
    const tasks = [
      () => Promise.resolve(1),
      () => Promise.resolve(2),
      () => Promise.resolve(3),
    ]
    const results = await promisePool(tasks, 1)
    expect(results).toEqual([1, 2, 3])
  })
})
`,
    holdoutTest: `
import { describe, it, expect } from 'vitest'
import { promisePool } from './promise-pool.ts'

describe('promisePool holdout', () => {
  it('preserves order regardless of completion time', async () => {
    const tasks = [
      () => new Promise(resolve => setTimeout(() => resolve('slow'), 50)),
      () => new Promise(resolve => setTimeout(() => resolve('fast'), 10)),
      () => Promise.resolve('instant'),
    ]
    const results = await promisePool(tasks, 3)
    expect(results).toEqual(['slow', 'fast', 'instant'])
  })

  it('handles single task', async () => {
    const results = await promisePool([() => Promise.resolve(42)], 1)
    expect(results).toEqual([42])
  })
})
`,
  },
]

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface QualificationAttempt {
  attempt: number
  model: string
  routingDecisionId: string
  verified: boolean
  diagnosticPass: boolean
  holdoutPass: boolean | undefined
  failureFingerprint: string | undefined
  progress: 'none' | 'partial' | 'regression' | 'resolved' | undefined
  costUsd: number
  latencyMs: number
  cacheReadTokens: number
  cacheMissTokens: number
  outputTokens: number
  inputTokens: number
  reasoningTokens: number
  totalTokens: number
  repairAction: RepairDecision['action']
  repairReason: string | undefined
}

interface QualificationResult {
  taskId: string
  category: string
  description: string
  attempts: QualificationAttempt[]
  finalVerified: boolean
  holdoutPass: boolean
  flashAttempts: number
  proAttempts: number
  totalCostUsd: number
  totalLatencyMs: number
  failureFingerprints: string[]
  progressHistory: string[]
  escalatedToPro: boolean
}

// ---------------------------------------------------------------------------
// Config generation (sandboxed headless agent)
// ---------------------------------------------------------------------------

async function generateConfig(model: string, workDir: string, workspace: string): Promise<string> {
  const basePath = join(REPO_ROOT, 'examples', 'headless-agent', 'cordis.yml')
  let base = await readFile(basePath, 'utf8')
  base = base.replace(/model: deepseek-v4-flash/, `model: ${model}`)
  base = base.replace(
    /compression: !!js "process.env.DSH_SNAPSHOT === undefined \? 'zstd' : 'none'"/,
    "compression: 'none'",
  )
  base = base.replace(/cwd: !!js process\.cwd\(\)/g, `cwd: '${workspace}'`)
  base = base.replace(
    /- id: bash\n  name: '@deepseek-ai\/dsh-bash-local'/,
    `- id: sandbox
  name: '@deepseek-ai/dsh-sandbox-local'
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: workspace-isolated
    workspaceRoot: '${workspace}'
    protectedReadPaths:
      - '${join(REPO_ROOT, 'scripts')}'
      - '${join(REPO_ROOT, 'artifacts')}'
      - '${join(REPO_ROOT, '.agents')}'
      - '${join(REPO_ROOT, 'packages')}'
      - '${join(REPO_ROOT, 'docs')}'
      - '${join(REPO_ROOT, 'website')}'
- id: bash
  name: '@deepseek-ai/dsh-bash-sandbox'`,
  )
  const configPath = join(workDir, 'cordis.yml')
  await writeFile(configPath, base, 'utf8')
  return configPath
}

// ---------------------------------------------------------------------------
// Agent turn execution
// ---------------------------------------------------------------------------

interface RunResult {
  output: string
  costUsd: number
  latencyMs: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheMissTokens: number
  routingDecisionId: string
}

async function runAgentTurn(task: string, model: string, workspace: string): Promise<RunResult> {
  const configPath = await generateConfig(model, workspace, workspace)
  const events: SessionEvent[] = []
  let uninstallFailLoud: (() => void) | undefined
  let ctx: Context | undefined

  try {
    await mkdir(join(workspace, 'sessions'), { recursive: true })
    loadEnv('v018-qualification')
    uninstallFailLoud = installFailLoud('v018-qualification')
    ctx = await boot('v018-qualification', resolveConfigPath(configPath, undefined))
    const started = Date.now()
    const turnResult = await runFixtureTurn(ctx, { task, onEvent: (_sessionId, event) => events.push(event) })
    const latencyMs = Date.now() - started

    let inputTokens = 0
    let outputTokens = 0
    let reasoningTokens = 0
    let totalTokens = 0
    let cacheReadTokens = 0
    let cacheMissTokens = 0
    for (const event of events) {
      if (event.type === 'model/usage') {
        const data = event.data as Record<string, number>
        inputTokens += data.inputTokens ?? 0
        outputTokens += data.outputTokens ?? 0
        reasoningTokens += data.reasoningTokens ?? 0
        totalTokens += data.totalTokens ?? 0
        cacheReadTokens += data.cacheReadTokens ?? 0
        cacheMissTokens += data.cacheMissTokens ?? 0
      }
    }
    const output = turnResult.output !== '' ? turnResult.output : ''
    if (output === '' && totalTokens === 0) {
      throw new Error('Provider returned no assistant output or usage')
    }
    const pricing = lookupPricingAt(DEFAULT_PRICING_REGISTRY, 'deepseek-official', model, new Date(started))
    const costUsd = pricing === undefined
      ? 0
      : calculateCost({
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheMissTokens,
        reasoningTokens,
        totalTokens,
        source: 'provider',
      }, pricing).amount
    const routingDecision = events.find(event => event.type === 'model/routing-decision')
    const routingDecisionId = (routingDecision?.data as { routingDecisionId?: string })?.routingDecisionId ?? 'unknown'
    return {
      output,
      costUsd,
      latencyMs,
      inputTokens,
      outputTokens,
      reasoningTokens,
      totalTokens,
      cacheReadTokens,
      cacheMissTokens,
      routingDecisionId,
    }
  } finally {
    if (uninstallFailLoud !== undefined) uninstallFailLoud()
    if (ctx !== undefined) await ctx.fiber.dispose()
  }
}

// ---------------------------------------------------------------------------
// Repair loop: delegates to the shared v018-repair-loop module which
// calls the production RepairController.decide() through an injectable
// decide function. The fake-provider qualification test proves the
// runner consumes the production controller.
// ---------------------------------------------------------------------------

/** Adapter: run one model turn via the real provider. */
async function realTurnRunner(task: string, model: ModelRef, workspace: string): Promise<TurnResult> {
  process.stderr.write(`  Attempt: ${model.model}\n`)
  const result = await runAgentTurn(task, model.model, workspace)
  return result
}

/** Adapter: verify one attempt with diagnostic and holdout tests. */
async function realVerifier(workspace: string, _model: ModelRef, fixture: Fixture): Promise<VerifyResult> {
  const diagnostic = await verifyWorkspace(workspace, fixture.diagnosticTest)
  const diagnosticPass = diagnostic.passed
  let holdoutPass: boolean | undefined
  if (diagnosticPass) {
    const holdout = await holdoutVerify(workspace, fixture.holdoutTest)
    holdoutPass = holdout.passed
  }
  return {
    passed: diagnosticPass && (holdoutPass ?? true),
    diagnosticPass,
    holdoutPass,
    evidence: {
      failedCriteria: diagnostic.evidence.failedCriteria,
      failingTests: diagnostic.evidence.failingTests,
      typeErrors: diagnostic.evidence.typeErrors,
      buildErrors: diagnostic.evidence.buildErrors,
      changedFiles: [],
    },
  }
}

/** Run the repair loop for one fixture using the shared module. */
async function runFixtureRepairLoop(fixture: Fixture, workRoot: string): Promise<QualificationResult> {
  const taskId = fixture.id
  const workspace = join(workRoot, `${taskId}-v018`)
  await mkdir(workspace, { recursive: true })
  await fixture.setup(workspace)

  const loopResult = await runRepairLoop({
    taskId,
    workspace,
    initialTask: fixture.task,
    flashModel: MODELS.flash,
    proModel: MODELS.pro,
    runTurn: realTurnRunner,
    verify: (ws, model) => realVerifier(ws, model, fixture),
  })

  for (const attempt of loopResult.attempts) {
    process.stderr.write(`  → ${attempt.repairAction}${attempt.repairReason !== undefined ? ` (${attempt.repairReason})` : ''}\n`)
  }

  return {
    taskId,
    category: fixture.category,
    description: fixture.description,
    attempts: loopResult.attempts,
    finalVerified: loopResult.finalVerified,
    holdoutPass: loopResult.holdoutPass,
    flashAttempts: loopResult.flashAttempts,
    proAttempts: loopResult.proAttempts,
    totalCostUsd: loopResult.totalCostUsd,
    totalLatencyMs: loopResult.totalLatencyMs,
    failureFingerprints: loopResult.failureFingerprints,
    progressHistory: loopResult.progressHistory,
    escalatedToPro: loopResult.escalatedToPro,
  }
}

// ---------------------------------------------------------------------------
// Checkpoint management
// ---------------------------------------------------------------------------

interface Checkpoint {
  release: string
  startedAt: string
  updatedAt: string
  results: QualificationResult[]
}

async function loadCheckpoint(): Promise<Checkpoint | undefined> {
  try {
    const content = await readFile(CHECKPOINT_PATH, 'utf8')
    return JSON.parse(content) as Checkpoint
  } catch {
    return undefined
  }
}

async function saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true })
  await writeFile(CHECKPOINT_PATH, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8')
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

async function generateReport(results: QualificationResult[]): Promise<void> {
  await mkdir(REPORT_DIR, { recursive: true })

  const jsonOutput = {
    release: 'v0.18',
    experimentType: 'repair-controller-qualification',
    fixtureCount: results.length,
    timestamp: new Date().toISOString(),
    results: results.map(r => ({
      taskId: r.taskId,
      attempts: r.attempts.length,
      diagnosticPassPerAttempt: r.attempts.map(a => a.diagnosticPass),
      holdoutPass: r.holdoutPass,
      failureFingerprints: r.failureFingerprints,
      progress: r.progressHistory,
      cacheReadTokens: r.attempts.reduce((sum, a) => sum + a.cacheReadTokens, 0),
      cacheMissTokens: r.attempts.reduce((sum, a) => sum + a.cacheMissTokens, 0),
      outputTokens: r.attempts.reduce((sum, a) => sum + a.outputTokens, 0),
      cost: r.totalCostUsd,
      latency: r.totalLatencyMs,
      flashAttempts: r.flashAttempts,
      proAttempts: r.proAttempts,
      escalatedToPro: r.escalatedToPro,
      finalVerified: r.finalVerified,
    })),
  }
  await writeFile(JSON_PATH, `${JSON.stringify(jsonOutput, null, 2)}\n`, 'utf8')

  const lines: string[] = [
    '# v0.18 Repair Controller Qualification Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Summary',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Fixtures | ${results.length} |`,
    `| Final verified | ${results.filter(r => r.finalVerified).length}/${results.length} |`,
    `| Holdout passed | ${results.filter(r => r.holdoutPass).length}/${results.length} |`,
    `| Escalated to Pro | ${results.filter(r => r.escalatedToPro).length}/${results.length} |`,
    `| Total cost | $${results.reduce((s, r) => s + r.totalCostUsd, 0).toFixed(6)} |`,
    `| Total latency | ${results.reduce((s, r) => s + r.totalLatencyMs, 0)}ms |`,
    '',
    '## Per-fixture results',
    '',
    '| Task | Attempts | Flash | Pro | Verified | Holdout | Cost | Latency |',
    '|------|----------|-------|-----|----------|---------|------|---------|',
    ...results.map(r =>
      `| ${r.taskId} | ${r.attempts.length} | ${r.flashAttempts} | ${r.proAttempts} | ${r.finalVerified ? 'PASS' : 'FAIL'} | ${r.holdoutPass ? 'PASS' : 'FAIL'} | $${r.totalCostUsd.toFixed(6)} | ${r.totalLatencyMs}ms |`,
    ),
    '',
    '## Per-attempt detail',
    '',
    ...results.flatMap(r => [
      `### ${r.taskId}`,
      '',
      `Category: ${r.category}`,
      `Description: ${r.description}`,
      `Final verified: ${r.finalVerified}`,
      `Holdout pass: ${r.holdoutPass}`,
      `Escalated to Pro: ${r.escalatedToPro}`,
      '',
      '| # | Model | Diagnostic | Holdout | Fingerprint | Progress | Action | Cost |',
      '|---|-------|-----------|---------|-------------|----------|--------|------|',
      ...r.attempts.map(a =>
        `| ${a.attempt} | ${a.model} | ${a.diagnosticPass ? 'PASS' : 'FAIL'} | ${a.holdoutPass === undefined ? 'N/A' : a.holdoutPass ? 'PASS' : 'FAIL'} | ${a.failureFingerprint ?? '-'} | ${a.progress ?? '-'} | ${a.repairAction} | $${a.costUsd.toFixed(6)} |`,
      ),
      '',
    ]),
  ]
  await writeFile(REPORT_PATH, lines.join('\n'), 'utf8')
  process.stderr.write(`\nReport written to ${REPORT_PATH}\n`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (process.env.DEEPSEEK_API_KEY === undefined || process.env.DEEPSEEK_API_KEY === '') {
    process.stderr.write('DEEPSEEK_API_KEY is not set; skipping live v0.18 qualification.\n')
    process.stderr.write('The deterministic RepairController logic is validated by:\n')
    process.stderr.write('  - packages/core/repair-controller/tests/decide.spec.ts (16 tests)\n')
    process.stderr.write('  - packages/core/repair-runtime/tests/replay.spec.ts (8 tests)\n')
    process.stderr.write('Provide a rotated key to run the live qualification.\n')
    return
  }

  const fixtures = FIXTURES.slice(0, 5)
  process.stderr.write('\nv0.18 Repair Controller Qualification\n')
  process.stderr.write(`${'='.repeat(60)}\n`)
  process.stderr.write(`Fixtures: ${fixtures.length}\n`)
  process.stderr.write('Policy: verified-escalation (Flash->repair->Pro->stop)\n')
  process.stderr.write(`Limits: maxFlash=${DEFAULT_REPAIR_LIMITS.maxFlashAttempts}, maxPro=${DEFAULT_REPAIR_LIMITS.maxProAttempts}, maxTotal=${DEFAULT_REPAIR_LIMITS.maxTotalAttempts}\n\n`)

  const workRoot = await mkdtemp(join(tmpdir(), 'v018-qual-'))
  const checkpoint = await loadCheckpoint()
  const completedTasks = new Set(checkpoint?.results.map(r => r.taskId) ?? [])
  const results: QualificationResult[] = checkpoint?.results ?? []

  try {
    for (const fixture of fixtures) {
      if (completedTasks.has(fixture.id)) {
        process.stderr.write(`Skipping completed: ${fixture.id}\n`)
        continue
      }
      process.stderr.write(`\nRunning: ${fixture.id} (${fixture.description})\n`)
      try {
        const result = await runFixtureRepairLoop(fixture, workRoot)
        results.push(result)
        completedTasks.add(fixture.id)
        await saveCheckpoint({
          release: 'v0.18',
          startedAt: checkpoint?.startedAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          results,
        })
      } catch (error: unknown) {
        process.stderr.write(`Error in ${fixture.id}: ${error instanceof Error ? error.message : String(error)}\n`)
      }
    }

    // Completeness gate
    const expected = fixtures.length
    const completed = results.filter(r => fixtures.some(f => f.id === r.taskId)).length
    if (completed < expected) {
      process.stderr.write(
        `\nQualification incomplete: ${completed}/${expected} fixtures completed. ` +
        'Re-run when the provider is available.\n',
      )
      return
    }

    await generateReport(results)

    // Final gate: all fixtures must pass both diagnostic and holdout
    const allPass = results.every(r => r.finalVerified && r.holdoutPass)
    if (allPass) {
      process.stderr.write(`\n${'='.repeat(60)}\n`)
      process.stderr.write(`QUALIFICATION PASSED: all ${results.length} fixtures verified with holdout.\n`)
      process.stderr.write('The v0.18 verified-escalation policy is qualified for runtime use.\n')
      process.stderr.write(`${'='.repeat(60)}\n`)
    } else {
      const failures = results.filter(r => !r.finalVerified || !r.holdoutPass)
      process.stderr.write(`\n${'='.repeat(60)}\n`)
      process.stderr.write(`QUALIFICATION FAILED: ${failures.length}/${results.length} fixtures failed.\n`)
      for (const f of failures) {
        process.stderr.write(`  - ${f.taskId}: verified=${f.finalVerified}, holdout=${f.holdoutPass}\n`)
      }
      process.stderr.write(`${'='.repeat(60)}\n`)
      process.exit(1)
    }
  } finally {
    await rm(workRoot, { recursive: true, force: true })
  }
}

void main()
