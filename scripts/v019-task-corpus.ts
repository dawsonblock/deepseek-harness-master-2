/**
 * v0.19 task corpus for the synthetic multi-repository baseline evaluation.
 *
 * Initial cohort: 5 tasks across 5 small TypeScript repositories.
 * This is the infrastructure validation set. The full 75-task cohort
 * will be added after the infrastructure is validated.
 *
 * All tasks use the frozen v0.18.0 repair limits:
 *   maxFlashAttempts=3, maxProAttempts=2, maxTotalAttempts=5
 *
 * @module v019-task-corpus
 */

import {
  type TaskManifest,
  buildTaskManifest,
  FROZEN_V018_LIMITS,
} from './v019-task-manifest.ts'

const REPO_BASE = 'file:///tmp/v019-test-repos'

/** Initial 5-task infrastructure validation corpus. */
export const TASK_CORPUS: TaskManifest[] = [
  buildTaskManifest({
    taskId: 'ts-utils-bug-001',
    category: 'bug-fix',
    benchmarkEligible: false,
    repository: {
      name: 'ts-utils',
      url: `${REPO_BASE}/ts-utils`,
      baseCommit: 'ba73492e41267e4b1d5e1492e436d144e490a564',
      referenceFixCommit: 'ddb57342d96e98a2c18a1c69964fbae22189aa7d',
    },
    repoSize: 'small',
    task: {
      title: 'Fix sortNumbers to sort numerically instead of lexicographically',
      description: 'The `sortNumbers` function in `src/index.ts` uses the default `.sort()` method, which sorts elements as strings. This causes `sortNumbers([10, 2, 1])` to return `[1, 10, 2]` instead of `[1, 2, 10]`. Fix the function to sort numbers in ascending numeric order. The test file `tests/index.test.ts` already exists and must pass.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [
        { command: 'npm test', expectedExitCode: 0 },
      ],
      holdout: [],
      strength: 'V2',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),

  buildTaskManifest({
    taskId: 'ts-math-bug-001',
    category: 'bug-fix',
    benchmarkEligible: false,
    repository: {
      name: 'ts-math',
      url: `${REPO_BASE}/ts-math`,
      baseCommit: 'ac0f0a02abd5f519c9faac6f1f32be25cac021b3',
      referenceFixCommit: undefined,
    },
    repoSize: 'small',
    task: {
      title: 'Fix floating point rounding error in round function',
      description: 'The `round` function in `src/index.ts` has a floating point precision bug. `round(1.005, 2)` returns `1` instead of `1.01` because `Math.round(1.005 * 100)` evaluates to `100` due to floating point representation. Fix the function to handle this edge case correctly. The test file `tests/index.test.ts` already exists and must pass.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [
        { command: 'npm test', expectedExitCode: 0 },
      ],
      holdout: [],
      strength: 'V2',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),

  buildTaskManifest({
    taskId: 'ts-string-bug-001',
    category: 'bug-fix',
    benchmarkEligible: false,
    repository: {
      name: 'ts-string',
      url: `${REPO_BASE}/ts-string`,
      baseCommit: 'db466bc93113a232b8517fb267f0ec293f7cca2f',
      referenceFixCommit: undefined,
    },
    repoSize: 'small',
    task: {
      title: 'Fix camelCase to handle leading separators and multiple spaces',
      description: 'The `camelCase` function in `src/index.ts` does not correctly handle leading separators (e.g., `_hello_world` should become `helloWorld` but returns `_helloWorld`) and multiple consecutive separators (e.g., `hello  world  foo` should become `helloWorldFoo`). Fix the function to handle these edge cases. The test file `tests/index.test.ts` already exists and must pass.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [
        { command: 'npm test', expectedExitCode: 0 },
      ],
      holdout: [],
      strength: 'V2',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),

  buildTaskManifest({
    taskId: 'ts-validate-feature-001',
    category: 'multi-file-feature',
    benchmarkEligible: false,
    repository: {
      name: 'ts-validate',
      url: `${REPO_BASE}/ts-validate`,
      baseCommit: 'c59e92d60484dfce94449b6ab9faec7a323a8f5e',
      referenceFixCommit: undefined,
    },
    repoSize: 'small',
    task: {
      title: 'Implement isEmail validation function',
      description: 'The `ts-validate` library is missing an `isEmail` function. The test file `tests/index.test.ts` already imports `isEmail` from `src/index.ts` and has tests for it, but the function does not exist in `src/index.ts`. Implement the `isEmail` function to validate email addresses. It should return `true` for valid emails like `user@example.com` and `false` for invalid ones (missing @, missing domain, empty string). Export `isEmail` as a named export from `src/index.ts`.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [
        { command: 'npm test', expectedExitCode: 0 },
      ],
      holdout: [],
      strength: 'V2',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),

  buildTaskManifest({
    taskId: 'ts-events-feature-001',
    category: 'multi-file-feature',
    benchmarkEligible: false,
    repository: {
      name: 'ts-events',
      url: `${REPO_BASE}/ts-events`,
      baseCommit: '04a5e83060f76a0b0108b239278b666ff6de15b2',
      referenceFixCommit: undefined,
    },
    repoSize: 'small',
    task: {
      title: 'Implement off() and once() methods on EventEmitter',
      description: 'The `EventEmitter` class in `src/emitter.ts` is missing the `off()` and `once()` methods. The test file `tests/index.test.ts` already has tests for these methods. Implement `off(event, handler)` to remove a specific handler from an event, and `once(event, handler)` to add a handler that is automatically removed after its first invocation. Both methods should be on the `EventEmitter` class in `src/emitter.ts`.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [
        { command: 'npm test', expectedExitCode: 0 },
      ],
      holdout: [],
      strength: 'V2',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),
]
