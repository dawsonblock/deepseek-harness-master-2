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
  ALL_POLICIES,
  computeFailureFingerprint,
  computePolicyMetrics,
  computeRepairAdvantage,
  constructEvidenceOnlyPrompt,
  constructFailurePackage,
  constructProRepairPrompt,
  constructWorkspaceOnlyPrompt,
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
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: workspace,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (data: Buffer) => { output += data.toString() })
    child.stderr.on('data', (data: Buffer) => { output += data.toString() })
    child.on('close', (code) => {
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
      const typecheck = await runInWorkspace(workspace, ['npx', 'tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['npx', 'vitest', 'run', '--reporter=verbose'])
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
      const typecheck = await runInWorkspace(workspace, ['npx', 'tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['npx', 'vitest', 'run', '--reporter=verbose'])
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
      const typecheck = await runInWorkspace(workspace, ['npx', 'tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['npx', 'vitest', 'run', '--reporter=verbose'])
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
      const typecheck = await runInWorkspace(workspace, ['npx', 'tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['npx', 'vitest', 'run', '--reporter=verbose'])
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
      const typecheck = await runInWorkspace(workspace, ['npx', 'tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['npx', 'vitest', 'run', '--reporter=verbose'])
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
      const typecheck = await runInWorkspace(workspace, ['npx', 'tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['npx', 'vitest', 'run', '--reporter=verbose'])
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
      const typecheck = await runInWorkspace(workspace, ['npx', 'tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['npx', 'vitest', 'run', '--reporter=verbose'])
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
      const typecheck = await runInWorkspace(workspace, ['npx', 'tsc', '--noEmit'])
      const typeErrors = parseTypeErrors(typecheck.output)
      const testRun = await runInWorkspace(workspace, ['npx', 'vitest', 'run', '--reporter=verbose'])
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
]

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
        || (proChangedFiles.length > 0 && proChangedFiles.every(file => flashStage.changedFiles?.includes(file) === false))
      stages.push({ ...proStage, takeoverDecision: decision, rollbackOccurred, changedFiles: proChangedFiles })
    }
  } else if (policy === 'flash-repair-then-pro') {
    // Policy E: Flash fail → one evidence-conditioned Flash repair → Pro takeover if still failing
    const { workspace: flashWs, initialFiles: flashInitial } = await createWorkspace('flash')
    const flashStage = await runStage('flash', fixture.task, flashWs, flashInitial)
    stages.push(flashStage)
    if (!flashStage.verified) {
      if (failurePackage === undefined) throw new Error(`Missing failure package for ${taskId}`)
      // One evidence-conditioned Flash repair
      const repairPrompt = constructProRepairPrompt(failurePackage)
        .replace('You are taking over a coding task that a junior engineer attempted but failed.',
          'You previously attempted this coding task but failed. Try again with the failure evidence.')
        .replace('REPAIR_EXISTING', 'REPAIR_EXISTING (fix the existing code)')
        .replace('ROLLBACK_AND_REDO', 'ROLLBACK_AND_REDO (start fresh)')
      const flashRepairStage = await runStage('flash', repairPrompt, flashWs, flashInitial, flashStage.verificationEvidence)
      stages.push(flashRepairStage)
      if (!flashRepairStage.verified) {
        escalated = true
        // Pro takeover with accumulated failure evidence
        const proPrompt = constructProRepairPrompt(failurePackage)
        const proStage = await runStage('pro', proPrompt, flashWs, flashInitial, flashRepairStage.verificationEvidence)
        const decision = parseTakeoverDecision(proStage.output)
        const proChangedFiles = await detectChangedFiles(flashWs, flashInitial)
        const rollbackOccurred = decision === 'ROLLBACK_AND_REDO'
        stages.push({ ...proStage, takeoverDecision: decision, rollbackOccurred, changedFiles: proChangedFiles })
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
      stages.push({ ...proStage, takeoverDecision: decision, rollbackOccurred, changedFiles: proChangedFiles })
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
      stages.push({ ...proStage, takeoverDecision: decision, rollbackOccurred: false })
    }
  }

  const verified = stages.length > 0 && stages[stages.length - 1].verified
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
  return `| ${metrics.policy} | ${(metrics.verifiedRate * 100).toFixed(1)}% | $${metrics.costPerVerifiedTask.toFixed(6)} | $${metrics.totalCost.toFixed(6)} | ${(metrics.escalationRate * 100).toFixed(1)}% | ${(metrics.proUtilization * 100).toFixed(1)}% | ${(metrics.proRescueRate * 100).toFixed(1)}% | $${metrics.escalationCostEfficiency.toFixed(6)} | ${metrics.auditableEscalations}/${metrics.escalations} | ${metrics.sameFailureDetections} | ${metrics.loopViolations} | ${metrics.repairExistingChoices} | ${metrics.rollbackRedoChoices} | ${(metrics.rollbackRate * 100).toFixed(1)}% | ${metrics.medianLatencyMs.toFixed(0)}ms | ${metrics.p90LatencyMs.toFixed(0)}ms |`
}

async function generateReport(
  allMetrics: Record<PolicyName, PolicyMetrics>,
  _trajectories: Record<PolicyName, TaskTrajectory[]>,
): Promise<void> {
  const repairMetrics = allMetrics['flash-fail-pro-repair']
  const freshMetrics = allMetrics['flash-fail-pro-fresh']
  const repairAdvantage = computeRepairAdvantage(repairMetrics, freshMetrics)
  const workspaceOnlyMetrics = allMetrics['flash-fail-pro-workspace-only']
  const evidenceOnlyMetrics = allMetrics['flash-fail-pro-evidence-only']

  const output = {
    release: 'v0.17.4',
    experimentType: 'real-flash-failure-pro-repair-trajectory',
    fixtureCount: FIXTURES.length,
    fixtures: FIXTURES.map(fixture => ({
      id: fixture.id,
      category: fixture.category,
      description: fixture.description,
      expectsFlashFailure: fixture.expectsFlashFailure,
    })),
    policies: {
      'flash-only': 'Flash only; verify; done',
      'pro-only': 'Pro only; verify; done',
      'flash-fail-pro-fresh': 'Flash; if fail, rollback to task-start; Pro fresh start (no evidence)',
      'flash-fail-pro-repair': 'Flash; if fail, preserve workspace; Pro receives FailurePackage and chooses REPAIR_EXISTING or ROLLBACK_AND_REDO',
      'flash-repair-then-pro': 'Flash; if fail, one evidence-conditioned Flash repair; if still fail, Pro takeover with evidence',
      'flash-fail-pro-workspace-only': 'Ablation D1: Flash; if fail, Pro gets workspace but no structured evidence',
      'flash-fail-pro-evidence-only': 'Ablation D2: Flash; if fail, Pro gets clean workspace + FailurePackage',
    },
    metrics: allMetrics,
    repairAdvantage,
    ablationComparison: {
      workspaceOnly: workspaceOnlyMetrics,
      evidenceOnly: evidenceOnlyMetrics,
      workspacePlusEvidence: repairMetrics,
    },
    nonAuthoritative: true,
    promotionGate: {
      verifiedSuccessWithinRange: 'Flash→Pro repair within ~1-2 percentage points of Pro-only, or better',
      costReduction: 'At least ~40% lower cost per verified task than Pro-only',
      proUtilization: 'Below ~20-25%',
      rescueEfficiency: 'High Pro rescue rate',
      sameFailureDetection: 'Prevents useless retries',
      noInfiniteLoops: 'No task can loop indefinitely',
      auditableEvidence: 'Every escalation has auditable failure evidence',
      independentVerification: 'Every final result receives independent verification',
      repairVsFreshNonInferior: 'Policy D verified success non-inferior to Policy C',
      repairVsFreshCheaper: 'Policy D cost per verified task lower than Policy C',
    },
  }
  await writeFile(JSON_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8')

  const lines = [
    '# v0.17.4 Real Flash-Failure → Pro-Repair Experiment',
    '',
    'Experiment type: real joined multi-stage repair trajectories (not counterfactual paired simulation).',
    '',
    '## Policies',
    '',
    '| Policy | Description |',
    '|---|---|',
    '| flash-only | Flash only; verify; done |',
    '| pro-only | Pro only; verify; done |',
    '| flash-fail-pro-fresh | Flash; if fail, rollback to task-start; Pro fresh start (no evidence) |',
    '| flash-fail-pro-repair | Flash; if fail, preserve workspace; Pro receives FailurePackage and chooses REPAIR_EXISTING or ROLLBACK_AND_REDO |',
    '| flash-repair-then-pro | Flash; if fail, one evidence-conditioned Flash repair; if still fail, Pro takeover with evidence |',
    '| flash-fail-pro-workspace-only | Ablation D1: Pro gets workspace but no structured evidence |',
    '| flash-fail-pro-evidence-only | Ablation D2: Pro gets clean workspace + FailurePackage |',
    '',
    '## Results',
    '',
    '| Policy | Verified | Cost/verified | Total cost | Escalation | Pro util | Pro rescue rate | Escalation cost/rescue | Auditable | Same-fail detect | Loop violations | REPAIR choices | ROLLBACK choices | Rollback rate | Median latency | p90 latency |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...(Object.values(allMetrics).map(metricsRow)),
    '',
    '## Key metrics',
    '',
    '- **Pro Rescue Rate** = failed Flash tasks subsequently verified by Pro / tasks escalated to Pro',
    '- **Escalation Cost Efficiency** = total escalation cost / successful Pro rescues',
    '- **Auditable** = escalations with a constructed FailurePackage / total escalations',
    '- **Same-failure detection** = tasks where repeated Flash failures shared the same fingerprint or high semantic overlap',
    '- **Loop violations** = tasks exceeding bounded stage limits (must be 0)',
    '- **Rollback rate** = Pro stages where Pro actually rolled back Flash\'s files / escalations',
    '',
    '## Repair Advantage: Policy D vs Policy C',
    '',
    '| Metric | Value |',
    '|---|---:|',
    `| Verified success advantage | ${(repairAdvantage.verifiedSuccessAdvantage * 100).toFixed(1)}% |`,
    `| Economic advantage (CPT fresh - CPT repair) | $${repairAdvantage.economicAdvantage.toFixed(6)} |`,
    `| Rescue rate advantage | ${(repairAdvantage.rescueRateAdvantage * 100).toFixed(1)}% |`,
    `| Comparable tasks (escalated under both) | ${repairAdvantage.comparableTasks} |`,
    '',
    'Positive values mean Policy D (Pro repair with evidence) outperforms Policy C (Pro fresh start).',
    '',
    '## Ablation: workspace benefit vs evidence benefit',
    '',
    '| Ablation | Workspace | Evidence | Verified | Cost/verified | Pro rescue rate |',
    '|---|---|---|---:|---:|---:|',
    `| D1: workspace only | yes | no | ${(workspaceOnlyMetrics.verifiedRate * 100).toFixed(1)}% | $${workspaceOnlyMetrics.costPerVerifiedTask.toFixed(6)} | ${(workspaceOnlyMetrics.proRescueRate * 100).toFixed(1)}% |`,
    `| D2: evidence only | no | yes | ${(evidenceOnlyMetrics.verifiedRate * 100).toFixed(1)}% | $${evidenceOnlyMetrics.costPerVerifiedTask.toFixed(6)} | ${(evidenceOnlyMetrics.proRescueRate * 100).toFixed(1)}% |`,
    `| D3: workspace + evidence | yes | yes | ${(repairMetrics.verifiedRate * 100).toFixed(1)}% | $${repairMetrics.costPerVerifiedTask.toFixed(6)} | ${(repairMetrics.proRescueRate * 100).toFixed(1)}% |`,
    '',
    'D1 isolates the workspace benefit (partial implementation). D2 isolates the evidence benefit (diagnostic information). D3 combines both. If D3 > D1 and D3 > D2, both benefits contribute.',
    '',
    '## Non-authoritative status',
    '',
    'v0.17.4 is a research experiment. It does not change runtime routing authority. The deterministic ordering remains: manual selection → durable authority → hard policy constraints → context/provider availability → authoritative heuristic router.',
    '',
    'Promotion to v0.18 requires: Flash→Pro repair within ~1-2 percentage points of Pro-only verified success or better, at least ~40% lower cost per verified task, Pro utilization below ~20-25%, high rescue efficiency, same-failure detection preventing useless retries, no infinite loops, every escalation having auditable failure evidence, every final result receiving independent verification, Policy D verified success non-inferior to Policy C, and Policy D cost per verified task lower than Policy C.',
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
  const policies = ALL_POLICIES
  const checkpoint = await loadCheckpoint()
  const completedTasks = new Set(checkpoint?.trajectories.map(entry => `${entry.policy}/${entry.taskId}`) ?? [])
  const allTrajectories = {} as Record<PolicyName, TaskTrajectory[]>
  for (const policy of policies) {
    allTrajectories[policy] = []
  }

  // Restore checkpoint
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
            trajectories: policies.flatMap(p =>
              allTrajectories[p].map(t => ({ policy: p, taskId: t.taskId, trajectory: t })),
            ),
          }
          await saveCheckpoint(updatedCheckpoint)
        } catch (error) {
          process.stderr.write(`Error in ${taskKey}: ${String(error)}\n`)
        }
      }
    }

    // Compute metrics for all policies
    const allMetrics = {} as Record<PolicyName, PolicyMetrics>
    for (const policy of policies) {
      allMetrics[policy] = computePolicyMetrics(policy, allTrajectories[policy])
    }

    await generateReport(allMetrics, allTrajectories)

    // Clean up checkpoint after successful completion
    try { await rm(CHECKPOINT_PATH, { force: true }) } catch { /* checkpoint may not exist */ }
  } finally {
    await rm(workRoot, { recursive: true, force: true })
  }
}

void main()
