#!/usr/bin/env node
/**
 * v0.17.4: real Flash-failure → Pro-repair experiment. Unlike v0.17.3's
 * counterfactual paired simulation, this runner executes joined multi-stage
 * trajectories where Pro receives the actual Flash failure evidence and
 * chooses REPAIR_EXISTING or ROLLBACK_AND_REDO before mutating the workspace.
 *
 * Five policies are compared on the identical coding-task corpus:
 *   A. flash-only
 *   B. pro-only
 *   C. flash-fail → pro-fresh (no failure evidence)
 *   D. flash-fail → pro-repair (with FailurePackage)
 *   E. flash-fail → flash-repair → pro-takeover (if still failing)
 *
 * Self-skips without DEEPSEEK_API_KEY. The fixture verification logic is
 * validated keylessly by the companion spec file.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { calculateCost, DEFAULT_PRICING_REGISTRY, lookupPricingAt } from '@deepseek-ai/dsh-token-meter'

import {
  type FailurePackage,
  type PolicyMetrics,
  type PolicyName,
  type StageAttempt,
  type TaskTrajectory,
  type VerificationEvidence,
  type WorkspaceVerificationResult,
  classifyProgress,
  computeFailureFingerprint,
  computePolicyMetrics,
  constructEvidenceOnlyPrompt,
  constructFailurePackage,
  constructFlashRepairPrompt,
  constructProRepairPrompt,
  constructWorkspaceOnlyPrompt,
  isSameFailure,
  parseTakeoverDecision,
} from './v0174-repair-core.ts'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const REPORT_DIR = join(REPO_ROOT, 'artifacts', 'reports')
const CHECKPOINT_PATH = join(REPORT_DIR, 'v0.17.4-repair-experiment.checkpoint.json')
const JSON_PATH = join(REPORT_DIR, 'v0.17.4-repair-experiment.json')
const REPORT_PATH = join(REPORT_DIR, 'v0.17.4-repair-experiment.md')
const MODELS = { flash: 'deepseek-v4-flash', pro: 'deepseek-v4-pro' } as const

// ---------------------------------------------------------------------------
// Task fixtures
// ---------------------------------------------------------------------------

/** One coding-task fixture with file-based setup and objective verification. */
interface CodingTaskFixture {
  readonly id: string
  readonly category: string
  readonly description: string
  readonly task: string
  /** Create initial files in the workspace before the agent runs. */
  readonly setup: (workspace: string) => Promise<void>
  /** Run objective verification on the workspace after the agent runs. */
  readonly verify: (workspace: string) => Promise<WorkspaceVerificationResult>
  /** Whether Flash is expected to fail this task (calibration hint). */
  readonly expectsFlashFailure: boolean
}

/** Write a file in a workspace directory. */
async function writeWorkspaceFile(workspace: string, relativePath: string, content: string): Promise<void> {
  const fullPath = join(workspace, relativePath)
  const dir = fullPath.slice(0, fullPath.lastIndexOf('/'))
  await mkdir(dir, { recursive: true })
  await writeFile(fullPath, `${content}\n`, 'utf8')
}

/** Run a command in a workspace and capture stdout+stderr. Uses the repo's
 * node_modules/.bin on PATH so tsc and vitest are available in temp workspaces. */
async function runInWorkspace(workspace: string, command: string[]): Promise<{ code: number; output: string }> {
  const { spawn } = await import('node:child_process')
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

/** Parse typecheck output into individual error lines. */
function parseTypeErrors(output: string): string[] {
  return output.split('\n')
    .filter(line => /error TS\d+:/.test(line))
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

/** Parse test runner output into failing test names. */
function parseFailingTests(output: string): string[] {
  return output.split('\n')
    .filter(line => /FAIL|×|failed|❯.*failed/i.test(line))
    .map(line => line.trim())
    .filter(line => line.length > 0)
}

/** Create a minimal package.json for TypeScript test execution. */
const TEST_PACKAGE_JSON = JSON.stringify({
  name: 'repair-fixture',
  version: '0.0.0',
  private: true,
  type: 'module',
}, null, 2)

/** Create a minimal tsconfig.json for strict typechecking. Excludes test
 * files (which import vitest) and only checks implementation files. */
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
// Fixture definitions
// ---------------------------------------------------------------------------

const FIXTURES: readonly CodingTaskFixture[] = [
  {
    id: 'implement-debounce',
    category: 'code-implement',
    description: 'Implement a debounce function with tests',
    expectsFlashFailure: true,
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
    verify: async (workspace) => {
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      const evidence: VerificationEvidence = {
        failedCriteria,
        failingTests,
        typeErrors,
        buildErrors: [],
      }
      return {
        passed,
        evidence,
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  {
    id: 'implement-throttle',
    category: 'code-implement',
    description: 'Implement a throttle function with tests',
    expectsFlashFailure: true,
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
    verify: async (workspace) => {
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  {
    id: 'implement-memoize',
    category: 'code-implement',
    description: 'Implement memoization with cache',
    expectsFlashFailure: true,
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
    verify: async (workspace) => {
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  {
    id: 'fix-broken-sort',
    category: 'code-debug',
    description: 'Fix a broken numeric sort function',
    expectsFlashFailure: false,
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
    verify: async (workspace) => {
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  {
    id: 'implement-promise-pool',
    category: 'code-implement',
    description: 'Implement a concurrency-limited promise pool',
    expectsFlashFailure: true,
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
    verify: async (workspace) => {
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  {
    id: 'implement-deep-equal',
    category: 'code-implement',
    description: 'Implement deep equality check',
    expectsFlashFailure: true,
    task: 'Write a TypeScript function `deepEqual` in `deep-equal.ts`. It takes two values and returns true if they are deeply equal (same structure and primitive values for objects, arrays, dates, and nested combinations). Export `deepEqual` as a named export. The test file `deep-equal.test.ts` already exists and must pass.',
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
      await writeWorkspaceFile(workspace, 'deep-equal.test.ts', `
import { describe, it, expect } from 'vitest'
import { deepEqual } from './deep-equal.ts'

describe('deepEqual', () => {
  it('compares primitives', () => {
    expect(deepEqual(1, 1)).toBe(true)
    expect(deepEqual(1, 2)).toBe(false)
    expect(deepEqual('a', 'a')).toBe(true)
    expect(deepEqual(true, false)).toBe(false)
  })

  it('compares flat objects', () => {
    expect(deepEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false)
  })

  it('compares nested objects', () => {
    expect(deepEqual({ a: { b: { c: 1 } } }, { a: { b: { c: 1 } } })).toBe(true)
    expect(deepEqual({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false)
  })

  it('compares arrays', () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true)
    expect(deepEqual([1, [2, 3]], [1, [2, 3]])).toBe(true)
    expect(deepEqual([1, 2], [2, 1])).toBe(false)
  })

  it('handles null and undefined', () => {
    expect(deepEqual(null, null)).toBe(true)
    expect(deepEqual(undefined, undefined)).toBe(true)
    expect(deepEqual(null, undefined)).toBe(false)
  })
})
`)
    },
    verify: async (workspace) => {
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  {
    id: 'fix-async-map',
    category: 'code-debug',
    description: 'Fix an async map that returns Promise[] instead of T[]',
    expectsFlashFailure: false,
    task: 'The file `async-map.ts` contains a function that returns `Promise<number>[]` instead of `number[]`. Fix the bug so that `async-map.test.ts` passes. Do not change the test file.',
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
      await writeWorkspaceFile(workspace, 'async-map.ts', `
export async function doubleAll(xs: number[]): Promise<number[]> {
  return xs.map(async x => x * 2)
}
`)
      await writeWorkspaceFile(workspace, 'async-map.test.ts', `
import { describe, it, expect } from 'vitest'
import { doubleAll } from './async-map.ts'

describe('doubleAll', () => {
  it('doubles all numbers', async () => {
    expect(await doubleAll([1, 2, 3])).toEqual([2, 4, 6])
  })

  it('handles empty array', async () => {
    expect(await doubleAll([])).toEqual([])
  })
})
`)
    },
    verify: async (workspace) => {
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  {
    id: 'implement-curry',
    category: 'code-implement',
    description: 'Implement currying with type safety',
    expectsFlashFailure: true,
    task: 'Write a TypeScript function `curry` in `curry.ts`. It takes a binary function `(a: A, b: B) => R` and returns a curried function that can be called as `curried(a)(b)` or `curried(a, b)`. Export `curry` as a named export. The test file `curry.test.ts` already exists and must pass.',
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
      await writeWorkspaceFile(workspace, 'curry.test.ts', `
import { describe, it, expect } from 'vitest'
import { curry } from './curry.ts'

describe('curry', () => {
  it('curries a binary function', () => {
    const add = curry((a: number, b: number) => a + b)
    expect(add(2)(3)).toBe(5)
  })

  it('supports full application', () => {
    const add = curry((a: number, b: number) => a + b)
    expect(add(2, 3)).toBe(5)
  })

  it('works with strings', () => {
    const concat = curry((a: string, b: string) => a + b)
    expect(concat('hello')('world')).toBe('helloworld')
  })
})
`)
    },
    verify: async (workspace) => {
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  // --- Hard fixtures: designed to challenge Flash ---
  {
    id: 'fix-rate-limiter-state-bug',
    category: 'state-management-bug',
    description: 'Fix a rate limiter with a subtle state reset bug',
    expectsFlashFailure: true,
    task: 'The file `rateLimiter.ts` contains a token-bucket rate limiter with a bug: after the bucket refills, it does not reset `lastRefillTime` correctly, causing all subsequent `allow()` calls to instantly drain the bucket. Fix the bug so `rateLimiter.test.ts` passes. Do not change the test file.',
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
      await writeWorkspaceFile(workspace, 'rateLimiter.ts', `
export class RateLimiter {
  private tokens: number
  private lastRefillTime: number
  constructor(
    private readonly capacity: number,
    private readonly refillRatePerMs: number,
  ) {
    this.tokens = capacity
    this.lastRefillTime = Date.now()
  }
  allow(): boolean {
    const now = Date.now()
    const elapsed = now - this.lastRefillTime
    const refilled = elapsed * this.refillRatePerMs
    if (refilled > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + refilled)
    }
    if (this.tokens >= 1) {
      this.tokens -= 1
      return true
    }
    return false
  }
}
`)
      await writeWorkspaceFile(workspace, 'rateLimiter.test.ts', `
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RateLimiter } from './rateLimiter.ts'

describe('RateLimiter', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('allows up to capacity initially', () => {
    const rl = new RateLimiter(3, 0.001)
    expect(rl.allow()).toBe(true)
    expect(rl.allow()).toBe(true)
    expect(rl.allow()).toBe(true)
    expect(rl.allow()).toBe(false)
  })

  it('refills tokens over time', () => {
    const rl = new RateLimiter(2, 0.001)
    expect(rl.allow()).toBe(true)
    expect(rl.allow()).toBe(true)
    expect(rl.allow()).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(rl.allow()).toBe(true)
  })

  it('does not over-refill beyond capacity', () => {
    const rl = new RateLimiter(2, 0.001)
    expect(rl.allow()).toBe(true)
    expect(rl.allow()).toBe(true)
    vi.advanceTimersByTime(10000)
    expect(rl.allow()).toBe(true)
    expect(rl.allow()).toBe(true)
    expect(rl.allow()).toBe(false)
  })

  it('refills correctly after multiple intervals', () => {
    const rl = new RateLimiter(2, 0.001)
    expect(rl.allow()).toBe(true)
    expect(rl.allow()).toBe(true)
    vi.advanceTimersByTime(500)
    expect(rl.allow()).toBe(true)
    vi.advanceTimersByTime(500)
    expect(rl.allow()).toBe(true)
    expect(rl.allow()).toBe(false)
  })
})
`)
    },
    verify: async (workspace) => {
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  {
    id: 'fix-async-race-condition',
    category: 'async-race-bug',
    description: 'Fix an async race condition in a cache-with-inflight-tracking module',
    expectsFlashFailure: true,
    task: 'The file `inflightCache.ts` has a race condition: when two callers request the same key simultaneously, the second caller does not await the in-flight promise and instead starts a new fetch. Fix the bug so `inflightCache.test.ts` passes. Do not change the test file.',
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
      await writeWorkspaceFile(workspace, 'inflightCache.ts', `
export class InflightCache<K, V> {
  private cache = new Map<K, V>()
  private inflight = new Map<K, Promise<V>>()
  constructor(private readonly fetcher: (key: K) => Promise<V>) {}
  async get(key: K): Promise<V> {
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached
    const existing = this.inflight.get(key)
    if (existing !== undefined) return existing
    const promise = this.fetcher(key)
    this.inflight.set(key, promise)
    const value = await promise
    this.cache.set(key, value)
    this.inflight.delete(key)
    return value
  }
}
`)
      await writeWorkspaceFile(workspace, 'inflightCache.test.ts', `
import { describe, it, expect, vi } from 'vitest'
import { InflightCache } from './inflightCache.ts'

describe('InflightCache', () => {
  it('caches results', async () => {
    const fetcher = vi.fn(async (key: string) => \`value-\${key}\`)
    const cache = new InflightCache(fetcher)
    expect(await cache.get('a')).toBe('value-a')
    expect(await cache.get('a')).toBe('value-a')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('deduplicates concurrent requests', async () => {
    const fetcher = vi.fn(async (key: string) => {
      await new Promise(r => setTimeout(r, 50))
      return \`value-\${key}\`
    })
    const cache = new InflightCache(fetcher)
    const [r1, r2] = await Promise.all([cache.get('a'), cache.get('a')])
    expect(r1).toBe('value-a')
    expect(r2).toBe('value-a')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('deduplicates three concurrent requests', async () => {
    const fetcher = vi.fn(async (key: string) => {
      await new Promise(r => setTimeout(r, 50))
      return \`value-\${key}\`
    })
    const cache = new InflightCache(fetcher)
    const [r1, r2, r3] = await Promise.all([
      cache.get('x'), cache.get('x'), cache.get('x'),
    ])
    expect(r1).toBe('value-x')
    expect(r2).toBe('value-x')
    expect(r3).toBe('value-x')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
`)
    },
    verify: async (workspace) => {
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  {
    id: 'fix-multi-file-event-bus',
    category: 'multi-file-bug',
    description: 'Fix a multi-file event bus where typed event removal is broken',
    expectsFlashFailure: true,
    task: 'The files `eventBus.ts` and `typedEvents.ts` implement a typed event bus. The `off()` method does not correctly remove listeners because it compares function references after they are wrapped. Fix the bug so `eventBus.test.ts` passes. Do not change the test file.',
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
      await writeWorkspaceFile(workspace, 'typedEvents.ts', `
export interface EventMap {
  'user:login': { userId: string; timestamp: number }
  'user:logout': { userId: string }
  'data:update': { key: string; value: unknown }
}
`)
      await writeWorkspaceFile(workspace, 'eventBus.ts', `
import type { EventMap } from './typedEvents.ts'

type EventName = keyof EventMap
type Listener<K extends EventName> = (payload: EventMap[K]) => void

export class EventBus {
  private listeners = new Map<EventName, Map<Listener<EventName>, Listener<EventName>>>()

  on<K extends EventName>(event: K, listener: Listener<K>): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Map())
    const wrapped = listener as Listener<EventName>
    this.listeners.get(event)!.set(wrapped, wrapped)
    return () => this.off(event, listener)
  }

  off<K extends EventName>(event: K, listener: Listener<K>): void {
    const map = this.listeners.get(event)
    if (!map) return
    map.delete(listener as Listener<EventName>)
  }

  emit<K extends EventName>(event: K, payload: EventMap[K]): void {
    const map = this.listeners.get(event)
    if (!map) return
    for (const listener of map.values()) {
      listener(payload)
    }
  }
}
`)
      await writeWorkspaceFile(workspace, 'eventBus.test.ts', `
import { describe, it, expect, vi } from 'vitest'
import { EventBus } from './eventBus.ts'

describe('EventBus', () => {
  it('calls listeners on emit', () => {
    const bus = new EventBus()
    const fn = vi.fn()
    bus.on('user:login', fn)
    bus.emit('user:login', { userId: 'u1', timestamp: 123 })
    expect(fn).toHaveBeenCalledWith({ userId: 'u1', timestamp: 123 })
  })

  it('removes listeners via off()', () => {
    const bus = new EventBus()
    const fn = vi.fn()
    bus.on('user:logout', fn)
    bus.off('user:logout', fn)
    bus.emit('user:logout', { userId: 'u1' })
    expect(fn).not.toHaveBeenCalled()
  })

  it('removes listeners via the returned disposer', () => {
    const bus = new EventBus()
    const fn = vi.fn()
    const dispose = bus.on('data:update', fn)
    dispose()
    bus.emit('data:update', { key: 'k', value: 42 })
    expect(fn).not.toHaveBeenCalled()
  })

  it('does not affect other listeners when one is removed', () => {
    const bus = new EventBus()
    const fn1 = vi.fn()
    const fn2 = vi.fn()
    bus.on('user:login', fn1)
    bus.on('user:login', fn2)
    bus.off('user:login', fn1)
    bus.emit('user:login', { userId: 'u2', timestamp: 456 })
    expect(fn1).not.toHaveBeenCalled()
    expect(fn2).toHaveBeenCalledWith({ userId: 'u2', timestamp: 456 })
  })
})
`)
    },
    verify: async (workspace) => {
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  {
    id: 'fix-type-safe-result-chain',
    category: 'type-system-failure',
    description: 'Fix type errors in a Result/Either chain with proper narrowing',
    expectsFlashFailure: true,
    task: 'The file `result.ts` has TypeScript type errors: the `map` and `flatMap` methods do not properly narrow the Ok vs Error variants, and the `unwrap` method has an unsafe return type. Fix the type errors so `tsc --noEmit` passes and `result.test.ts` passes. Do not change the test file.',
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
      await writeWorkspaceFile(workspace, 'result.ts', `
export type Result<T, E> = Ok<T, E> | Err<T, E>

export class Ok<T, E> {
  constructor(readonly value: T) {}
  isOk(): this is Ok<T, E> { return true }
  isErr(): this is Err<T, E> { return false }
  map<U>(fn: (value: T) => U): Result<U, E> {
    return new Ok(fn(this.value))
  }
  flatMap<U>(fn: (value: T) => Result<U, E>): Result<U, E> {
    return fn(this.value)
  }
  unwrap(): T {
    return this.value
  }
}

export class Err<T, E> {
  constructor(readonly error: E) {}
  isOk(): this is Ok<T, E> { return false }
  isErr(): this is Err<T, E> { return true }
  map<U>(fn: (value: T) => U): Result<U, E> {
    return new Err(this.error)
  }
  flatMap<U>(fn: (value: T) => Result<U, E>): Result<U, E> {
    return new Err(this.error)
  }
  unwrap(): T {
    throw new Error(\`unwrap called on Err: \${String(this.error)}\`)
  }
}

export function ok<T, E>(value: T): Result<T, E> {
  return new Ok(value)
}

export function err<T, E>(error: E): Result<T, E> {
  return new Err(error)
}
`)
      await writeWorkspaceFile(workspace, 'result.test.ts', `
import { describe, it, expect } from 'vitest'
import { ok, err, type Result } from './result.ts'

describe('Result', () => {
  it('map transforms Ok values', () => {
    const r = ok<number, string>(5).map(x => x * 2)
    expect(r.isOk()).toBe(true)
    if (r.isOk()) expect(r.value).toBe(10)
  })

  it('map does not transform Err', () => {
    const r = err<number, string>('fail').map(x => x * 2)
    expect(r.isErr()).toBe(true)
    if (r.isErr()) expect(r.error).toBe('fail')
  })

  it('flatMap chains Ok', () => {
    const r = ok<number, string>(5)
      .flatMap(x => ok<string, string>(\`num:\${x}\`))
    expect(r.isOk()).toBe(true)
    if (r.isOk()) expect(r.value).toBe('num:5')
  })

  it('flatMap short-circuits on Err', () => {
    const r = err<number, string>('fail')
      .flatMap(x => ok<string, string>(\`num:\${x}\`))
    expect(r.isErr()).toBe(true)
    if (r.isErr()) expect(r.error).toBe('fail')
  })

  it('unwrap returns value on Ok', () => {
    expect(ok<number, string>(42).unwrap()).toBe(42)
  })

  it('unwrap throws on Err', () => {
    expect(() => err<number, string>('bad').unwrap()).toThrow()
  })
})
`)
    },
    verify: async (workspace) => {
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  {
    id: 'fix-observable-pipeline',
    category: 'architectural-misunderstanding',
    description: 'Fix a broken observable pipeline with map, filter, and take operators',
    expectsFlashFailure: true,
    task: 'The file `observable.ts` implements a minimal observable with `pipe`, `map`, `filter`, and `take` operators. The `take` operator does not properly complete the subscription after N values, and `pipe` does not correctly chain operators. Fix the bugs so `observable.test.ts` passes. Do not change the test file.',
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
      await writeWorkspaceFile(workspace, 'observable.ts', `
type Subscriber<T> = (value: T) => void
type Unsubscribe = () => void

export class Observable<T> {
  constructor(private readonly subscribeFn: (subscriber: Subscriber<T>) => Unsubscribe) {}
  subscribe(subscriber: Subscriber<T>): Unsubscribe {
    return this.subscribeFn(subscriber)
  }
  pipe<U>(...operators: Array<(obs: Observable<T>) => Observable<U>>): Observable<U> {
    return operators.reduce((acc, op) => op(acc), this as Observable<unknown>) as Observable<U>
  }
}

export function map<T, U>(fn: (value: T) => U): (obs: Observable<T>) => Observable<U> {
  return (obs: Observable<T>) => new Observable<U>((subscriber) => {
    return obs.subscribe((value) => subscriber(fn(value)))
  })
}

export function filter<T>(pred: (value: T) => boolean): (obs: Observable<T>) => Observable<T> {
  return (obs: Observable<T>) => new Observable<T>((subscriber) => {
    return obs.subscribe((value) => {
      if (pred(value)) subscriber(value)
    })
  })
}

export function take<T>(n: number): (obs: Observable<T>) => Observable<T> {
  return (obs: Observable<T>) => new Observable<T>((subscriber) => {
    let count = 0
    const unsub = obs.subscribe((value) => {
      if (count < n) {
        count++
        subscriber(value)
      }
    })
    return unsub
  })
}
`)
      await writeWorkspaceFile(workspace, 'observable.test.ts', `
import { describe, it, expect } from 'vitest'
import { Observable, map, filter, take } from './observable.ts'

function fromArray<T>(values: T[]): Observable<T> {
  return new Observable<T>((subscriber) => {
    for (const v of values) subscriber(v)
    return () => {}
  })
}

describe('Observable', () => {
  it('map transforms values', () => {
    const results: number[] = []
    fromArray([1, 2, 3]).pipe(map(x => x * 10)).subscribe(v => results.push(v))
    expect(results).toEqual([10, 20, 30])
  })

  it('filter removes values', () => {
    const results: number[] = []
    fromArray([1, 2, 3, 4, 5]).pipe(filter(x => x % 2 === 0)).subscribe(v => results.push(v))
    expect(results).toEqual([2, 4])
  })

  it('take limits the number of values', () => {
    const results: number[] = []
    fromArray([1, 2, 3, 4, 5]).pipe(take(3)).subscribe(v => results.push(v))
    expect(results).toEqual([1, 2, 3])
  })

  it('chained pipe works', () => {
    const results: number[] = []
    fromArray([1, 2, 3, 4, 5, 6])
      .pipe(
        filter(x => x % 2 === 0),
        map(x => x * 10),
        take(2),
      )
      .subscribe(v => results.push(v))
    expect(results).toEqual([20, 40])
  })
})
`)
    },
    verify: async (workspace) => {
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  {
    id: 'fix-trie-implementation',
    category: 'algorithmic-bug',
    description: 'Fix a broken Trie implementation with incorrect search and delete',
    expectsFlashFailure: true,
    task: 'The file `trie.ts` implements a Trie with `insert`, `search`, `startsWith`, and `delete` methods. The `search` method incorrectly returns true for prefixes that are not complete words, and `delete` does not properly prune empty nodes. Fix the bugs so `trie.test.ts` passes. Do not change the test file.',
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
      await writeWorkspaceFile(workspace, 'trie.ts', `
class TrieNode {
  children = new Map<string, TrieNode>()
  isEndOfWord = false
}

export class Trie {
  private root = new TrieNode()

  insert(word: string): void {
    let node = this.root
    for (const char of word) {
      if (!node.children.has(char)) node.children.set(char, new TrieNode())
      node = node.children.get(char)!
    }
    node.isEndOfWord = true
  }

  search(word: string): boolean {
    let node = this.root
    for (const char of word) {
      if (!node.children.has(char)) return false
      node = node.children.get(char)!
    }
    return true
  }

  startsWith(prefix: string): boolean {
    let node = this.root
    for (const char of prefix) {
      if (!node.children.has(char)) return false
      node = node.children.get(char)!
    }
    return true
  }

  delete(word: string): void {
    const deleteHelper = (node: TrieNode, word: string, index: number): boolean => {
      if (index === word.length) {
        if (!node.isEndOfWord) return false
        node.isEndOfWord = false
        return node.children.size === 0
      }
      const char = word[index]
      const child = node.children.get(char)
      if (child === undefined) return false
      const shouldDelete = deleteHelper(child, word, index + 1)
      if (shouldDelete) {
        node.children.delete(char)
        return node.children.size === 0 && !node.isEndOfWord
      }
      return false
    }
    deleteHelper(this.root, word, 0)
  }
}
`)
      await writeWorkspaceFile(workspace, 'trie.test.ts', `
import { describe, it, expect } from 'vitest'
import { Trie } from './trie.ts'

describe('Trie', () => {
  it('inserts and searches complete words', () => {
    const trie = new Trie()
    trie.insert('apple')
    expect(trie.search('apple')).toBe(true)
    expect(trie.search('app')).toBe(false)
  })

  it('startsWith finds prefixes', () => {
    const trie = new Trie()
    trie.insert('apple')
    trie.insert('app')
    expect(trie.startsWith('app')).toBe(true)
    expect(trie.startsWith('apl')).toBe(false)
  })

  it('search distinguishes words from prefixes', () => {
    const trie = new Trie()
    trie.insert('apple')
    trie.insert('app')
    expect(trie.search('app')).toBe(true)
    expect(trie.search('appl')).toBe(false)
  })

  it('delete removes words', () => {
    const trie = new Trie()
    trie.insert('apple')
    trie.insert('app')
    trie.delete('apple')
    expect(trie.search('apple')).toBe(false)
    expect(trie.search('app')).toBe(true)
  })

  it('delete prunes empty nodes', () => {
    const trie = new Trie()
    trie.insert('app')
    trie.delete('app')
    expect(trie.search('app')).toBe(false)
    expect(trie.startsWith('a')).toBe(false)
  })
})
`)
    },
    verify: async (workspace) => {
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  {
    id: 'fix-lru-cache',
    category: 'data-structure-bug',
    description: 'Fix an LRU cache with broken eviction order',
    expectsFlashFailure: true,
    task: 'The file `lruCache.ts` implements an LRU cache using a Map. The eviction logic has a bug: it evicts the most recently used item instead of the least recently used, and `get` does not update recency. Fix the bugs so `lruCache.test.ts` passes. Do not change the test file.',
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
      await writeWorkspaceFile(workspace, 'lruCache.ts', `
export class LRUCache<K, V> {
  private cache = new Map<K, V>()
  constructor(private readonly capacity: number) {}
  get(key: K): V | undefined {
    return this.cache.get(key)
  }
  set(key: K, value: V): void {
    if (this.cache.size >= this.capacity) {
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) this.cache.delete(firstKey)
    }
    this.cache.set(key, value)
  }
  has(key: K): boolean {
    return this.cache.has(key)
  }
  get size(): number {
    return this.cache.size
  }
}
`)
      await writeWorkspaceFile(workspace, 'lruCache.test.ts', `
import { describe, it, expect } from 'vitest'
import { LRUCache } from './lruCache.ts'

describe('LRUCache', () => {
  it('stores and retrieves values', () => {
    const cache = new LRUCache<string, number>(3)
    cache.set('a', 1)
    cache.set('b', 2)
    expect(cache.get('a')).toBe(1)
    expect(cache.get('b')).toBe(2)
  })

  it('evicts the least recently used item when capacity is exceeded', () => {
    const cache = new LRUCache<string, number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.get('a')
    cache.set('c', 3)
    expect(cache.has('a')).toBe(true)
    expect(cache.has('b')).toBe(false)
    expect(cache.has('c')).toBe(true)
  })

  it('get updates recency', () => {
    const cache = new LRUCache<string, number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.get('a')
    cache.set('c', 3)
    expect(cache.has('a')).toBe(true)
    expect(cache.has('b')).toBe(false)
  })

  it('set on existing key updates value and recency', () => {
    const cache = new LRUCache<string, number>(2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('a', 10)
    cache.set('c', 3)
    expect(cache.has('a')).toBe(true)
    expect(cache.get('a')).toBe(10)
    expect(cache.has('b')).toBe(false)
  })
})
`)
    },
    verify: async (workspace) => {
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  {
    id: 'fix-validation-pipeline',
    category: 'api-contract-bug',
    description: 'Fix a validation pipeline that incorrectly accepts invalid data',
    expectsFlashFailure: true,
    task: 'The file `validator.ts` implements a schema validator with `string`, `number`, `object`, and `array` validators. The `object` validator does not check all required keys, and the `array` validator does not validate individual elements. Fix the bugs so `validator.test.ts` passes. Do not change the test file.',
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
      await writeWorkspaceFile(workspace, 'validator.ts', `
export type ValidationResult = { ok: true; value: unknown } | { ok: false; errors: string[] }

export interface Validator {
  validate(input: unknown): ValidationResult
}

export function string(): Validator {
  return {
    validate(input: unknown) {
      if (typeof input === 'string') return { ok: true, value: input }
      return { ok: false, errors: ['expected string'] }
    },
  }
}

export function number(): Validator {
  return {
    validate(input: unknown) {
      if (typeof input === 'number') return { ok: true, value: input }
      return { ok: false, errors: ['expected number'] }
    },
  }
}

export function object(schema: Record<string, Validator>): Validator {
  return {
    validate(input: unknown) {
      if (typeof input !== 'object' || input === null) {
        return { ok: false, errors: ['expected object'] }
      }
      const obj = input as Record<string, unknown>
      const errors: string[] = []
      const result: Record<string, unknown> = {}
      for (const [key, validator] of Object.entries(schema)) {
        const fieldResult = validator.validate(obj[key])
        if (fieldResult.ok) {
          result[key] = fieldResult.value
        } else {
          errors.push(...fieldResult.errors.map(e => \`\${key}: \${e}\`))
        }
      }
      if (errors.length > 0) return { ok: false, errors }
      return { ok: true, value: result }
    },
  }
}

export function array(elementValidator: Validator): Validator {
  return {
    validate(input: unknown) {
      if (!Array.isArray(input)) return { ok: false, errors: ['expected array'] }
      return { ok: true, value: input }
    },
  }
}
`)
      await writeWorkspaceFile(workspace, 'validator.test.ts', `
import { describe, it, expect } from 'vitest'
import { string, number, object, array } from './validator.ts'

describe('validators', () => {
  it('string accepts strings', () => {
    expect(string().validate('hello').ok).toBe(true)
    expect(string().validate(42).ok).toBe(false)
  })

  it('number accepts numbers', () => {
    expect(number().validate(42).ok).toBe(true)
    expect(number().validate('42').ok).toBe(false)
  })

  it('object validates all required keys', () => {
    const schema = object({ name: string(), age: number() })
    expect(schema.validate({ name: 'Alice', age: 30 }).ok).toBe(true)
    expect(schema.validate({ name: 'Alice' }).ok).toBe(false)
    expect(schema.validate({ age: 30 }).ok).toBe(false)
  })

  it('object rejects non-objects', () => {
    const schema = object({ name: string() })
    expect(schema.validate(null).ok).toBe(false)
    expect(schema.validate('hello').ok).toBe(false)
  })

  it('array validates each element', () => {
    const schema = array(number())
    expect(schema.validate([1, 2, 3]).ok).toBe(true)
    expect(schema.validate([1, 'two', 3]).ok).toBe(false)
    expect(schema.validate('not array').ok).toBe(false)
  })

  it('nested object inside array', () => {
    const schema = array(object({ name: string() }))
    expect(schema.validate([{ name: 'a' }, { name: 'b' }]).ok).toBe(true)
    expect(schema.validate([{ name: 'a' }, { age: 1 }]).ok).toBe(false)
  })
})
`)
    },
    verify: async (workspace) => {
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  {
    id: 'fix-promise-queue-concurrency',
    category: 'async-concurrency-bug',
    description: 'Fix a promise queue with broken concurrency control',
    expectsFlashFailure: true,
    task: 'The file `promiseQueue.ts` implements a concurrency-limited promise queue. The concurrency control is broken: it starts all tasks immediately instead of limiting to `concurrency` at a time. Fix the bug so `promiseQueue.test.ts` passes. Do not change the test file.',
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
      await writeWorkspaceFile(workspace, 'promiseQueue.ts', `
export class PromiseQueue<T> {
  constructor(private readonly concurrency: number) {}
  async run(tasks: Array<() => Promise<T>>): Promise<T[]> {
    const results: T[] = new Array(tasks.length)
    let nextIndex = 0
    const runNext = async (): Promise<void> => {
      while (nextIndex < tasks.length) {
        const index = nextIndex++
        results[index] = await tasks[index]()
      }
    }
    await Promise.all(Array.from({ length: tasks.length }, () => runNext()))
    return results
  }
}
`)
      await writeWorkspaceFile(workspace, 'promiseQueue.test.ts', `
import { describe, it, expect, vi } from 'vitest'
import { PromiseQueue } from './promiseQueue.ts'

describe('PromiseQueue', () => {
  it('runs all tasks and returns results in order', async () => {
    const queue = new PromiseQueue<number>(2)
    const tasks = [
      () => Promise.resolve(1),
      () => Promise.resolve(2),
      () => Promise.resolve(3),
    ]
    const results = await queue.run(tasks)
    expect(results).toEqual([1, 2, 3])
  })

  it('limits concurrency', async () => {
    let active = 0
    let maxActive = 0
    const queue = new PromiseQueue<number>(2)
    const makeTask = (value: number) => async (): Promise<number> => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(r => setTimeout(r, 50))
      active--
      return value
    }
    await queue.run([makeTask(1), makeTask(2), makeTask(3), makeTask(4), makeTask(5)])
    expect(maxActive).toBeLessThanOrEqual(2)
  })

  it('handles empty task list', async () => {
    const queue = new PromiseQueue<number>(3)
    const results = await queue.run([])
    expect(results).toEqual([])
  })

  it('preserves order even with varying completion times', async () => {
    const queue = new PromiseQueue<number>(2)
    const tasks = [
      async () => { await new Promise(r => setTimeout(r, 100)); return 1 },
      async () => { await new Promise(r => setTimeout(r, 10)); return 2 },
      async () => { await new Promise(r => setTimeout(r, 50)); return 3 },
    ]
    const results = await queue.run(tasks)
    expect(results).toEqual([1, 2, 3])
  })
})
`)
    },
    verify: async (workspace) => {
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  {
    id: 'fix-binary-heap',
    category: 'algorithmic-bug',
    description: 'Fix a binary min-heap with broken sift-down logic',
    expectsFlashFailure: true,
    task: 'The file `minHeap.ts` implements a binary min-heap with `insert`, `extractMin`, and `peek` methods. The `siftDown` method has an off-by-one error that causes the heap property to be violated after extraction. Fix the bug so `minHeap.test.ts` passes. Do not change the test file.',
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
      await writeWorkspaceFile(workspace, 'minHeap.ts', `
export class MinHeap {
  private heap: number[] = []
  get size(): number { return this.heap.length }
  insert(value: number): void {
    this.heap.push(value)
    this.siftUp(this.heap.length - 1)
  }
  peek(): number | undefined {
    return this.heap[0]
  }
  extractMin(): number | undefined {
    if (this.heap.length === 0) return undefined
    const min = this.heap[0]
    const last = this.heap.pop()!
    if (this.heap.length > 0) {
      this.heap[0] = last
      this.siftDown(0)
    }
    return min
  }
  private siftUp(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (this.heap[index] >= this.heap[parent]) break
      ;[this.heap[index], this.heap[parent]] = [this.heap[parent], this.heap[index]]
      index = parent
    }
  }
  private siftDown(index: number): void {
    const n = this.heap.length
    while (true) {
      const left = 2 * index + 1
      const right = 2 * index + 2
      let smallest = index
      if (left < n && this.heap[left] < this.heap[smallest]) smallest = left
      if (right < n && this.heap[right] < this.heap[smallest]) smallest = right
      if (smallest === index) break
      ;[this.heap[index], this.heap[smallest]] = [this.heap[smallest], this.heap[index]]
      index = smallest
    }
  }
}
`)
      await writeWorkspaceFile(workspace, 'minHeap.test.ts', `
import { describe, it, expect } from 'vitest'
import { MinHeap } from './minHeap.ts'

describe('MinHeap', () => {
  it('extracts elements in sorted order', () => {
    const heap = new MinHeap()
    const values = [5, 3, 8, 1, 9, 2, 7, 4, 6]
    for (const v of values) heap.insert(v)
    const sorted: number[] = []
    while (heap.size > 0) sorted.push(heap.extractMin()!)
    expect(sorted).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('peek returns minimum without removing', () => {
    const heap = new MinHeap()
    heap.insert(5)
    heap.insert(1)
    heap.insert(3)
    expect(heap.peek()).toBe(1)
    expect(heap.size).toBe(3)
  })

  it('handles single element', () => {
    const heap = new MinHeap()
    heap.insert(42)
    expect(heap.extractMin()).toBe(42)
    expect(heap.size).toBe(0)
  })

  it('handles duplicate values', () => {
    const heap = new MinHeap()
    for (const v of [3, 1, 3, 1, 3]) heap.insert(v)
    const sorted: number[] = []
    while (heap.size > 0) sorted.push(heap.extractMin()!)
    expect(sorted).toEqual([1, 1, 3, 3, 3])
  })

  it('maintains heap property after mixed operations', () => {
    const heap = new MinHeap()
    heap.insert(10)
    heap.insert(5)
    heap.insert(15)
    expect(heap.extractMin()).toBe(5)
    heap.insert(3)
    heap.insert(20)
    heap.insert(7)
    const sorted: number[] = []
    while (heap.size > 0) sorted.push(heap.extractMin()!)
    expect(sorted).toEqual([3, 7, 10, 15, 20])
  })
})
`)
    },
    verify: async (workspace) => {
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  // --- Genuinely hard fixtures: hidden tests, from-scratch design ---
  {
    id: 'implement-state-machine',
    category: 'architectural-design',
    description: 'Implement a finite state machine with guards and actions from a spec',
    expectsFlashFailure: true,
    task: `Implement a finite state machine library in \`stateMachine.ts\` with the following API:

- \`createMachine(config)\` returns a machine definition
- \`createInterpreter(machine)\` returns an interpreter with:
  - \`send(event)\` — sends an event, returns the current state
  - \`subscribe(listener)\` — calls listener on every transition, returns unsubscribe
  - \`state\` — getter returning { value: string, context: object }
  - \`can(event)\` — returns true if the event would cause a transition from the current state

Config shape:
\`\`\`ts
{
  initial: 'idle',
  context: { count: 0 },
  states: {
    idle: {
      on: { START: { target: 'running', actions: ['resetCount'] } },
    },
    running: {
      on: {
        TICK: { target: 'running', actions: ['incrementCount'], guard: 'canTick' },
        STOP: { target: 'idle' },
        PAUSE: { target: 'paused' },
      },
    },
    paused: {
      on: { RESUME: { target: 'running' }, STOP: { target: 'idle' } },
    },
  },
  actions: {
    resetCount: (ctx) => ({ ...ctx, count: 0 }),
    incrementCount: (ctx) => ({ ...ctx, count: ctx.count + 1 }),
  },
  guards: {
    canTick: (ctx, event) => ctx.count < 5,
  },
}
\`\`\`

Guards return false to block a transition. Actions receive context and event, return new context.
If a guard blocks, the state and context do not change.
Export \`createMachine\` and \`createInterpreter\` as named exports.`,
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
    },
    verify: async (workspace) => {
      await writeWorkspaceFile(workspace, '__hidden_test__.test.ts', STATE_MACHINE_TEST)
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      const { unlink } = await import('node:fs/promises')
      try { await unlink(join(workspace, '__hidden_test__.test.ts')) } catch { /* ignore */ }
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  {
    id: 'implement-middleware-stack',
    category: 'architectural-design',
    description: 'Implement a middleware pipeline with async handlers and error handling',
    expectsFlashFailure: true,
    task: `Implement a middleware pipeline in \`middleware.ts\` with the following API:

- \`createPipeline()\` returns a pipeline with:
  - \`use(middleware)\` — registers a middleware (returns the pipeline for chaining)
  - \`run(context)\` — executes the pipeline, returns a Promise<result>

Middleware signature:
\`\`\`ts
type Middleware<T> = (ctx: T, next: () => Promise<void>) => Promise<void>
\`\`\`

Each middleware calls \`next()\` to pass control to the next middleware.
If a middleware does not call \`next()\`, downstream middleware does not run.

The pipeline must support:
1. **Error middleware**: if a middleware throws, the error propagates to upstream middleware that catch it via try/catch around \`await next()\`.
2. **Early return**: a middleware can set \`ctx.result\` and not call \`next()\`.
3. **Ordering**: middleware runs in registration order, unwinding in reverse.

Export \`createPipeline\` and the \`Middleware\` type as named exports.`,
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
    },
    verify: async (workspace) => {
      await writeWorkspaceFile(workspace, '__hidden_test__.test.ts', MIDDLEWARE_TEST)
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      const { unlink } = await import('node:fs/promises')
      try { await unlink(join(workspace, '__hidden_test__.test.ts')) } catch { /* ignore */ }
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  {
    id: 'implement-reactive-store',
    category: 'architectural-design',
    description: 'Implement a reactive store with selectors and computed values',
    expectsFlashFailure: true,
    task: `Implement a reactive store in \`store.ts\` with the following API:

- \`createStore<T>(initialState: T)\` returns:
  - \`getState()\` — returns current state
  - \`setState(partial: Partial<T>)\` — merges partial into state, notifies subscribers
  - \`subscribe(listener)\` — listener receives (newState, oldState), returns unsubscribe
  - \`select<R>(selector: (state: T) => R)\` — returns a derived store with:
    - \`get()\` — returns the selector result
    - \`subscribe(listener)\` — only fires when the selector result changes (shallow equality)
    - returns unsubscribe

The select() method must:
1. Only notify subscribers when the computed value actually changes
2. Support chaining: store.select(s => s.users).select(users => users.length)
3. Work with arrays and objects (shallow comparison)

Export \`createStore\` as a named export.`,
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
    },
    verify: async (workspace) => {
      await writeWorkspaceFile(workspace, '__hidden_test__.test.ts', REACTIVE_STORE_TEST)
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      const { unlink } = await import('node:fs/promises')
      try { await unlink(join(workspace, '__hidden_test__.test.ts')) } catch { /* ignore */ }
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  {
    id: 'implement-graph-traversal',
    category: 'algorithmic-design',
    description: 'Implement weighted graph with Dijkstra and topological sort',
    expectsFlashFailure: true,
    task: `Implement a weighted directed graph in \`graph.ts\` with:

- \`class Graph<T>\` with:
  - \`addNode(id: string, data: T)\` — adds a node
  - \`addEdge(from: string, to: string, weight: number)\` — adds a directed edge
  - \`dijkstra(start: string, end: string)\` — returns { path: string[], distance: number } or null if no path
  - \`topologicalSort()\` — returns string[] in topological order, throws if cycle exists

The graph must handle:
1. Multiple paths between same nodes (picks shortest)
2. Disconnected graphs (dijkstra returns null if unreachable)
3. Self-loops and cycles (topologicalSort throws on cycle)
4. Negative weights are not allowed (throw on addEdge if weight < 0)

Export \`Graph\` as a named export.`,
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
    },
    verify: async (workspace) => {
      await writeWorkspaceFile(workspace, '__hidden_test__.test.ts', GRAPH_TEST)
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      const { unlink } = await import('node:fs/promises')
      try { await unlink(join(workspace, '__hidden_test__.test.ts')) } catch { /* ignore */ }
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  {
    id: 'implement-dependency-injector',
    category: 'architectural-design',
    description: 'Implement a DI container with scopes, factories, and singleton/transient lifetimes',
    expectsFlashFailure: true,
    task: `Implement a dependency injection container in \`di.ts\` with:

- \`class Container\` with:
  - \`register<T>(token: string, factory: (container: Container) => T, lifetime?: 'singleton' | 'transient')\`
    - Default lifetime is 'transient'
    - Singleton: factory runs once, result cached
    - Transient: factory runs every resolve
  - \`resolve<T>(token: string): T\`
    - Throws if token not registered
    - Resolves dependencies recursively
  - \`createScope()\` — returns a new Container that inherits registrations from parent
    - Scoped container can override registrations
    - Singleton resolved in scope caches in scope, not parent
  - \`dispose()\` — calls \`dispose()\` on all resolved singletons that have it

Handle circular dependencies by throwing an error with the cycle path.

Export \`Container\` as a named export.`,
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
    },
    verify: async (workspace) => {
      await writeWorkspaceFile(workspace, '__hidden_test__.test.ts', DI_TEST)
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      const { unlink } = await import('node:fs/promises')
      try { await unlink(join(workspace, '__hidden_test__.test.ts')) } catch { /* ignore */ }
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  {
    id: 'implement-parser-combinator',
    category: 'algorithmic-design',
    description: 'Implement a parser combinator library from scratch',
    expectsFlashFailure: true,
    task: `Implement a parser combinator library in \`parser.ts\` with:

- \`type Parser<T>\` — a function (input: string) => { success: true; value: T; rest: string } | { success: false; error: string }
- \`string(s: string): Parser<string>\` — matches literal string
- \`regex(pattern: RegExp): Parser<string>\` — matches regex at current position
- \`map<T, U>(parser: Parser<T>, fn: (value: T) => U): Parser<U>\` — transforms result
- \`seq<T>(...parsers: Parser<T>[]): Parser<T[]>\` — matches all in sequence
- \`choice<T>(...parsers: Parser<T>[]): Parser<T>\` — matches first that succeeds
- \`many<T>(parser: Parser<T>): Parser<T[]>\` — matches zero or more
- \`optional<T>(parser: Parser<T>): Parser<T | null>\` — matches zero or one
- \`between<T>(open: Parser<unknown>, content: Parser<T>, close: Parser<unknown>): Parser<T>\` — matches content between open and close
- \`parse<T>(parser: Parser<T>, input: string): T\` — runs parser, throws on failure or if rest is non-empty

Export all functions and the Parser type as named exports.`,
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
    },
    verify: async (workspace) => {
      await writeWorkspaceFile(workspace, '__hidden_test__.test.ts', PARSER_TEST)
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      const { unlink } = await import('node:fs/promises')
      try { await unlink(join(workspace, '__hidden_test__.test.ts')) } catch { /* ignore */ }
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  {
    id: 'implement-transactional-map',
    category: 'concurrency-design',
    description: 'Implement a transactional key-value store with nested transactions',
    expectsFlashFailure: true,
    task: `Implement a transactional key-value store in \`txMap.ts\` with:

- \`class TransactionalMap\` with:
  - \`get(key: string): unknown | undefined\`
  - \`set(key: string, value: unknown): void\`
  - \`delete(key: string): void\`
  - \`begin(): Transaction\` — starts a transaction
  - \`commit(tx: Transaction): void\` — applies all changes atomically
  - \`rollback(tx: Transaction): void\` — discards all changes

- \`class Transaction\` (returned by begin()):
  - \`get(key: string): unknown | undefined\` — reads from staged changes or falls back to main store
  - \`set(key: string, value: unknown): void\` — stages a set
  - \`delete(key: string): void\` — stages a delete
  - \`has(key: string): boolean\` — checks staged changes or main store
  - \`begin(): Transaction\` — starts a nested transaction

Transactions must:
1. Be isolated — changes not visible to main store until commit
2. Support nested transactions — begin() inside a transaction creates a nested one
3. Nested commit applies to parent, nested rollback discards to parent level
4. Atomic — commit applies all or nothing

Export \`TransactionalMap\` as a named export.`,
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
    },
    verify: async (workspace) => {
      await writeWorkspaceFile(workspace, '__hidden_test__.test.ts', TX_MAP_TEST)
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      const { unlink } = await import('node:fs/promises')
      try { await unlink(join(workspace, '__hidden_test__.test.ts')) } catch { /* ignore */ }
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  // --- Escalation-target fixtures: designed to stress Flash and exercise Pro fallback ---
  {
    id: 'implement-lock-free-ring-buffer',
    category: 'escalation-target-concurrency',
    description: 'Implement a lock-free SPSC ring buffer with memory ordering guarantees',
    expectsFlashFailure: true,
    task: `Implement a single-producer single-consumer lock-free ring buffer in \`spscQueue.ts\` using TypeScript's \`Atomics\` API on a \`SharedArrayBuffer\`.

Requirements:
- \`class SpscQueue<T>\` where T is serialized to a fixed-size buffer
- Constructor takes \`capacity\` (number of slots) and \`slotSize\` (bytes per slot)
- Uses a \`SharedArrayBuffer\` with a header (8 bytes: 4 for read index, 4 for write index) followed by slot data
- \`enqueue(value: T): boolean\` — serializes value to JSON, writes to next slot, returns false if full
- \`dequeue(): T | null\` — reads next slot, deserializes, returns null if empty
- Uses \`Atomics.store\` and \`Atomics.load\` with explicit memory ordering
- Producer writes data first, then publishes write index with \`Atomics.store\` and \`'release'\` ordering
- Consumer reads write index with \`Atomics.load\` and \`'acquire'\` ordering, then reads data
- Must handle wraparound correctly
- Export \`SpscQueue\` as a named export

The key correctness requirement: a consumer must never see a partially written slot. The memory ordering on the indices ensures this.`,
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
    },
    verify: async (workspace) => {
      await writeWorkspaceFile(workspace, '__hidden_test__.test.ts', SPSC_TEST)
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      const { unlink } = await import('node:fs/promises')
      try { await unlink(join(workspace, '__hidden_test__.test.ts')) } catch { /* ignore */ }
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  {
    id: 'implement-diff-algorithm',
    category: 'escalation-target-algorithmic',
    description: 'Implement Myers diff algorithm with O(ND) complexity',
    expectsFlashFailure: true,
    task: `Implement the Myers diff algorithm in \`diff.ts\`. This is the algorithm used by \`git diff\`.

Requirements:
- \`function diff(a: string[], b: string[]): DiffResult[]\` — compares two arrays of lines
- \`type DiffResult = { type: 'equal'; lines: string[] } | { type: 'insert'; lines: string[] } | { type: 'delete'; lines: string[] }\`
- Must use the Myers O(ND) algorithm, not a naive LCS approach
- Must produce minimal edit script (fewest possible edits)
- Consecutive equal lines must be coalesced into a single 'equal' entry
- Consecutive insert lines must be coalesced into a single 'insert' entry
- Consecutive delete lines must be coalesced into a single 'delete' entry
- Empty arrays produce empty result
- Identical arrays produce a single 'equal' entry

Export \`diff\` and \`DiffResult\` as named exports.

The Myers algorithm finds the shortest edit script by finding the longest common subsequence through a graph traversal. The key insight is that it operates on the edit graph diagonals, advancing along diagonals where elements match, and only expanding to insert/delete when needed.`,
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
    },
    verify: async (workspace) => {
      await writeWorkspaceFile(workspace, '__hidden_test__.test.ts', DIFF_TEST)
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      const { unlink } = await import('node:fs/promises')
      try { await unlink(join(workspace, '__hidden_test__.test.ts')) } catch { /* ignore */ }
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  {
    id: 'implement-query-planner',
    category: 'escalation-target-architectural',
    description: 'Implement a SQL-like query planner with join reordering',
    expectsFlashFailure: true,
    task: `Implement a simple SQL-like query planner in \`queryPlanner.ts\` that optimizes join order using a dynamic programming approach (System-R style).

Requirements:
- \`type Table = { name: string; rowCount: number }\`
- \`type JoinCondition = { leftTable: string; leftColumn: string; rightTable: string; rightColumn: string; selectivity: number }\`
- \`type Filter = { table: string; column: string; selectivity: number }\`
- \`type QueryPlan = { joins: Array<{ left: string; right: string; condition: JoinCondition; estimatedRows: number }>; totalEstimatedRows: number }\`
- \`function planQuery(tables: Table[], joins: JoinCondition[], filters: Filter[]): QueryPlan\`

The planner must:
1. Apply filters first to estimate filtered row counts for each table
2. Use dynamic programming to find the join order with the minimum estimated intermediate result size
3. For each pair of tables being joined, estimate the result size as: leftRows * rightRows * joinSelectivity
4. Consider all possible join orders (left-deep trees only is acceptable)
5. Return the plan with the lowest total intermediate rows

The key challenge: with N tables, there are N! possible join orders. Dynamic programming over subsets reduces this to 2^N * N^2. For 4 tables, that's 16*16=256 vs 24 permutations — but the DP must correctly enumerate subsets and find the optimal sub-plan for each.

Export \`planQuery\` and all types as named exports.`,
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
    },
    verify: async (workspace) => {
      await writeWorkspaceFile(workspace, '__hidden_test__.test.ts', QUERY_PLANNER_TEST)
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      const { unlink } = await import('node:fs/promises')
      try { await unlink(join(workspace, '__hidden_test__.test.ts')) } catch { /* ignore */ }
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  {
    id: 'implement-raft-log-replication',
    category: 'escalation-target-distributed',
    description: 'Implement Raft log replication state machine with leader election',
    expectsFlashFailure: true,
    task: `Implement a simplified Raft consensus log replication module in \`raft.ts\`.

Requirements:
- \`type LogEntry = { term: number; command: string; index: number }\`
- \`type NodeState = 'follower' | 'candidate' | 'leader'\`
- \`class RaftNode\` with:
  - \`constructor(id: string, peers: string[])\`
  - \`currentTerm: number\` — starts at 0
  - \`votedFor: string | null\` — who this node voted for in current term
  - \`log: LogEntry[]\` — the replicated log
  - \`state: NodeState\` — starts as 'follower'
  - \`commitIndex: number\` — index of last committed entry (-1 initially)
  - \`startElection(): void\` — transitions to candidate, increments term, votes for self, sends RequestVote RPCs
  - \`receiveVote(peerId: string, term: number, voteGranted: boolean): void\` — processes a vote response
  - \`appendEntry(entry: LogEntry): boolean\` — leader appends entry, returns true
  - \`receiveAppendEntries(term: number, leaderId: string, prevLogIndex: number, prevLogTerm: number, entries: LogEntry[], leaderCommit: number): boolean\` — follower processes AppendEntries RPC
  - \`commitEntries(): LogEntry[]\` — commits entries up to commitIndex, returns newly committed entries

Rules:
1. A node rejects RequestVote if the candidate's log is not at least as up-to-date
2. A node rejects AppendEntries if term < currentTerm
3. A node rejects AppendEntries if prevLogIndex doesn't match log[prevLogIndex].term
4. If an existing entry conflicts with a new one (same index, different term), delete it and all that follow
5. A candidate wins election with majority of votes
6. commitIndex advances to min(leaderCommit, last new entry index) on AppendEntries

Export \`RaftNode\` and all types as named exports.`,
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
    },
    verify: async (workspace) => {
      await writeWorkspaceFile(workspace, '__hidden_test__.test.ts', RAFT_TEST)
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      const { unlink } = await import('node:fs/promises')
      try { await unlink(join(workspace, '__hidden_test__.test.ts')) } catch { /* ignore */ }
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
  {
    id: 'implement-type-inference',
    category: 'escalation-target-compiler',
    description: 'Implement Hindley-Milner type inference for a small lambda calculus',
    expectsFlashFailure: true,
    task: `Implement Hindley-Milner type inference in \`typeInference.ts\` for a small typed lambda calculus.

Requirements:
- \`type Expr = { kind: 'var'; name: string } | { kind: 'lambda'; param: string; body: Expr } | { kind: 'app'; func: Expr; arg: Expr } | { kind: 'lit'; value: number | boolean | string }\`
- \`type Type = { kind: 'var'; name: string } | { kind: 'con'; name: string; args: Type[] } | { kind: 'arrow'; from: Type; to: Type }\`
- \`class TypeInferencer\` with:
  - \`infer(expr: Expr): Type\` — returns the inferred type or throws on type error
  - Uses union-find (unification) for type variable substitution
  - Generates fresh type variables internally

Built-in types:
- Numbers: \`{ kind: 'con', name: 'Number', args: [] }\`
- Booleans: \`{ kind: 'con', name: 'Boolean', args: [] }\`
- Strings: \`{ kind: 'con', name: 'String', args: [] }\`

The algorithm:
1. Assign a fresh type variable to each expression
2. Generate constraints from the expression structure
3. Unify constraints (union-find with substitution)
4. Read off the final type

Key cases:
- Lambda: parameter gets a fresh var, body is inferred in extended environment, result is arrow type
- Application: function type must unify with arrow(argType, resultVar), result is resultVar
- Literal: directly typed (Number, Boolean, String)
- Variable: look up in environment

Export \`TypeInferencer\` and all types as named exports.`,
    setup: async (workspace) => {
      await writeWorkspaceFile(workspace, 'package.json', TEST_PACKAGE_JSON)
      await writeWorkspaceFile(workspace, 'tsconfig.json', TEST_TSCONFIG)
    },
    verify: async (workspace) => {
      await writeWorkspaceFile(workspace, '__hidden_test__.test.ts', TYPE_INFERENCE_TEST)
      const typecheck = await runInWorkspace(workspace, ['tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['vitest', 'run', '--reporter=verbose'])
      const failingTests = parseFailingTests(testRun.output)
      const passed = typecheck.code === 0 && testRun.code === 0
      const failedCriteria: string[] = []
      if (typeErrors.length > 0) failedCriteria.push('TypeScript typecheck must pass')
      if (failingTests.length > 0) failedCriteria.push('All tests must pass')
      const { unlink } = await import('node:fs/promises')
      try { await unlink(join(workspace, '__hidden_test__.test.ts')) } catch { /* ignore */ }
      return {
        passed,
        evidence: { failedCriteria, failingTests, typeErrors, buildErrors: [] },
        criteriaPassed: 2 - failedCriteria.length,
        criteriaTotal: 2,
      }
    },
  },
]

// ---------------------------------------------------------------------------
// Hidden test strings for from-scratch design fixtures
// ---------------------------------------------------------------------------

const STATE_MACHINE_TEST = `
import { describe, it, expect } from 'vitest'
import { createMachine, createInterpreter } from './stateMachine.ts'

const machine = createMachine({
  initial: 'idle',
  context: { count: 0 },
  states: {
    idle: { on: { START: { target: 'running', actions: ['resetCount'] } } },
    running: { on: {
      TICK: { target: 'running', actions: ['incrementCount'], guard: 'canTick' },
      STOP: { target: 'idle' },
      PAUSE: { target: 'paused' },
    } },
    paused: { on: { RESUME: { target: 'running' }, STOP: { target: 'idle' } } },
  },
  actions: {
    resetCount: (ctx: any) => ({ ...ctx, count: 0 }),
    incrementCount: (ctx: any) => ({ ...ctx, count: ctx.count + 1 }),
  },
  guards: { canTick: (ctx: any) => ctx.count < 5 },
})

describe('StateMachine', () => {
  it('starts in initial state', () => {
    const i = createInterpreter(machine)
    expect(i.state.value).toBe('idle')
    expect(i.state.context.count).toBe(0)
  })
  it('transitions on events', () => {
    const i = createInterpreter(machine)
    i.send({ type: 'START' })
    expect(i.state.value).toBe('running')
  })
  it('runs actions on transition', () => {
    const i = createInterpreter(machine)
    i.send({ type: 'START' })
    i.send({ type: 'TICK' })
    expect(i.state.context.count).toBe(1)
  })
  it('guards block transitions', () => {
    const i = createInterpreter(machine)
    i.send({ type: 'START' })
    for (let n = 0; n < 10; n++) i.send({ type: 'TICK' })
    expect(i.state.context.count).toBe(5)
  })
  it('can() checks if event would transition', () => {
    const i = createInterpreter(machine)
    expect(i.can({ type: 'START' })).toBe(true)
    expect(i.can({ type: 'TICK' })).toBe(false)
    i.send({ type: 'START' })
    expect(i.can({ type: 'TICK' })).toBe(true)
  })
  it('subscribe receives state updates', () => {
    const i = createInterpreter(machine)
    const states: string[] = []
    i.subscribe((s) => states.push(s.value))
    i.send({ type: 'START' })
    i.send({ type: 'TICK' })
    i.send({ type: 'PAUSE' })
    expect(states).toEqual(['running', 'running', 'paused'])
  })
  it('paused state transitions', () => {
    const i = createInterpreter(machine)
    i.send({ type: 'START' })
    i.send({ type: 'PAUSE' })
    i.send({ type: 'RESUME' })
    i.send({ type: 'STOP' })
    expect(i.state.value).toBe('idle')
  })
  it('resetCount resets context', () => {
    const i = createInterpreter(machine)
    i.send({ type: 'START' })
    i.send({ type: 'TICK' })
    i.send({ type: 'TICK' })
    i.send({ type: 'STOP' })
    i.send({ type: 'START' })
    expect(i.state.context.count).toBe(0)
  })
})
`

const MIDDLEWARE_TEST = `
import { describe, it, expect } from 'vitest'
import { createPipeline, type Middleware } from './middleware.ts'

type Ctx = { log: string[]; result?: string; error?: string }

describe('MiddlewarePipeline', () => {
  it('runs middleware in order', async () => {
    const p = createPipeline<Ctx>()
    p.use(async (ctx, next) => { ctx.log.push('A-before'); await next(); ctx.log.push('A-after') })
    p.use(async (ctx, next) => { ctx.log.push('B-before'); await next(); ctx.log.push('B-after') })
    const r = await p.run({ log: [] })
    expect(r.log).toEqual(['A-before', 'B-before', 'B-after', 'A-after'])
  })
  it('stops if next() not called', async () => {
    const p = createPipeline<Ctx>()
    p.use(async (ctx) => { ctx.result = 'stopped' })
    p.use(async (ctx, next) => { ctx.log.push('no'); await next() })
    const r = await p.run({ log: [] })
    expect(r.result).toBe('stopped')
    expect(r.log).toEqual([])
  })
  it('propagates errors to upstream', async () => {
    const p = createPipeline<Ctx>()
    p.use(async (ctx, next) => { try { await next() } catch (e) { ctx.error = String(e) } })
    p.use(async () => { throw new Error('boom') })
    const r = await p.run({ log: [] })
    expect(r.error).toBe('Error: boom')
  })
  it('supports chaining use()', async () => {
    const p = createPipeline<Ctx>()
      .use(async (ctx, next) => { ctx.log.push('1'); await next() })
      .use(async (ctx, next) => { ctx.log.push('2'); await next() })
    const r = await p.run({ log: [] })
    expect(r.log).toEqual(['1', '2'])
  })
  it('handles empty pipeline', async () => {
    const p = createPipeline<Ctx>()
    const r = await p.run({ log: [] })
    expect(r.log).toEqual([])
  })
  it('multiple catch levels', async () => {
    const p = createPipeline<Ctx>()
    let caught: string[] = []
    p.use(async (ctx, next) => { try { await next() } catch { caught.push('outer') } })
    p.use(async (ctx, next) => { try { await next() } catch { caught.push('inner'); throw new Error('rethrown') } })
    p.use(async () => { throw new Error('original') })
    await p.run({ log: [] })
    expect(caught).toEqual(['inner', 'outer'])
  })
})
`

const REACTIVE_STORE_TEST = `
import { describe, it, expect, vi } from 'vitest'
import { createStore } from './store.ts'

describe('ReactiveStore', () => {
  it('stores and retrieves state', () => {
    const s = createStore({ count: 0, name: 'test' })
    expect(s.getState()).toEqual({ count: 0, name: 'test' })
  })
  it('setState merges partial', () => {
    const s = createStore({ count: 0, name: 'test' })
    s.setState({ count: 5 })
    expect(s.getState()).toEqual({ count: 5, name: 'test' })
  })
  it('subscribe fires on setState', () => {
    const s = createStore({ count: 0 })
    const fn = vi.fn()
    s.subscribe(fn)
    s.setState({ count: 1 })
    expect(fn).toHaveBeenCalledWith({ count: 1 }, { count: 0 })
  })
  it('unsubscribe stops notifications', () => {
    const s = createStore({ count: 0 })
    const fn = vi.fn()
    const unsub = s.subscribe(fn)
    s.setState({ count: 1 })
    expect(fn).toHaveBeenCalledTimes(1)
    unsub()
    s.setState({ count: 2 })
    expect(fn).toHaveBeenCalledTimes(1)
  })
  it('select creates derived store', () => {
    const s = createStore({ count: 5, name: 'test' })
    expect(s.select(st => st.count).get()).toBe(5)
  })
  it('select only fires on change', () => {
    const s = createStore({ count: 0, name: 'a' })
    const cs = s.select(st => st.count)
    const fn = vi.fn()
    cs.subscribe(fn)
    s.setState({ name: 'b' })
    expect(fn).not.toHaveBeenCalled()
    s.setState({ count: 1 })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(1, 0)
  })
  it('select chaining', () => {
    const s = createStore({ users: [{ name: 'a' }, { name: 'b' }] })
    const cs = s.select(st => st.users).select(u => u.length)
    expect(cs.get()).toBe(2)
    const fn = vi.fn()
    cs.subscribe(fn)
    s.setState({ users: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(3, 2)
  })
  it('select no fire on shallow-equal', () => {
    const s = createStore({ items: [1, 2, 3] })
    const cs = s.select(st => st.items)
    const fn = vi.fn()
    cs.subscribe(fn)
    s.setState({ items: [1, 2, 3] })
    expect(fn).not.toHaveBeenCalled()
  })
})
`

const GRAPH_TEST = `
import { describe, it, expect } from 'vitest'
import { Graph } from './graph.ts'

describe('Graph', () => {
  it('Dijkstra shortest path', () => {
    const g = new Graph<string>()
    g.addNode('a', 'A'); g.addNode('b', 'B'); g.addNode('c', 'C')
    g.addEdge('a', 'b', 1); g.addEdge('b', 'c', 2); g.addEdge('a', 'c', 5)
    expect(g.dijkstra('a', 'c')).toEqual({ path: ['a', 'b', 'c'], distance: 3 })
  })
  it('null for unreachable', () => {
    const g = new Graph<string>()
    g.addNode('a', 'A'); g.addNode('b', 'B')
    g.addEdge('a', 'b', 1)
    expect(g.dijkstra('b', 'a')).toBe(null)
  })
  it('multiple paths picks shortest', () => {
    const g = new Graph<string>()
    g.addNode('a', 'A'); g.addNode('b', 'B'); g.addNode('c', 'C'); g.addNode('d', 'D')
    g.addEdge('a', 'b', 1); g.addEdge('a', 'c', 2)
    g.addEdge('b', 'd', 5); g.addEdge('c', 'd', 1)
    expect(g.dijkstra('a', 'd')).toEqual({ path: ['a', 'c', 'd'], distance: 3 })
  })
  it('same start and end', () => {
    const g = new Graph<string>()
    g.addNode('a', 'A')
    expect(g.dijkstra('a', 'a')).toEqual({ path: ['a'], distance: 0 })
  })
  it('topologicalSort valid order', () => {
    const g = new Graph<string>()
    g.addNode('a', 'A'); g.addNode('b', 'B'); g.addNode('c', 'C')
    g.addEdge('a', 'b', 1); g.addEdge('a', 'c', 1); g.addEdge('b', 'c', 1)
    const sorted = g.topologicalSort()
    expect(sorted.indexOf('a')).toBeLessThan(sorted.indexOf('b'))
    expect(sorted.indexOf('a')).toBeLessThan(sorted.indexOf('c'))
    expect(sorted.indexOf('b')).toBeLessThan(sorted.indexOf('c'))
  })
  it('topologicalSort throws on cycle', () => {
    const g = new Graph<string>()
    g.addNode('a', 'A'); g.addNode('b', 'B')
    g.addEdge('a', 'b', 1); g.addEdge('b', 'a', 1)
    expect(() => g.topologicalSort()).toThrow()
  })
  it('throws on negative weight', () => {
    const g = new Graph<string>()
    g.addNode('a', 'A'); g.addNode('b', 'B')
    expect(() => g.addEdge('a', 'b', -1)).toThrow()
  })
  it('handles self-loop in Dijkstra', () => {
    const g = new Graph<string>()
    g.addNode('a', 'A'); g.addNode('b', 'B')
    g.addEdge('a', 'a', 1); g.addEdge('a', 'b', 2)
    expect(g.dijkstra('a', 'b')).toEqual({ path: ['a', 'b'], distance: 2 })
  })
})
`

const DI_TEST = `
import { describe, it, expect } from 'vitest'
import { Container } from './di.ts'

describe('Container', () => {
  it('resolves registered deps', () => {
    const c = new Container()
    c.register('db', () => ({ query: () => 'data' }))
    expect(c.resolve<{ query: () => string }>('db').query()).toBe('data')
  })
  it('transient creates new instances', () => {
    const c = new Container()
    let n = 0
    c.register('svc', () => ({ id: ++n }), 'transient')
    expect(c.resolve<{ id: number }>('svc').id).not.toBe(c.resolve<{ id: number }>('svc').id)
  })
  it('singleton returns same instance', () => {
    const c = new Container()
    let n = 0
    c.register('svc', () => ({ id: ++n }), 'singleton')
    expect(c.resolve<{ id: number }>('svc')).toBe(c.resolve<{ id: number }>('svc'))
  })
  it('resolves nested deps', () => {
    const c = new Container()
    c.register('config', () => ({ host: 'localhost' }))
    c.register('db', (ct) => ({ host: ct.resolve<{ host: string }>('config').host }))
    expect(c.resolve<{ host: string }>('db').host).toBe('localhost')
  })
  it('throws on unregistered', () => {
    const c = new Container()
    expect(() => c.resolve('missing')).toThrow()
  })
  it('createScope inherits parent', () => {
    const c = new Container()
    c.register('base', () => 'parent', 'singleton')
    expect(c.createScope().resolve<string>('base')).toBe('parent')
  })
  it('scope overrides parent', () => {
    const c = new Container()
    c.register('svc', () => 'parent', 'singleton')
    const sc = c.createScope()
    sc.register('svc', () => 'child', 'singleton')
    expect(c.resolve<string>('svc')).toBe('parent')
    expect(sc.resolve<string>('svc')).toBe('child')
  })
  it('detects circular deps', () => {
    const c = new Container()
    c.register('a', (ct) => ct.resolve('b'))
    c.register('b', (ct) => ct.resolve('a'))
    expect(() => c.resolve('a')).toThrow()
  })
  it('dispose calls dispose on singletons', () => {
    const c = new Container()
    let disposed = false
    c.register('svc', () => ({ dispose: () => { disposed = true } }), 'singleton')
    c.resolve<{ dispose: () => void }>('svc')
    c.dispose()
    expect(disposed).toBe(true)
  })
})
`

const PARSER_TEST = `
import { describe, it, expect } from 'vitest'
import { string, regex, map, seq, choice, many, optional, between, parse } from './parser.ts'

describe('Parser combinators', () => {
  it('string matches literal', () => {
    expect(parse(string('hello'), 'hello')).toBe('hello')
  })
  it('regex matches pattern', () => {
    expect(parse(regex(/\\d+/), '12345')).toBe('12345')
  })
  it('map transforms result', () => {
    expect(parse(map(regex(/\\d+/), Number), '42')).toBe(42)
  })
  it('seq matches in order', () => {
    expect(parse(seq(string('a'), string('b'), string('c')), 'abc')).toEqual(['a', 'b', 'c'])
  })
  it('choice matches first success', () => {
    const p = choice(string('yes'), string('no'))
    expect(parse(p, 'no')).toBe('no')
    expect(parse(p, 'yes')).toBe('yes')
  })
  it('many matches zero or more', () => {
    expect(parse(many(string('a')), 'aaa')).toEqual(['a', 'a', 'a'])
    expect(parse(many(string('a')), '')).toEqual([])
  })
  it('optional matches zero or one', () => {
    const p = seq(optional(string('hi')), string('world'))
    expect(parse(p, 'hiworld')).toEqual(['hi', 'world'])
    expect(parse(p, 'world')).toEqual([null, 'world'])
  })
  it('between matches content', () => {
    expect(parse(between(string('('), regex(/[^)]+/), string(')')), '(hello)')).toBe('hello')
  })
  it('parse throws on incomplete', () => {
    expect(() => parse(string('hello'), 'hel')).toThrow()
  })
  it('parse throws on trailing input', () => {
    expect(() => parse(string('hello'), 'helloworld')).toThrow()
  })
  it('complex: JSON-like parse', () => {
    const ws = regex(/\\s*/)
    const val = choice(
      map(regex(/\\d+/), Number),
      map(between(string('"'), regex(/[^"]*/), string('"')), String),
    )
    const pair = seq(between(string('"'), regex(/[^"]*/), string('"')), ws, string(':'), ws, val)
    const obj = between(string('{'), pair, string('}'))
    expect(parse(obj, '{"age": 42}')[4]).toBe(42)
  })
})
`

const TX_MAP_TEST = `
import { describe, it, expect } from 'vitest'
import { TransactionalMap } from './txMap.ts'

describe('TransactionalMap', () => {
  it('stores and retrieves', () => {
    const m = new TransactionalMap()
    m.set('a', 1)
    expect(m.get('a')).toBe(1)
  })
  it('delete removes', () => {
    const m = new TransactionalMap()
    m.set('a', 1); m.delete('a')
    expect(m.get('a')).toBe(undefined)
  })
  it('transaction isolated until commit', () => {
    const m = new TransactionalMap()
    m.set('a', 1)
    const tx = m.begin()
    tx.set('a', 2); tx.set('b', 3)
    expect(m.get('a')).toBe(1)
    expect(m.get('b')).toBe(undefined)
    expect(tx.get('a')).toBe(2)
    expect(tx.get('b')).toBe(3)
  })
  it('commit applies changes', () => {
    const m = new TransactionalMap()
    m.set('a', 1)
    const tx = m.begin()
    tx.set('a', 2); tx.set('b', 3)
    m.commit(tx)
    expect(m.get('a')).toBe(2)
    expect(m.get('b')).toBe(3)
  })
  it('rollback discards', () => {
    const m = new TransactionalMap()
    m.set('a', 1)
    const tx = m.begin()
    tx.set('a', 99); tx.delete('a')
    m.rollback(tx)
    expect(m.get('a')).toBe(1)
  })
  it('nested transactions', () => {
    const m = new TransactionalMap()
    m.set('x', 1)
    const tx1 = m.begin()
    tx1.set('x', 2)
    const tx2 = tx1.begin()
    tx2.set('x', 3)
    expect(tx2.get('x')).toBe(3)
    expect(tx1.get('x')).toBe(2)
    expect(m.get('x')).toBe(1)
    m.commit(tx2)
    expect(tx1.get('x')).toBe(3)
    expect(m.get('x')).toBe(1)
    m.commit(tx1)
    expect(m.get('x')).toBe(3)
  })
  it('nested rollback does not affect parent', () => {
    const m = new TransactionalMap()
    m.set('x', 1)
    const tx1 = m.begin()
    tx1.set('x', 2)
    const tx2 = tx1.begin()
    tx2.set('x', 99)
    m.rollback(tx2)
    expect(tx1.get('x')).toBe(2)
    m.commit(tx1)
    expect(m.get('x')).toBe(2)
  })
  it('transaction delete isolated', () => {
    const m = new TransactionalMap()
    m.set('a', 1); m.set('b', 2)
    const tx = m.begin()
    tx.delete('a')
    expect(tx.get('a')).toBe(undefined)
    expect(tx.has('a')).toBe(false)
    expect(tx.has('b')).toBe(true)
    expect(m.get('a')).toBe(1)
    m.commit(tx)
    expect(m.get('a')).toBe(undefined)
  })
})
`

const SPSC_TEST = `
import { describe, it, expect } from 'vitest'
import { SpscQueue } from './spscQueue.ts'

describe('SpscQueue', () => {
  it('enqueues and dequeues in order', () => {
    const q = new SpscQueue<string>(4, 256)
    expect(q.enqueue('a')).toBe(true)
    expect(q.enqueue('b')).toBe(true)
    expect(q.dequeue()).toBe('a')
    expect(q.dequeue()).toBe('b')
  })
  it('returns null when empty', () => {
    const q = new SpscQueue<number>(2, 64)
    expect(q.dequeue()).toBe(null)
  })
  it('returns false when full', () => {
    const q = new SpscQueue<number>(2, 64)
    expect(q.enqueue(1)).toBe(true)
    expect(q.enqueue(2)).toBe(true)
    expect(q.enqueue(3)).toBe(false)
  })
  it('handles wraparound', () => {
    const q = new SpscQueue<number>(3, 64)
    q.enqueue(1); q.enqueue(2); q.enqueue(3)
    q.dequeue(); q.dequeue()
    expect(q.enqueue(4)).toBe(true)
    expect(q.enqueue(5)).toBe(true)
    expect(q.dequeue()).toBe(3)
    expect(q.dequeue()).toBe(4)
    expect(q.dequeue()).toBe(5)
  })
  it('handles mixed enqueue/dequeue', () => {
    const q = new SpscQueue<number>(4, 64)
    q.enqueue(1); q.enqueue(2)
    q.dequeue()
    q.enqueue(3); q.enqueue(4)
    q.dequeue(); q.dequeue()
    q.enqueue(5)
    expect(q.dequeue()).toBe(4)
    expect(q.dequeue()).toBe(5)
    expect(q.dequeue()).toBe(null)
  })
})
`

const DIFF_TEST = `
import { describe, it, expect } from 'vitest'
import { diff, type DiffResult } from './diff.ts'

describe('Myers diff', () => {
  it('identical arrays produce single equal', () => {
    expect(diff(['a','b','c'], ['a','b','c'])).toEqual([
      { type: 'equal', lines: ['a','b','c'] },
    ])
  })
  it('empty arrays produce empty result', () => {
    expect(diff([], [])).toEqual([])
  })
  it('pure insertion', () => {
    expect(diff([], ['a','b'])).toEqual([
      { type: 'insert', lines: ['a','b'] },
    ])
  })
  it('pure deletion', () => {
    expect(diff(['a','b'], [])).toEqual([
      { type: 'delete', lines: ['a','b'] },
    ])
  })
  it('mixed changes', () => {
    const result = diff(
      ['line1','line2','line3','line4','line5'],
      ['line1','line2-modified','line3','line4','line6'],
    )
    expect(result).toEqual([
      { type: 'equal', lines: ['line1'] },
      { type: 'delete', lines: ['line2'] },
      { type: 'insert', lines: ['line2-modified'] },
      { type: 'equal', lines: ['line3','line4'] },
      { type: 'delete', lines: ['line5'] },
      { type: 'insert', lines: ['line6'] },
    ])
  })
  it('produces minimal edits', () => {
    const result = diff(['a','b','c','d'], ['a','x','c','d'])
    expect(result).toEqual([
      { type: 'equal', lines: ['a'] },
      { type: 'delete', lines: ['b'] },
      { type: 'insert', lines: ['x'] },
      { type: 'equal', lines: ['c','d'] },
    ])
  })
  it('coalesces consecutive operations', () => {
    const result = diff(['a','b','c'], ['x','y','z'])
    expect(result).toEqual([
      { type: 'delete', lines: ['a','b','c'] },
      { type: 'insert', lines: ['x','y','z'] },
    ])
  })
  it('handles insert in middle', () => {
    const result = diff(['a','c'], ['a','b','c'])
    expect(result).toEqual([
      { type: 'equal', lines: ['a'] },
      { type: 'insert', lines: ['b'] },
      { type: 'equal', lines: ['c'] },
    ])
  })
})
`

const QUERY_PLANNER_TEST = `
import { describe, it, expect } from 'vitest'
import { planQuery, type Table, type JoinCondition, type Filter } from './queryPlanner.ts'

describe('QueryPlanner', () => {
  it('single table with filter', () => {
    const tables: Table[] = [{ name: 'users', rowCount: 1000 }]
    const filters: Filter[] = [{ table: 'users', column: 'active', selectivity: 0.1 }]
    const plan = planQuery(tables, [], filters)
    expect(plan.joins).toHaveLength(0)
    expect(plan.totalEstimatedRows).toBe(100)
  })
  it('two table join picks smaller intermediate', () => {
    const tables: Table[] = [
      { name: 'users', rowCount: 10000 },
      { name: 'orders', rowCount: 100 },
    ]
    const joins: JoinCondition[] = [{
      leftTable: 'users', leftColumn: 'id',
      rightTable: 'orders', rightColumn: 'user_id',
      selectivity: 0.001,
    }]
    const plan = planQuery(tables, joins, [])
    expect(plan.joins).toHaveLength(1)
    // orders(100) join users(10000) * 0.001 = 100
    // vs users(10000) join orders(100) * 0.001 = 100
    // Both same, but planner should pick one
    expect(plan.totalEstimatedRows).toBe(100)
  })
  it('three table join picks optimal order', () => {
    const tables: Table[] = [
      { name: 'small', rowCount: 10 },
      { name: 'medium', rowCount: 1000 },
      { name: 'large', rowCount: 100000 },
    ]
    const joins: JoinCondition[] = [
      { leftTable: 'small', leftColumn: 'id', rightTable: 'medium', rightColumn: 'small_id', selectivity: 0.01 },
      { leftTable: 'medium', leftColumn: 'id', rightTable: 'large', rightColumn: 'medium_id', selectivity: 0.001 },
    ]
    const plan = planQuery(tables, joins, [])
    expect(plan.joins).toHaveLength(2)
    // Optimal: small(10) join medium(1000) * 0.01 = 10, then 10 join large(100000) * 0.001 = 100
    // Suboptimal: medium(1000) join large(100000) * 0.001 = 1000, then 1000 join small(10) * 0.01 = 10
    // Both give 10 final rows, but intermediate differs: 10 vs 1000
    // Planner should pick the one with smaller intermediate
    expect(plan.totalEstimatedRows).toBeLessThanOrEqual(100)
  })
  it('filters reduce table sizes before join', () => {
    const tables: Table[] = [
      { name: 'a', rowCount: 10000 },
      { name: 'b', rowCount: 10000 },
    ]
    const joins: JoinCondition[] = [{
      leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'a_id', selectivity: 0.01,
    }]
    const filters: Filter[] = [{ table: 'a', column: 'x', selectivity: 0.01 }]
    const plan = planQuery(tables, joins, filters)
    // a filtered to 100, join b(10000) * 0.01 = 100
    expect(plan.totalEstimatedRows).toBe(100)
  })
  it('four table join finds optimal', () => {
    const tables: Table[] = [
      { name: 'a', rowCount: 100 },
      { name: 'b', rowCount: 1000 },
      { name: 'c', rowCount: 10000 },
      { name: 'd', rowCount: 100000 },
    ]
    const joins: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'a_id', selectivity: 0.1 },
      { leftTable: 'b', leftColumn: 'id', rightTable: 'c', rightColumn: 'b_id', selectivity: 0.01 },
      { leftTable: 'c', leftColumn: 'id', rightTable: 'd', rightColumn: 'c_id', selectivity: 0.001 },
    ]
    const plan = planQuery(tables, joins, [])
    expect(plan.joins).toHaveLength(3)
    // Should start with smallest tables
    expect(plan.totalEstimatedRows).toBeLessThan(1000)
  })
})
`

const RAFT_TEST = `
import { describe, it, expect } from 'vitest'
import { RaftNode, type LogEntry } from './raft.ts'

describe('RaftNode', () => {
  it('starts as follower with term 0', () => {
    const n = new RaftNode('n1', ['n2', 'n3'])
    expect(n.state).toBe('follower')
    expect(n.currentTerm).toBe(0)
    expect(n.votedFor).toBe(null)
    expect(n.commitIndex).toBe(-1)
  })
  it('startElection transitions to candidate and increments term', () => {
    const n = new RaftNode('n1', ['n2', 'n3'])
    n.startElection()
    expect(n.state).toBe('candidate')
    expect(n.currentTerm).toBe(1)
    expect(n.votedFor).toBe('n1')
  })
  it('candidate wins with majority votes', () => {
    const n = new RaftNode('n1', ['n2', 'n3'])
    n.startElection()
    n.receiveVote('n2', 1, true)
    expect(n.state).toBe('leader')
  })
  it('candidate does not win without majority', () => {
    const n = new RaftNode('n1', ['n2', 'n3', 'n4'])
    n.startElection()
    n.receiveVote('n2', 1, true)
    expect(n.state).toBe('candidate')
  })
  it('leader appends entries', () => {
    const n = new RaftNode('n1', ['n2', 'n3'])
    n.startElection()
    n.receiveVote('n2', 1, true)
    expect(n.appendEntry({ term: 1, command: 'set x=1', index: 0 })).toBe(true)
    expect(n.log).toHaveLength(1)
  })
  it('follower accepts AppendEntries from valid leader', () => {
    const n = new RaftNode('n1', ['n2', 'n3'])
    const ok = n.receiveAppendEntries(1, 'n2', -1, 0, [{ term: 1, command: 'set x=1', index: 0 }], -1)
    expect(ok).toBe(true)
    expect(n.log).toHaveLength(1)
  })
  it('follower rejects AppendEntries with stale term', () => {
    const n = new RaftNode('n1', ['n2', 'n3'])
    n.currentTerm = 5
    const ok = n.receiveAppendEntries(3, 'n2', -1, 0, [], -1)
    expect(ok).toBe(false)
  })
  it('follower rejects AppendEntries with mismatched prevLogIndex', () => {
    const n = new RaftNode('n1', ['n2', 'n3'])
    n.log = [{ term: 1, command: 'a', index: 0 }]
    const ok = n.receiveAppendEntries(2, 'n2', 0, 2, [{ term: 2, command: 'b', index: 1 }], -1)
    expect(ok).toBe(false)
  })
  it('conflicting entries are overwritten', () => {
    const n = new RaftNode('n1', ['n2', 'n3'])
    n.log = [{ term: 1, command: 'a', index: 0 }, { term: 1, command: 'b', index: 1 }]
    n.receiveAppendEntries(2, 'n2', 0, 1, [{ term: 2, command: 'c', index: 1 }], -1)
    expect(n.log).toHaveLength(2)
    expect(n.log[1].command).toBe('c')
    expect(n.log[1].term).toBe(2)
  })
  it('commitIndex advances on AppendEntries', () => {
    const n = new RaftNode('n1', ['n2', 'n3'])
    n.receiveAppendEntries(1, 'n2', -1, 0, [{ term: 1, command: 'a', index: 0 }], 0)
    expect(n.commitIndex).toBe(0)
  })
  it('commitEntries returns newly committed entries', () => {
    const n = new RaftNode('n1', ['n2', 'n3'])
    n.log = [{ term: 1, command: 'a', index: 0 }, { term: 1, command: 'b', index: 1 }]
    n.commitIndex = 0
    n.commitIndex = 1
    const committed = n.commitEntries()
    expect(committed).toHaveLength(1)
    expect(committed[0].command).toBe('b')
  })
  it('rejects vote for less up-to-date candidate', () => {
    const n = new RaftNode('n1', ['n2', 'n3'])
    n.log = [{ term: 1, command: 'a', index: 0 }, { term: 2, command: 'b', index: 1 }]
    n.currentTerm = 3
    // Candidate n2 has log term 1 at index 0 — less up-to-date
    // This should be handled by the vote logic
  })
})
`

const TYPE_INFERENCE_TEST = `
import { describe, it, expect } from 'vitest'
import { TypeInferencer, type Expr } from './typeInference.ts'

function numType() { return { kind: 'con' as const, name: 'Number', args: [] } }
function boolType() { return { kind: 'con' as const, name: 'Boolean', args: [] } }
function strType() { return { kind: 'con' as const, name: 'String', args: [] } }
function arrow(from: any, to: any) { return { kind: 'arrow' as const, from, to } }
function tvar(name: string) { return { kind: 'var' as const, name } }

describe('TypeInferencer', () => {
  it('infers number literal', () => {
    const inf = new TypeInferencer()
    const t = inf.infer({ kind: 'lit', value: 42 })
    expect(t).toEqual(numType())
  })
  it('infers boolean literal', () => {
    const inf = new TypeInferencer()
    const t = inf.infer({ kind: 'lit', value: true })
    expect(t).toEqual(boolType())
  })
  it('infers string literal', () => {
    const inf = new TypeInferencer()
    const t = inf.infer({ kind: 'lit', value: 'hello' })
    expect(t).toEqual(strType())
  })
  it('infers identity function type', () => {
    const inf = new TypeInferencer()
    const expr: Expr = { kind: 'lambda', param: 'x', body: { kind: 'var', name: 'x' } }
    const t = inf.infer(expr)
    expect(t.kind).toBe('arrow')
    if (t.kind === 'arrow') {
      expect(t.from.kind).toBe('var')
      expect(t.to.kind).toBe('var')
      if (t.from.kind === 'var' && t.to.kind === 'var') {
        expect(t.from.name).toBe(t.to.name)
      }
    }
  })
  it('infers application of identity to number', () => {
    const inf = new TypeInferencer()
    const expr: Expr = {
      kind: 'app',
      func: { kind: 'lambda', param: 'x', body: { kind: 'var', name: 'x' } },
      arg: { kind: 'lit', value: 42 },
    }
    const t = inf.infer(expr)
    expect(t).toEqual(numType())
  })
  it('infers constant function', () => {
    const inf = new TypeInferencer()
    const expr: Expr = {
      kind: 'lambda', param: 'x',
      body: { kind: 'lit', value: true },
    }
    const t = inf.infer(expr)
    expect(t).toEqual(arrow(tvar('t0'), boolType()))
  })
  it('infers composed functions', () => {
    const inf = new TypeInferencer()
    // (\\x -> \\y -> x) applied to 42
    const expr: Expr = {
      kind: 'app',
      func: {
        kind: 'lambda', param: 'x',
        body: { kind: 'lambda', param: 'y', body: { kind: 'var', name: 'x' } },
      },
      arg: { kind: 'lit', value: 42 },
    }
    const t = inf.infer(expr)
    expect(t.kind).toBe('arrow')
    if (t.kind === 'arrow') {
      expect(t.to).toEqual(numType())
    }
  })
  it('throws on type mismatch', () => {
    const inf = new TypeInferencer()
    // (\\x -> x) applied to 42 applied to true — 42 is not a function
    const expr: Expr = {
      kind: 'app',
      func: {
        kind: 'app',
        func: { kind: 'lambda', param: 'x', body: { kind: 'var', name: 'x' } },
        arg: { kind: 'lit', value: 42 },
      },
      arg: { kind: 'lit', value: true },
    }
    expect(() => inf.infer(expr)).toThrow()
  })
  it('infers polymorphic apply', () => {
    const inf = new TypeInferencer()
    // \\f -> \\x -> f(x)
    const expr: Expr = {
      kind: 'lambda', param: 'f',
      body: {
        kind: 'lambda', param: 'x',
        body: { kind: 'app', func: { kind: 'var', name: 'f' }, arg: { kind: 'var', name: 'x' } },
      },
    }
    const t = inf.infer(expr)
    expect(t.kind).toBe('arrow')
    if (t.kind === 'arrow') {
      expect(t.from.kind).toBe('arrow')
      expect(t.to.kind).toBe('var')
    }
  })
})
`

// ---------------------------------------------------------------------------
// Execution helpers
// ---------------------------------------------------------------------------

interface ExtractedEvents {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  output: string
  toolCalls: number
  toolFailures: number
}

function extractEvents(events: SessionEvent[]): ExtractedEvents {
  let inputTokens = 0
  let outputTokens = 0
  let reasoningTokens = 0
  let totalTokens = 0
  let output = ''
  let toolCalls = 0
  let toolFailures = 0

  for (const event of events) {
    if (event.type === 'model/usage') {
      const usage = event.data.usage
      inputTokens += usage.inputTokens
      outputTokens += usage.outputTokens
      reasoningTokens += usage.reasoningTokens ?? 0
      totalTokens += usage.totalTokens ?? 0
    } else if (event.type === 'assistant/message') {
      const message = event.data as { message: { content: Array<{ type: string; text?: string }> } }
      const text = message.message.content
        .filter(block => block.type === 'text')
        .map(block => block.text ?? '')
        .join('')
      if (text !== '') output = text
    } else if (event.type === 'tool/call') {
      toolCalls++
    } else if (event.type === 'tool/result') {
      const result = event.data as { message: { content: Array<{ isError?: boolean }> } }
      if (result.message.content.some(block => block.isError === true)) toolFailures++
    }
  }

  return { inputTokens, outputTokens, reasoningTokens, totalTokens, output, toolCalls, toolFailures }
}

async function generateConfig(model: string, workDir: string, workspace: string): Promise<string> {
  const basePath = join(REPO_ROOT, 'examples', 'headless-agent', 'cordis.yml')
  let base = await readFile(basePath, 'utf8')
  base = base.replace(/model: deepseek-v4-flash/, `model: ${model}`)
  base = base.replace(
    /compression: !!js "process.env.DSH_SNAPSHOT === undefined \? 'zstd' : 'none'"/,
    "compression: 'none'",
  )
  // Point the agent's working directory at the fixture workspace, not process.cwd()
  base = base.replace(/cwd: !!js process\.cwd\(\)/g, `cwd: '${workspace}'`)
  const configPath = join(workDir, 'cordis.yml')
  await writeFile(configPath, base, 'utf8')
  return configPath
}

interface RunResult {
  output: string
  costUsd: number
  latencyMs: number
  usage: ExtractedEvents
  routingDecisionId: string
}

async function runAgentTurn(
  task: string,
  model: string,
  workspace: string,
): Promise<RunResult> {
  const configPath = await generateConfig(model, workspace, workspace)
  const events: SessionEvent[] = []
  let uninstallFailLoud: (() => void) | undefined
  let ctx: Context | undefined

  try {
    await mkdir(join(workspace, 'sessions'), { recursive: true })
    loadEnv('v0174-repair-experiment')
    uninstallFailLoud = installFailLoud('v0174-repair-experiment')
    ctx = await boot('v0174-repair-experiment', resolveConfigPath(configPath, undefined))
    const started = Date.now()
    const turnResult = await runFixtureTurn(ctx, { task, onEvent: (_sessionId, event) => events.push(event) })
    const latencyMs = Date.now() - started
    const extracted = extractEvents(events)
    // Prefer the return value from runFixtureTurn for output and usage,
    // fall back to event extraction if the return value is empty.
    const output = turnResult.output !== '' ? turnResult.output : extracted.output
    const inputTokens = turnResult.usage?.inputTokens ?? extracted.inputTokens
    const outputTokens = turnResult.usage?.outputTokens ?? extracted.outputTokens
    const reasoningTokens = turnResult.usage?.reasoningTokens ?? extracted.reasoningTokens
    const totalTokens = turnResult.usage?.totalTokens ?? extracted.totalTokens
    if (output === '' && totalTokens === 0) {
      throw new Error('Provider returned no assistant output or usage')
    }
    const pricing = lookupPricingAt(DEFAULT_PRICING_REGISTRY, 'deepseek-official', model, new Date(started))
    const costUsd = pricing === undefined
      ? 0
      : calculateCost({
        inputTokens,
        outputTokens,
        cacheReadTokens: 0,
        cacheMissTokens: inputTokens,
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
      usage: {
        inputTokens,
        outputTokens,
        reasoningTokens,
        totalTokens,
        output,
        toolCalls: extracted.toolCalls,
        toolFailures: extracted.toolFailures,
      },
      routingDecisionId,
    }
  } finally {
    if (uninstallFailLoud !== undefined) uninstallFailLoud()
    if (ctx !== undefined) await ctx.fiber.dispose()
  }
}

/** Detect which files the agent changed in the workspace. */
async function detectChangedFiles(workspace: string, initialFiles: Set<string>): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  const changed: string[] = []
  async function scan(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.sessions' || entry.name === 'cordis.yml') continue
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        await scan(join(dir, entry.name), relativePath)
      } else if (!initialFiles.has(relativePath)) {
        changed.push(relativePath)
      }
    }
  }
  await scan(workspace, '')
  return changed.sort()
}

/** Snapshot the initial workspace files for change detection. */
async function snapshotWorkspace(workspace: string): Promise<Set<string>> {
  const { readdir } = await import('node:fs/promises')
  const files = new Set<string>()
  async function scan(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.sessions' || entry.name === 'cordis.yml') continue
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        await scan(join(dir, entry.name), relativePath)
      } else {
        files.add(relativePath)
      }
    }
  }
  await scan(workspace, '')
  return files
}

// ---------------------------------------------------------------------------
// Policy execution
// ---------------------------------------------------------------------------

interface PolicyExecutionResult {
  trajectory: TaskTrajectory
  failurePackage?: FailurePackage
}

async function executePolicy(
  policy: PolicyName,
  fixture: CodingTaskFixture,
  workRoot: string,
): Promise<PolicyExecutionResult> {
  const taskId = fixture.id
  const stages: StageAttempt[] = []
  let failurePackage: FailurePackage | undefined
  let escalated = false

  // Helper to create a fresh workspace for one task
  async function createWorkspace(suffix: string): Promise<{ workspace: string; initialFiles: Set<string> }> {
    const workspace = join(workRoot, `${taskId}-${suffix}`)
    await mkdir(workspace, { recursive: true })
    await fixture.setup(workspace)
    const initialFiles = await snapshotWorkspace(workspace)
    return { workspace, initialFiles }
  }

  // Helper to run one stage and record it
  async function runStage(
    model: 'flash' | 'pro',
    task: string,
    workspace: string,
    initialFiles: Set<string>,
    priorEvidence?: VerificationEvidence,
  ): Promise<StageAttempt & { output: string; verification: WorkspaceVerificationResult }> {
    const modelId = model === 'flash' ? MODELS.flash : MODELS.pro
    const result = await runAgentTurn(task, modelId, workspace)
    const verification = await fixture.verify(workspace)
    const changedFiles = await detectChangedFiles(workspace, initialFiles)
    const stage: StageAttempt = {
      model,
      routingDecisionId: result.routingDecisionId,
      verified: verification.passed,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
      changedFiles,
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        reasoningTokens: result.usage.reasoningTokens,
        totalTokens: result.usage.totalTokens,
      },
      ...!verification.passed ? {
        failureFingerprint: requireFingerprint(verification.evidence),
        verificationEvidence: verification.evidence,
      } : {},
    }
    // Construct failure package on first Flash failure for repair policies
    if (!verification.passed && failurePackage === undefined && model === 'flash') {
      failurePackage = constructFailurePackage({
        taskId,
        routingDecisionId: result.routingDecisionId,
        originalGoal: fixture.task,
        model: modelId,
        changedFiles,
        verification: verification.evidence,
        ...priorEvidence !== undefined ? { priorEvidence } : {},
        checkpoints: {
          taskStart: `${taskId}-start`,
          afterFlash: `${taskId}-after-flash`,
        },
      })
    }
    return { ...stage, output: result.output, verification }
  }

  if (policy === 'flash-only') {
    const { workspace, initialFiles } = await createWorkspace('flash-only')
    const stage = await runStage('flash', fixture.task, workspace, initialFiles)
    stages.push(stage)
  } else if (policy === 'pro-only') {
    const { workspace, initialFiles } = await createWorkspace('pro-only')
    const stage = await runStage('pro', fixture.task, workspace, initialFiles)
    stages.push(stage)
  } else if (policy === 'flash-fail-pro-fresh') {
    // Policy C: Flash fail → rollback to task-start → Pro fresh start (no evidence)
    // Pro gets the same original task, same model, same settings — only difference
    // from Policy D is: clean workspace and no FailurePackage.
    const { workspace: flashWs, initialFiles: flashInitial } = await createWorkspace('flash')
    const flashStage = await runStage('flash', fixture.task, flashWs, flashInitial)
    stages.push(flashStage)
    if (!flashStage.verified) {
      escalated = true
      // Fresh workspace: rollback to task-start state
      const { workspace: proWs, initialFiles: proInitial } = await createWorkspace('pro-fresh')
      // Pro gets only the original task — no failure evidence
      const proStage = await runStage('pro', fixture.task, proWs, proInitial)
      stages.push(proStage)
    }
  } else if (policy === 'flash-fail-pro-repair') {
    // Policy D: Flash fail → preserve Flash workspace → Pro repair with FailurePackage
    // Pro gets the same original task, same model, same settings — only difference
    // from Policy C is: Flash's changed workspace state and the FailurePackage.
    const { workspace: flashWs, initialFiles: flashInitial } = await createWorkspace('flash')
    const flashStage = await runStage('flash', fixture.task, flashWs, flashInitial)
    stages.push(flashStage)
    if (!flashStage.verified) {
      escalated = true
      if (failurePackage === undefined) throw new Error(`Missing failure package for ${taskId}`)
      // Pro receives the FailurePackage and chooses REPAIR_EXISTING or ROLLBACK_AND_REDO
      const repairPrompt = constructProRepairPrompt(failurePackage)
      // Pro runs in the Flash workspace (it can choose to wipe files if it decides ROLLBACK)
      const proStage = await runStage('pro', repairPrompt, flashWs, flashInitial, flashStage.verificationEvidence)
      const decision = parseTakeoverDecision(proStage.output)
      // Detect whether Pro actually rolled back: compare files after Pro to initial state
      const proChangedFiles = await detectChangedFiles(flashWs, flashInitial)
      const rollbackOccurred = decision === 'ROLLBACK_AND_REDO'
        || (proChangedFiles.length > 0
          && proChangedFiles.every(file => flashStage.changedFiles?.includes(file) === false))
      stages.push({
        ...proStage,
        ...decision !== undefined ? { takeoverDecision: decision } : {},
        rollbackOccurred,
        changedFiles: proChangedFiles,
      })
    }
  } else if (policy === 'flash-repair-then-pro') {
    // Production policy: evidence-conditioned Flash repair with progress-aware
    // escalation. Up to 3 Flash calls, then Pro. If Flash repeats the same
    // failure with no progress, escalate to Pro immediately rather than
    // wasting another cheap call.
    const { workspace: flashWs, initialFiles: flashInitial } = await createWorkspace('flash')
    // Flash #1: normal attempt
    const flashStage = await runStage('flash', fixture.task, flashWs, flashInitial)
    stages.push(flashStage)
    if (!flashStage.verified) {
      if (failurePackage === undefined) throw new Error(`Missing failure package for ${taskId}`)
      // Flash #2: repair using failure evidence from #1
      const repair1Prompt = constructFlashRepairPrompt(failurePackage)
      const flashRepair1Stage = await runStage('flash', repair1Prompt, flashWs, flashInitial, flashStage.verificationEvidence)
      stages.push(flashRepair1Stage)
      if (!flashRepair1Stage.verified) {
        const sameFailure = flashRepair1Stage.failureFingerprint !== undefined
          && flashStage.failureFingerprint !== undefined
          && isSameFailure(flashStage.failureFingerprint, flashRepair1Stage.failureFingerprint)
        const progress = flashStage.verificationEvidence !== undefined && flashRepair1Stage.verificationEvidence !== undefined
          ? classifyProgress(flashStage.verificationEvidence, flashRepair1Stage.verificationEvidence)
          : 'none' as const
        if (sameFailure || progress === 'none') {
          // No progress — escalate to Pro immediately
          escalated = true
          const proPrompt = constructProRepairPrompt(failurePackage)
          const proStage = await runStage('pro', proPrompt, flashWs, flashInitial, flashRepair1Stage.verificationEvidence)
          const decision = parseTakeoverDecision(proStage.output)
          const proChangedFiles = await detectChangedFiles(flashWs, flashInitial)
          const rollbackOccurred = decision === 'ROLLBACK_AND_REDO'
          stages.push({
            ...proStage,
            ...decision !== undefined ? { takeoverDecision: decision } : {},
            rollbackOccurred,
            changedFiles: proChangedFiles,
          })
        } else {
          // Progress was made — allow one final Flash repair (#3)
          const repair2Evidence = flashRepair1Stage.verificationEvidence
            ?? { failedCriteria: [], failingTests: [], typeErrors: [], buildErrors: [] }
          const repair2FailurePackage = constructFailurePackage({
            taskId,
            routingDecisionId: flashRepair1Stage.routingDecisionId,
            originalGoal: fixture.task,
            model: MODELS.flash,
            changedFiles: flashRepair1Stage.changedFiles ?? [],
            verification: repair2Evidence,
            priorEvidence: repair2Evidence,
            checkpoints: {
              taskStart: `${taskId}-start`,
              afterFlash: `${taskId}-after-flash-2`,
            },
          })
          const repair2Prompt = constructFlashRepairPrompt(repair2FailurePackage)
          const flashRepair2Stage = await runStage('flash', repair2Prompt, flashWs, flashInitial, flashRepair1Stage.verificationEvidence)
          stages.push(flashRepair2Stage)
          if (!flashRepair2Stage.verified) {
            // Flash #3 failed — escalate to Pro with all accumulated evidence
            escalated = true
            const proPrompt = constructProRepairPrompt(repair2FailurePackage)
            const proStage = await runStage('pro', proPrompt, flashWs, flashInitial, flashRepair2Stage.verificationEvidence)
            const decision = parseTakeoverDecision(proStage.output)
            const proChangedFiles = await detectChangedFiles(flashWs, flashInitial)
            const rollbackOccurred = decision === 'ROLLBACK_AND_REDO'
            stages.push({
              ...proStage,
              ...decision !== undefined ? { takeoverDecision: decision } : {},
              rollbackOccurred,
              changedFiles: proChangedFiles,
            })
          }
        }
      }
    }
  } else if (policy === 'flash-fail-pro-workspace-only') {
    // Ablation D1: Pro gets Flash's failed workspace but no structured FailurePackage.
    // Isolates the workspace benefit (partial implementation) from evidence benefit.
    const { workspace: flashWs, initialFiles: flashInitial } = await createWorkspace('flash')
    const flashStage = await runStage('flash', fixture.task, flashWs, flashInitial)
    stages.push(flashStage)
    if (!flashStage.verified) {
      escalated = true
      // Pro gets the workspace but no failure evidence — must inspect and verify itself
      const workspacePrompt = constructWorkspaceOnlyPrompt(fixture.task)
      const proStage = await runStage('pro', workspacePrompt, flashWs, flashInitial, flashStage.verificationEvidence)
      const decision = parseTakeoverDecision(proStage.output)
      const proChangedFiles = await detectChangedFiles(flashWs, flashInitial)
      const rollbackOccurred = decision === 'ROLLBACK_AND_REDO'
      stages.push({
        ...proStage,
        ...decision !== undefined ? { takeoverDecision: decision } : {},
        rollbackOccurred,
        changedFiles: proChangedFiles,
      })
    }
  } else if (policy === 'flash-fail-pro-evidence-only') {
    // Ablation D2: Pro gets a clean workspace (no Flash code) but receives the
    // full FailurePackage as text. Isolates the evidence benefit from workspace benefit.
    const { workspace: flashWs, initialFiles: flashInitial } = await createWorkspace('flash')
    const flashStage = await runStage('flash', fixture.task, flashWs, flashInitial)
    stages.push(flashStage)
    if (!flashStage.verified) {
      escalated = true
      if (failurePackage === undefined) throw new Error(`Missing failure package for ${taskId}`)
      // Clean workspace: Flash's code is gone, but Pro gets the failure evidence
      const { workspace: proWs, initialFiles: proInitial } = await createWorkspace('pro-evidence-only')
      const evidencePrompt = constructEvidenceOnlyPrompt(failurePackage)
      const proStage = await runStage('pro', evidencePrompt, proWs, proInitial, flashStage.verificationEvidence)
      const decision = parseTakeoverDecision(proStage.output)
      stages.push({ ...proStage, ...decision !== undefined ? { takeoverDecision: decision } : {}, rollbackOccurred: false })
    }
  }

  const lastStage = stages.at(-1)
  const verified = lastStage !== undefined && lastStage.verified
  return {
    trajectory: {
      taskId,
      policy,
      verified,
      stages,
      escalated,
      ...failurePackage !== undefined ? { failurePackage } : {},
    },
    ...failurePackage !== undefined ? { failurePackage } : {},
  }
}

/** Compute fingerprint for a failed stage's verification evidence. */
function requireFingerprint(evidence: VerificationEvidence): string {
  return computeFailureFingerprint(evidence)
}

// ---------------------------------------------------------------------------
// Checkpoint management
// ---------------------------------------------------------------------------

interface Checkpoint {
  release: string
  startedAt: string
  updatedAt: string
  trajectories: Array<{ policy: PolicyName; taskId: string; trajectory: TaskTrajectory }>
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
  await writeFile(CHECKPOINT_PATH, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8')
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function metricsRow(metrics: PolicyMetrics): string {
  return `| ${metrics.policy} | ${(metrics.verifiedRate * 100).toFixed(1)}% | $${metrics.costPerVerifiedTask.toFixed(6)} | $${metrics.totalCost.toFixed(6)} | ${(metrics.escalationRate * 100).toFixed(1)}% | ${(metrics.proUtilization * 100).toFixed(1)}% | ${(metrics.proRescueRate * 100).toFixed(1)}% | $${metrics.escalationCostEfficiency.toFixed(6)} | ${metrics.auditableEscalations}/${metrics.escalations} | ${metrics.sameFailureDetections} | ${metrics.flashLimitReached} | ${metrics.loopViolations} | ${metrics.repairExistingChoices} | ${metrics.rollbackRedoChoices} | ${(metrics.rollbackRate * 100).toFixed(1)}% | ${metrics.medianLatencyMs.toFixed(0)}ms | ${metrics.p90LatencyMs.toFixed(0)}ms |`
}

async function generateReport(
  allMetrics: Partial<Record<PolicyName, PolicyMetrics>>,
  _trajectories: Record<PolicyName, TaskTrajectory[]>,
): Promise<void> {
  const flashOnlyMetrics = allMetrics['flash-only']
  const proOnlyMetrics = allMetrics['pro-only']
  const productionMetrics = allMetrics['flash-repair-then-pro']

  const output = {
    release: 'v0.17.4',
    experimentType: 'production-policy-flash-repair-then-pro',
    fixtureCount: FIXTURES.length,
    fixtures: FIXTURES.map(fixture => ({
      id: fixture.id,
      category: fixture.category,
      description: fixture.description,
      expectsFlashFailure: fixture.expectsFlashFailure,
    })),
    policies: {
      'flash-only': 'Flash only; verify; done (cheapest baseline)',
      'pro-only': 'Pro only; verify; done (maximum-cost baseline)',
      'flash-repair-then-pro': 'Flash #1; if fail, Flash repair #2 with evidence; if no progress, Pro; if progress, Flash #3; if fail, Pro with all evidence',
    },
    metrics: allMetrics,
    productionAdvantage: {
      verifiedSuccessAdvantage: productionMetrics !== undefined && proOnlyMetrics !== undefined
        ? productionMetrics.verifiedRate - proOnlyMetrics.verifiedRate : undefined,
      economicAdvantage: productionMetrics !== undefined && proOnlyMetrics !== undefined
        ? proOnlyMetrics.costPerVerifiedTask - productionMetrics.costPerVerifiedTask : undefined,
      costVsFlash: productionMetrics !== undefined && flashOnlyMetrics !== undefined
        ? flashOnlyMetrics.totalCost - productionMetrics.totalCost : undefined,
      proUtilization: productionMetrics?.proUtilization,
    },
    nonAuthoritative: true,
    promotionGate: {
      verifiedSuccessWithinRange: 'Production policy within ~1-2 percentage points of Pro-only, or better',
      costReduction: 'Lower cost per verified task than Pro-only',
      proUtilization: 'Below ~20-25%',
      sameFailureDetection: 'Prevents useless retries via fingerprint comparison',
      noInfiniteLoops: 'Max 3 Flash + 1-2 Pro calls per task',
      auditableEvidence: 'Every escalation has auditable failure evidence',
      independentVerification: 'Every final result receives independent verification',
    },
  }
  await writeFile(JSON_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8')

  const lines = [
    '# v0.17.4 Production Policy: Flash Repair → Pro Escalation',
    '',
    'Experiment type: production policy with progress-aware escalation.',
    '',
    '## Policy',
    '',
    '```',
    'Flash #1 → verify → PASS → DONE',
    '                FAIL → Flash #2 (repair with evidence) → verify → PASS → DONE',
    '                                              FAIL → same failure? → Pro immediately',
    '                                                  → progress? → Flash #3 → verify → PASS → DONE',
    '                                                                              FAIL → Pro',
    '```',
    '',
    'Hard limits: max 3 Flash calls, max 1-2 Pro calls, identical-failure immediate escalation.',
    '',
    '## Policies',
    '',
    '| Policy | Description |',
    '|---|---|',
    '| flash-only | Flash only; verify; done (cheapest baseline) |',
    '| pro-only | Pro only; verify; done (maximum-cost baseline) |',
    '| flash-repair-then-pro | Flash #1 → Flash repair #2 → progress check → Flash #3 or Pro → Pro with evidence |',
    '',
    '## Results',
    '',
    '| Policy | Verified | Cost/verified | Total cost | Escalation | Pro util | Pro rescue rate | Escalation cost/rescue | Auditable | Same-fail detect | Flash limit reached | Loop violations | REPAIR choices | ROLLBACK choices | Rollback rate | Median latency | p90 latency |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...(Object.values(allMetrics).map(metricsRow)),
    '',
    '## Key metrics',
    '',
    '- **Pro Rescue Rate** = failed Flash tasks subsequently verified by Pro / tasks escalated to Pro',
    '- **Escalation Cost Efficiency** = total escalation cost / successful Pro rescues',
    '- **Auditable** = escalations with a constructed FailurePackage / total escalations',
    '- **Same-failure detection** = tasks where repeated Flash failures shared the same fingerprint or high semantic overlap',
    '- **Flash limit reached** = tasks that used all permitted Flash stages without exceeding the limit (valid behavior)',
    '- **Loop violations** = tasks exceeding bounded stage limits (actual policy violation, must be 0)',
    '- **Rollback rate** = Pro stages where Pro actually rolled back Flash\'s files / escalations',
    '',
    '## Production policy advantage',
    '',
    '| Metric | Value |',
    '|---|---:|',
    ...(productionMetrics !== undefined && proOnlyMetrics !== undefined
      ? [`| Verified success vs Pro-only | ${((productionMetrics.verifiedRate - proOnlyMetrics.verifiedRate) * 100).toFixed(1)}% |`]
      : ['| Verified success vs Pro-only | (pro-only not available) |']),
    ...(productionMetrics !== undefined && proOnlyMetrics !== undefined
      ? [`| Cost per verified vs Pro-only | $${(proOnlyMetrics.costPerVerifiedTask - productionMetrics.costPerVerifiedTask).toFixed(6)} |`]
      : ['| Cost per verified vs Pro-only | (pro-only not available) |']),
    ...(productionMetrics !== undefined && proOnlyMetrics !== undefined
      ? [`| Total cost vs Pro-only | $${(proOnlyMetrics.totalCost - productionMetrics.totalCost).toFixed(6)} |`]
      : ['| Total cost vs Pro-only | (pro-only not available) |']),
    ...(productionMetrics !== undefined && flashOnlyMetrics !== undefined
      ? [`| Total cost vs Flash-only | $${(productionMetrics.totalCost - flashOnlyMetrics.totalCost).toFixed(6)} |`]
      : ['| Total cost vs Flash-only | (flash-only not available) |']),
    ...(productionMetrics !== undefined
      ? [`| Pro utilization | ${(productionMetrics.proUtilization * 100).toFixed(1)}% |`]
      : ['| Pro utilization | (not available) |']),
    '',
    'Positive values mean the production policy outperforms Pro-only. The cost vs Flash-only shows the overhead of escalation.',
    '',
    '## Non-authoritative status',
    '',
    'v0.17.4 is a research experiment. It does not change runtime routing authority. The deterministic ordering remains: manual selection → durable authority → hard policy constraints → context/provider availability → authoritative heuristic router.',
    '',
    'Promotion to v0.18 requires: production policy verified success within ~1-2 percentage points of Pro-only or better, lower cost per verified task than Pro-only, Pro utilization below ~20-25%, same-failure detection preventing useless retries, no infinite loops, every escalation having auditable failure evidence, and every final result receiving independent verification.',
  ]
  await writeFile(REPORT_PATH, `${lines.join('\n')}\n`, 'utf8')
  process.stdout.write(`Wrote ${JSON_PATH} and ${REPORT_PATH}\n`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (process.env.DEEPSEEK_API_KEY === undefined || process.env.DEEPSEEK_API_KEY === '') {
    process.stderr.write('DEEPSEEK_API_KEY is not set; skipping live v0.17.4 repair experiment.\n')
    process.stderr.write('The keyless core logic is validated by scripts/v0174-repair-core.spec.ts.\n')
    process.stderr.write('Provide a rotated key to run the live experiment.\n')
    return
  }

  const workRoot = await mkdtemp(join(tmpdir(), 'v0174-repair-'))
  const policies: readonly PolicyName[] = ['flash-only', 'pro-only', 'flash-repair-then-pro']
  const allPolicyNames: readonly PolicyName[] = ['flash-only', 'pro-only', 'flash-repair-then-pro']
  const checkpoint = await loadCheckpoint()
  const completedTasks = new Set(checkpoint?.trajectories.map(entry => `${entry.policy}/${entry.taskId}`) ?? [])
  const allTrajectories = {} as Record<PolicyName, TaskTrajectory[]>
  for (const policy of allPolicyNames) {
    allTrajectories[policy] = []
  }

  // Restore checkpoint (all policies, not just the ones being run)
  if (checkpoint !== undefined) {
    for (const entry of checkpoint.trajectories) {
      allTrajectories[entry.policy].push(entry.trajectory)
    }
  }

  try {
    for (const policy of policies) {
      for (const fixture of FIXTURES) {
        const taskKey = `${policy}/${fixture.id}`
        if (completedTasks.has(taskKey)) {
          process.stderr.write(`Skipping completed: ${taskKey}\n`)
          continue
        }
        process.stderr.write(`Running: ${taskKey}\n`)
        try {
          const result = await executePolicy(policy, fixture, workRoot)
          allTrajectories[policy].push(result.trajectory)
          completedTasks.add(taskKey)
          // Checkpoint after each task
          const updatedCheckpoint: Checkpoint = {
            release: 'v0.17.4',
            startedAt: checkpoint?.startedAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            trajectories: allPolicyNames.flatMap(p =>
              allTrajectories[p].map(t => ({ policy: p, taskId: t.taskId, trajectory: t })),
            ),
          }
          await saveCheckpoint(updatedCheckpoint)
        } catch (error) {
          process.stderr.write(`Error in ${taskKey}: ${String(error)}\n`)
        }
      }
    }

    // Compute metrics for all policies (including restored ones)
    const allMetrics = {} as Record<PolicyName, PolicyMetrics>
    for (const policy of allPolicyNames) {
      if (allTrajectories[policy].length > 0) {
        allMetrics[policy] = computePolicyMetrics(policy, allTrajectories[policy])
      }
    }

    await generateReport(allMetrics, allTrajectories)

    // Clean up checkpoint after successful completion
    try { await rm(CHECKPOINT_PATH, { force: true }) } catch { /* checkpoint may not exist */ }
  } finally {
    await rm(workRoot, { recursive: true, force: true })
  }
}

void main()
