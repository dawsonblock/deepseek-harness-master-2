/**
 * v0.19 Batch A task corpus — 25 synthetic multi-repository benchmark tasks.
 *
 * Category quotas:
 *   Bug fixes          4
 *   Failing tests      4
 *   Type/build         3
 *   Multi-file         3
 *   Refactors          3
 *   API/integration    2
 *   Repo understanding 2
 *   Algorithmic        2
 *   Dependency/config  2
 *   Total              25
 *
 * Verification strength distribution:
 *   V3: 12 (diagnostic + unseen holdout)
 *   V2: 11 (strong regression verification)
 *   V1:  2 (broad tests/build/typecheck)
 *   V0:  0 (excluded from primary benchmark)
 *
 * Repository distribution (max 4 per repo):
 *   ts-utils       4
 *   ts-validate    4
 *   ts-collections 4
 *   ts-http        3
 *   ts-string      4
 *   ts-state       3
 *   ts-date        3
 *
 * All tasks have benchmarkEligible=true and use frozen v0.18.0 repair limits.
 *
 * @module v019-batch-a-corpus
 */

import {
  type TaskManifest,
  buildTaskManifest,
  FROZEN_V018_LIMITS,
} from './v019-task-manifest.ts'

const REPO_BASE = 'file:///tmp/v019-batch-a-repos'

/**
 * Batch A task corpus.
 *
 * Commit hashes are filled in after running scripts/v019-batch-a-repos.sh.
 * The values below are the actual commit hashes from the repos created
 * by that script.
 */
export const BATCH_A_CORPUS: TaskManifest[] = [
  // ── ts-utils (4 tasks) ──────────────────────────────────────────────
  buildTaskManifest({
    taskId: 'batch-a-ts-utils-debounce-001',
    category: 'bug-fix',
    benchmarkEligible: true,
    repository: {
      name: 'ts-utils',
      url: `${REPO_BASE}/ts-utils`,
      baseCommit: '8fa9e288dfa742f1ed2b52779b32c5ad7c6f74cc',
      referenceFixCommit: 'e5f5f7edd0367498a31d72ca4644caf57ce7576c',
      dependencyLockHash: '87a4daebdd4cf817037fb60ae49b6dd291fcffeba4c8ebaee02a5320da5949ee',
    },
    repoSize: 'small',
    task: {
      title: 'Fix debounce function to properly cancel pending calls',
      description: 'The `debounce` function in `src/debounce.ts` does not cancel pending invocations properly. When called multiple times, it should reset the timer but it currently allows the previous timer to fire. The test file `tests/debounce.test.ts` has tests that demonstrate the expected behavior. Fix the function so all tests pass.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [{ command: 'npx vitest run tests/debounce.test.ts', expectedExitCode: 0 }],
      holdout: [{ command: 'npx vitest run --config vitest.holdout.config.ts tests/debounce.holdout.test.ts', expectedExitCode: 0 }],
      strength: 'V3',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),

  buildTaskManifest({
    taskId: 'batch-a-ts-utils-chunk-001',
    category: 'failing-test',
    benchmarkEligible: true,
    repository: {
      name: 'ts-utils',
      url: `${REPO_BASE}/ts-utils`,
      baseCommit: '8fa9e288dfa742f1ed2b52779b32c5ad7c6f74cc',
      referenceFixCommit: 'e5f5f7edd0367498a31d72ca4644caf57ce7576c',
      dependencyLockHash: '87a4daebdd4cf817037fb60ae49b6dd291fcffeba4c8ebaee02a5320da5949ee',
    },
    repoSize: 'small',
    task: {
      title: 'Fix chunk function for empty array edge case',
      description: 'The `chunk` function in `src/chunk.ts` throws an error when given an empty array. It should return an empty array instead. The test file `tests/chunk.test.ts` has a test case for this that is currently failing. Fix the function so the test passes.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [{ command: 'npx vitest run tests/chunk.test.ts', expectedExitCode: 0 }],
      holdout: [],
      strength: 'V2',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),

  buildTaskManifest({
    taskId: 'batch-a-ts-utils-type-001',
    category: 'type-build-error',
    benchmarkEligible: true,
    repository: {
      name: 'ts-utils',
      url: `${REPO_BASE}/ts-utils`,
      baseCommit: '8fa9e288dfa742f1ed2b52779b32c5ad7c6f74cc',
      referenceFixCommit: 'e5f5f7edd0367498a31d72ca4644caf57ce7576c',
      dependencyLockHash: '87a4daebdd4cf817037fb60ae49b6dd291fcffeba4c8ebaee02a5320da5949ee',
    },
    repoSize: 'small',
    task: {
      title: 'Fix TypeScript strict mode compilation error in throttle.ts',
      description: 'The project fails to compile under TypeScript strict mode. The `throttle` function in `src/throttle.ts` is missing a return type annotation and has an implicit `any` in its leading edge logic. Fix the type errors so `npm run build` succeeds.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [{ command: 'npx tsc --noEmit', expectedExitCode: 0 }],
      holdout: [],
      strength: 'V2',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),

  buildTaskManifest({
    taskId: 'batch-a-ts-utils-binarysearch-001',
    category: 'algorithm',
    benchmarkEligible: true,
    repository: {
      name: 'ts-utils',
      url: `${REPO_BASE}/ts-utils`,
      baseCommit: '8fa9e288dfa742f1ed2b52779b32c5ad7c6f74cc',
      referenceFixCommit: 'e5f5f7edd0367498a31d72ca4644caf57ce7576c',
      dependencyLockHash: '87a4daebdd4cf817037fb60ae49b6dd291fcffeba4c8ebaee02a5320da5949ee',
    },
    repoSize: 'small',
    task: {
      title: 'Fix binarySearch to return correct index for duplicate elements',
      description: 'The `binarySearch` function in `src/binarySearch.ts` returns the wrong index when the array contains duplicate values. It should return the first occurrence of the target, but it currently returns an arbitrary match. The test file `tests/binarySearch.test.ts` has tests that demonstrate the expected behavior. Fix the algorithm.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [{ command: 'npx vitest run tests/binarySearch.test.ts', expectedExitCode: 0 }],
      holdout: [{ command: 'npx vitest run --config vitest.holdout.config.ts tests/binarySearch.holdout.test.ts', expectedExitCode: 0 }],
      strength: 'V3',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),

  // ── ts-validate (4 tasks) ───────────────────────────────────────────
  buildTaskManifest({
    taskId: 'batch-a-ts-validate-isurl-001',
    category: 'bug-fix',
    benchmarkEligible: true,
    repository: {
      name: 'ts-validate',
      url: `${REPO_BASE}/ts-validate`,
      baseCommit: 'd5772d5144e4ff0c2abaaae32488e0b153d7f352',
      referenceFixCommit: '78f8142d69467201d4a7bc16b4d7769bb52458c4',
      dependencyLockHash: '575362270eebf4c159b6dc460693051c7c3f62cd793a09d0ecbaaeb580e01348',
    },
    repoSize: 'small',
    task: {
      title: 'Fix isUrl validator to properly validate protocol',
      description: 'The `isUrl` function in `src/validators.ts` does not properly validate the URL protocol. It accepts URLs without a valid protocol (e.g., `example.com` should be invalid but returns true). The test file `tests/validators.test.ts` has failing tests. Fix the validator.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [{ command: 'npx vitest run tests/validators.test.ts', expectedExitCode: 0 }],
      holdout: [{ command: 'npx vitest run --config vitest.holdout.config.ts tests/validators.holdout.test.ts', expectedExitCode: 0 }],
      strength: 'V3',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),

  buildTaskManifest({
    taskId: 'batch-a-ts-validate-phone-001',
    category: 'multi-file-feature',
    benchmarkEligible: true,
    repository: {
      name: 'ts-validate',
      url: `${REPO_BASE}/ts-validate`,
      baseCommit: 'd5772d5144e4ff0c2abaaae32488e0b153d7f352',
      referenceFixCommit: '78f8142d69467201d4a7bc16b4d7769bb52458c4',
      dependencyLockHash: '575362270eebf4c159b6dc460693051c7c3f62cd793a09d0ecbaaeb580e01348',
    },
    repoSize: 'small',
    task: {
      title: 'Add isPhoneNumber validator with tests in a separate file',
      description: 'The `ts-validate` library is missing an `isPhoneNumber` function. Create a new file `src/phone.ts` that exports `isPhoneNumber(value: string): boolean`. The function should validate US phone numbers in formats like `(123) 456-7890`, `123-456-7890`, and `1234567890`. Export it from `src/index.ts`. Create `tests/phone.test.ts` with tests for valid and invalid phone numbers.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [{ command: 'npx vitest run tests/phone.test.ts', expectedExitCode: 0 }],
      holdout: [{ command: 'npx vitest run --config vitest.holdout.config.ts tests/phone.holdout.test.ts', expectedExitCode: 0 }],
      strength: 'V3',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),

  buildTaskManifest({
    taskId: 'batch-a-ts-validate-refactor-001',
    category: 'refactor',
    benchmarkEligible: true,
    repository: {
      name: 'ts-validate',
      url: `${REPO_BASE}/ts-validate`,
      baseCommit: 'd5772d5144e4ff0c2abaaae32488e0b153d7f352',
      referenceFixCommit: '78f8142d69467201d4a7bc16b4d7769bb52458c4',
      dependencyLockHash: '575362270eebf4c159b6dc460693051c7c3f62cd793a09d0ecbaaeb580e01348',
    },
    repoSize: 'small',
    task: {
      title: 'Refactor validators to use a common ValidationResult type',
      description: 'The validators in `src/validators.ts` each return `boolean`. Refactor them to return a `ValidationResult` type with `{ valid: boolean; message?: string }`. Update all existing tests to work with the new return type. The `isEmail`, `isUrl`, and `isRequired` functions should all return `ValidationResult`.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [{ command: 'npx vitest run tests/validators.test.ts', expectedExitCode: 0 }],
      holdout: [],
      strength: 'V2',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),

  buildTaskManifest({
    taskId: 'batch-a-ts-validate-schema-001',
    category: 'api-integration',
    benchmarkEligible: true,
    repository: {
      name: 'ts-validate',
      url: `${REPO_BASE}/ts-validate`,
      baseCommit: 'd5772d5144e4ff0c2abaaae32488e0b153d7f352',
      referenceFixCommit: '78f8142d69467201d4a7bc16b4d7769bb52458c4',
      dependencyLockHash: '575362270eebf4c159b6dc460693051c7c3f62cd793a09d0ecbaaeb580e01348',
    },
    repoSize: 'small',
    task: {
      title: 'Add validateWithSchema function that composes multiple validators',
      description: 'Add a `validateWithSchema` function to `src/validators.ts` that takes an object and a schema (a map of field names to validator functions) and returns `{ valid: boolean, errors: Record<string, string> }`. Each validator is applied to the corresponding field. If any fail, `valid` is false and `errors` maps field names to error messages. Export `validateWithSchema` from `src/index.ts`.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [{ command: 'npx vitest run tests/validators.test.ts', expectedExitCode: 0 }],
      holdout: [{ command: 'npx vitest run --config vitest.holdout.config.ts tests/schema.holdout.test.ts', expectedExitCode: 0 }],
      strength: 'V3',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),

  // ── ts-collections (4 tasks) ────────────────────────────────────────
  buildTaskManifest({
    taskId: 'batch-a-ts-collections-linkedlist-001',
    category: 'bug-fix',
    benchmarkEligible: true,
    repository: {
      name: 'ts-collections',
      url: `${REPO_BASE}/ts-collections`,
      baseCommit: '1f64dd27ed0f89f9a71ec4725c65db32a86544f0',
      referenceFixCommit: 'ea783aedde35dba0093f150177bdf65c0f045cfa',
      dependencyLockHash: '6589e64c49931985c102f4f576e582836be8740aa830aee21227869adff7a0ec',
    },
    repoSize: 'small',
    task: {
      title: 'Fix LinkedList removeAt to handle head removal',
      description: 'The `removeAt` method in `src/LinkedList.ts` does not correctly handle removal of the head element (index 0). When removing the first element, the list head is not updated. The test file `tests/LinkedList.test.ts` has failing tests for this case. Fix the method.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [{ command: 'npx vitest run tests/LinkedList.test.ts', expectedExitCode: 0 }],
      holdout: [{ command: 'npx vitest run --config vitest.holdout.config.ts tests/LinkedList.holdout.test.ts', expectedExitCode: 0 }],
      strength: 'V3',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),

  buildTaskManifest({
    taskId: 'batch-a-ts-collections-quicksort-001',
    category: 'algorithm',
    benchmarkEligible: true,
    repository: {
      name: 'ts-collections',
      url: `${REPO_BASE}/ts-collections`,
      baseCommit: '1f64dd27ed0f89f9a71ec4725c65db32a86544f0',
      referenceFixCommit: 'ea783aedde35dba0093f150177bdf65c0f045cfa',
      dependencyLockHash: '6589e64c49931985c102f4f576e582836be8740aa830aee21227869adff7a0ec',
    },
    repoSize: 'small',
    task: {
      title: 'Fix quickSort partition off-by-one error',
      description: 'The `quickSort` function in `src/quickSort.ts` has an off-by-one error in its partition logic. For certain inputs, it produces incorrect ordering. The test file `tests/quickSort.test.ts` has tests that fail for arrays with specific patterns. Fix the partition logic.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [{ command: 'npx vitest run tests/quickSort.test.ts', expectedExitCode: 0 }],
      holdout: [{ command: 'npx vitest run --config vitest.holdout.config.ts tests/quickSort.holdout.test.ts', expectedExitCode: 0 }],
      strength: 'V3',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),

  buildTaskManifest({
    taskId: 'batch-a-ts-collections-stack-001',
    category: 'multi-file-feature',
    benchmarkEligible: true,
    repository: {
      name: 'ts-collections',
      url: `${REPO_BASE}/ts-collections`,
      baseCommit: '1f64dd27ed0f89f9a71ec4725c65db32a86544f0',
      referenceFixCommit: 'ea783aedde35dba0093f150177bdf65c0f045cfa',
      dependencyLockHash: '6589e64c49931985c102f4f576e582836be8740aa830aee21227869adff7a0ec',
    },
    repoSize: 'small',
    task: {
      title: 'Add Stack class in a separate file with tests',
      description: 'The `ts-collections` library is missing a `Stack` class. Create `src/Stack.ts` with a `Stack<T>` class implementing `push`, `pop`, `peek`, `size`, and `isEmpty` methods. Export it from `src/index.ts`. Create `tests/Stack.test.ts` with tests covering all methods including edge cases (pop on empty, peek on empty).',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [{ command: 'npx vitest run tests/Stack.test.ts', expectedExitCode: 0 }],
      holdout: [{ command: 'npx vitest run --config vitest.holdout.config.ts tests/Stack.holdout.test.ts', expectedExitCode: 0 }],
      strength: 'V3',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),

  buildTaskManifest({
    taskId: 'batch-a-ts-collections-hashmap-001',
    category: 'refactor',
    benchmarkEligible: true,
    repository: {
      name: 'ts-collections',
      url: `${REPO_BASE}/ts-collections`,
      baseCommit: '1f64dd27ed0f89f9a71ec4725c65db32a86544f0',
      referenceFixCommit: 'ea783aedde35dba0093f150177bdf65c0f045cfa',
      dependencyLockHash: '6589e64c49931985c102f4f576e582836be8740aa830aee21227869adff7a0ec',
    },
    repoSize: 'small',
    task: {
      title: 'Refactor HashMap to use Map internally instead of plain object',
      description: 'The `HashMap` class in `src/HashMap.ts` uses a plain JavaScript object for storage. Refactor it to use a `Map` internally instead. This eliminates prototype pollution risks and allows non-string keys. All existing tests must continue to pass.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [{ command: 'npx vitest run tests/HashMap.test.ts', expectedExitCode: 0 }],
      holdout: [],
      strength: 'V2',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),

  // ── ts-http (3 tasks) ───────────────────────────────────────────────
  buildTaskManifest({
    taskId: 'batch-a-ts-http-headers-001',
    category: 'bug-fix',
    benchmarkEligible: true,
    repository: {
      name: 'ts-http',
      url: `${REPO_BASE}/ts-http`,
      baseCommit: '28b0832215a95c8c5e920c824826416a01f63c48',
      referenceFixCommit: '519692c9067dd548cde2df440a350461d5c12abd',
      dependencyLockHash: '1639a989b3246fad6789cf5d83f0ca92ff2da5e69c4e5f29315bee6c23bd44f4',
    },
    repoSize: 'small',
    task: {
      title: 'Fix parseHeaders to handle multiple Set-Cookie headers',
      description: 'The `parseHeaders` function in `src/headers.ts` does not correctly handle responses with multiple `Set-Cookie` headers. It overwrites previous values instead of collecting them into an array. The test file `tests/headers.test.ts` has failing tests. Fix the parser to collect multiple headers with the same name into an array.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [{ command: 'npx vitest run tests/headers.test.ts', expectedExitCode: 0 }],
      holdout: [{ command: 'npx vitest run --config vitest.holdout.config.ts tests/headers.holdout.test.ts', expectedExitCode: 0 }],
      strength: 'V3',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),

  buildTaskManifest({
    taskId: 'batch-a-ts-http-interceptor-001',
    category: 'api-integration',
    benchmarkEligible: true,
    repository: {
      name: 'ts-http',
      url: `${REPO_BASE}/ts-http`,
      baseCommit: '28b0832215a95c8c5e920c824826416a01f63c48',
      referenceFixCommit: '519692c9067dd548cde2df440a350461d5c12abd',
      dependencyLockHash: '1639a989b3246fad6789cf5d83f0ca92ff2da5e69c4e5f29315bee6c23bd44f4',
    },
    repoSize: 'small',
    task: {
      title: 'Add request interceptor support to HttpClient',
      description: 'The `HttpClient` class in `src/HttpClient.ts` does not support request interceptors. Add an `addInterceptor(fn: (config: RequestConfig) => RequestConfig)` method that registers a function called before each request. Interceptors should be called in registration order. The test file `tests/HttpClient.test.ts` has tests for this feature.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [{ command: 'npx vitest run tests/HttpClient.test.ts', expectedExitCode: 0 }],
      holdout: [],
      strength: 'V2',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),

  buildTaskManifest({
    taskId: 'batch-a-ts-http-deps-001',
    category: 'config-deps',
    benchmarkEligible: true,
    repository: {
      name: 'ts-http',
      url: `${REPO_BASE}/ts-http`,
      baseCommit: '28b0832215a95c8c5e920c824826416a01f63c48',
      referenceFixCommit: '519692c9067dd548cde2df440a350461d5c12abd',
      dependencyLockHash: '1639a989b3246fad6789cf5d83f0ca92ff2da5e69c4e5f29315bee6c23bd44f4',
    },
    repoSize: 'small',
    task: {
      title: 'Fix package.json dependency classification',
      description: 'The `vitest` package is listed in `dependencies` but should be in `devDependencies` since it is only used for testing. Move `vitest` from `dependencies` to `devDependencies` in `package.json`. Also move `typescript` to `devDependencies` since it is a build-time tool, not a runtime dependency. `npm install` and `npm test` should still pass after the fix.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm install', expectedExitCode: 0 },
      diagnostic: [{ command: 'npm install && npm run build', expectedExitCode: 0 }],
      holdout: [],
      strength: 'V1',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),

  // ── ts-string (4 tasks) ─────────────────────────────────────────────
  buildTaskManifest({
    taskId: 'batch-a-ts-string-truncate-001',
    category: 'bug-fix',
    benchmarkEligible: true,
    repository: {
      name: 'ts-string',
      url: `${REPO_BASE}/ts-string`,
      baseCommit: 'ee863b6c3acfef85c87b5b6f00b0c01b05b93ef1',
      referenceFixCommit: 'cb7224c6d9830477f72a6ca3d76df8893ce930b4',
      dependencyLockHash: '5226273b9b7fdf486e60afa2e31a95392ddb62b1763f9b3dec1ed380dbdd903d',
    },
    repoSize: 'small',
    task: {
      title: 'Fix truncate to account for multi-byte characters',
      description: 'The `truncate` function in `src/truncate.ts` uses `string.length` which counts UTF-16 code units, not characters. This causes incorrect truncation for strings with emoji or other multi-byte characters. The test file `tests/truncate.test.ts` has failing tests. Fix the function to use `Array.from(string).length` or equivalent for character-aware truncation.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [{ command: 'npx vitest run tests/truncate.test.ts', expectedExitCode: 0 }],
      holdout: [{ command: 'npx vitest run --config vitest.holdout.config.ts tests/truncate.holdout.test.ts', expectedExitCode: 0 }],
      strength: 'V3',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),

  buildTaskManifest({
    taskId: 'batch-a-ts-string-padstart-001',
    category: 'failing-test',
    benchmarkEligible: true,
    repository: {
      name: 'ts-string',
      url: `${REPO_BASE}/ts-string`,
      baseCommit: 'ee863b6c3acfef85c87b5b6f00b0c01b05b93ef1',
      referenceFixCommit: 'cb7224c6d9830477f72a6ca3d76df8893ce930b4',
      dependencyLockHash: '5226273b9b7fdf486e60afa2e31a95392ddb62b1763f9b3dec1ed380dbdd903d',
    },
    repoSize: 'small',
    task: {
      title: 'Fix padStart to handle negative length without throwing',
      description: 'The `padStart` function in `src/padStart.ts` throws a `RangeError` when given a negative length parameter. It should return an empty string instead. The test file `tests/padStart.test.ts` has a failing test for this case. Fix the function.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [{ command: 'npx vitest run tests/padStart.test.ts', expectedExitCode: 0 }],
      holdout: [],
      strength: 'V2',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),

  buildTaskManifest({
    taskId: 'batch-a-ts-string-template-001',
    category: 'refactor',
    benchmarkEligible: true,
    repository: {
      name: 'ts-string',
      url: `${REPO_BASE}/ts-string`,
      baseCommit: 'ee863b6c3acfef85c87b5b6f00b0c01b05b93ef1',
      referenceFixCommit: 'cb7224c6d9830477f72a6ca3d76df8893ce930b4',
      dependencyLockHash: '5226273b9b7fdf486e60afa2e31a95392ddb62b1763f9b3dec1ed380dbdd903d',
    },
    repoSize: 'small',
    task: {
      title: 'Refactor template function to use template literals',
      description: 'The `template` function in `src/template.ts` uses string concatenation with `replace` and regex. Refactor it to use tagged template literals or a cleaner interpolation approach. The function should still support `{variable}` placeholder syntax. All existing tests must pass.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [{ command: 'npx vitest run tests/template.test.ts', expectedExitCode: 0 }],
      holdout: [],
      strength: 'V2',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),

  buildTaskManifest({
    taskId: 'batch-a-ts-string-slugify-001',
    category: 'repo-understanding',
    benchmarkEligible: true,
    repository: {
      name: 'ts-string',
      url: `${REPO_BASE}/ts-string`,
      baseCommit: 'ee863b6c3acfef85c87b5b6f00b0c01b05b93ef1',
      referenceFixCommit: 'cb7224c6d9830477f72a6ca3d76df8893ce930b4',
      dependencyLockHash: '5226273b9b7fdf486e60afa2e31a95392ddb62b1763f9b3dec1ed380dbdd903d',
    },
    repoSize: 'small',
    task: {
      title: 'Fix slugify to handle Unicode characters',
      description: 'The `slugify` function in `src/slugify.ts` does not correctly handle Unicode characters. It strips accented characters and non-ASCII text entirely instead of transliterating them. The test file `tests/slugify.test.ts` has failing tests for strings with accented characters and CJK text. Fix the function to properly transliterate or preserve Unicode.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [{ command: 'npx vitest run tests/slugify.test.ts', expectedExitCode: 0 }],
      holdout: [{ command: 'npx vitest run --config vitest.holdout.config.ts tests/slugify.holdout.test.ts', expectedExitCode: 0 }],
      strength: 'V3',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),

  // ── ts-state (3 tasks) ──────────────────────────────────────────────
  buildTaskManifest({
    taskId: 'batch-a-ts-state-subscribe-001',
    category: 'bug-fix',
    benchmarkEligible: true,
    repository: {
      name: 'ts-state',
      url: `${REPO_BASE}/ts-state`,
      baseCommit: '4251beff87ba6b3789accd4504e97ba1a60b3b02',
      referenceFixCommit: 'dcb9b6c87b77a4d8f3f013dae2a0595603b50725',
      dependencyLockHash: '15a8fa26d039494f3cd40efcfb1ff67ee4172c54e9c64fa7496ae9e9d1d0f3c4',
    },
    repoSize: 'small',
    task: {
      title: 'Fix Store.subscribe to return an unsubscribe function',
      description: 'The `subscribe` method on the `Store` class in `src/Store.ts` does not return an unsubscribe function. Callers cannot remove their listener, leading to memory leaks. The test file `tests/Store.test.ts` has failing tests that expect `subscribe` to return a function that removes the listener when called. Fix the method.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [{ command: 'npx vitest run tests/Store.test.ts', expectedExitCode: 0 }],
      holdout: [{ command: 'npx vitest run --config vitest.holdout.config.ts tests/Store.holdout.test.ts', expectedExitCode: 0 }],
      strength: 'V3',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),

  buildTaskManifest({
    taskId: 'batch-a-ts-state-selector-001',
    category: 'multi-file-feature',
    benchmarkEligible: true,
    repository: {
      name: 'ts-state',
      url: `${REPO_BASE}/ts-state`,
      baseCommit: '4251beff87ba6b3789accd4504e97ba1a60b3b02',
      referenceFixCommit: 'dcb9b6c87b77a4d8f3f013dae2a0595603b50725',
      dependencyLockHash: '15a8fa26d039494f3cd40efcfb1ff67ee4172c54e9c64fa7496ae9e9d1d0f3c4',
    },
    repoSize: 'small',
    task: {
      title: 'Add createSelector memoization utility',
      description: 'The `ts-state` library is missing a `createSelector` function for memoized state selectors. Create `src/selector.ts` that exports `createSelector(inputs: Selector[], resultFn: (...args) => R): Selector`. The selector should cache results and only recompute when input selectors return new values. Export from `src/index.ts`. Create `tests/selector.test.ts` with tests.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [{ command: 'npx vitest run tests/selector.test.ts', expectedExitCode: 0 }],
      holdout: [{ command: 'npx vitest run --config vitest.holdout.config.ts tests/selector.holdout.test.ts', expectedExitCode: 0 }],
      strength: 'V3',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),

  buildTaskManifest({
    taskId: 'batch-a-ts-state-type-001',
    category: 'type-build-error',
    benchmarkEligible: true,
    repository: {
      name: 'ts-state',
      url: `${REPO_BASE}/ts-state`,
      baseCommit: '4251beff87ba6b3789accd4504e97ba1a60b3b02',
      referenceFixCommit: 'dcb9b6c87b77a4d8f3f013dae2a0595603b50725',
      dependencyLockHash: '15a8fa26d039494f3cd40efcfb1ff67ee4172c54e9c64fa7496ae9e9d1d0f3c4',
    },
    repoSize: 'small',
    task: {
      title: 'Fix Reducer type to accept undefined initial state',
      description: 'The `Reducer` type in `src/types.ts` does not accept `undefined` as a valid initial state value. This causes a TypeScript error when creating a store with an optional state slice. Fix the type definition so `Reducer<S, A>` accepts `S | undefined` as the first parameter. The test file `tests/types.test.ts` verifies this with a type-level test.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [{ command: 'npx tsc --noEmit', expectedExitCode: 0 }],
      holdout: [],
      strength: 'V2',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),

  // ── ts-date (3 tasks) ───────────────────────────────────────────────
  buildTaskManifest({
    taskId: 'batch-a-ts-date-format-001',
    category: 'bug-fix',
    benchmarkEligible: true,
    repository: {
      name: 'ts-date',
      url: `${REPO_BASE}/ts-date`,
      baseCommit: 'caec83c4132ff226fedec62c577a6a80d5bde138',
      referenceFixCommit: '002ca7c511ff172f4d7759fd1d7b626436588713',
      dependencyLockHash: 'a92d9f99c665ea437af2c667c40a1d22778b2a96e926c4195cda069674afef2b',
    },
    repoSize: 'small',
    task: {
      title: 'Fix formatDate to handle timezone offset correctly',
      description: 'The `formatDate` function in `src/format.ts` does not correctly handle timezone offsets. It uses `getHours()` instead of `getUTCHours()` when formatting with a timezone specifier. The test file `tests/format.test.ts` has failing tests for timezone-aware formatting. Fix the function.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [{ command: 'npx vitest run tests/format.test.ts', expectedExitCode: 0 }],
      holdout: [{ command: 'npx vitest run --config vitest.holdout.config.ts tests/format.holdout.test.ts', expectedExitCode: 0 }],
      strength: 'V3',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),

  buildTaskManifest({
    taskId: 'batch-a-ts-date-dst-001',
    category: 'failing-test',
    benchmarkEligible: true,
    repository: {
      name: 'ts-date',
      url: `${REPO_BASE}/ts-date`,
      baseCommit: 'caec83c4132ff226fedec62c577a6a80d5bde138',
      referenceFixCommit: '002ca7c511ff172f4d7759fd1d7b626436588713',
      dependencyLockHash: 'a92d9f99c665ea437af2c667c40a1d22778b2a96e926c4195cda069674afef2b',
    },
    repoSize: 'small',
    task: {
      title: 'Fix daysBetween to account for DST transitions',
      description: 'The `daysBetween` function in `src/diff.ts` calculates the number of days between two dates by dividing milliseconds by 86400000. This is incorrect across DST transitions where a day has 23 or 25 hours. The test file `tests/diff.test.ts` has a failing test for dates spanning a DST transition. Fix the calculation.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [{ command: 'TZ=America/New_York npx vitest run tests/diff.test.ts', expectedExitCode: 0 }],
      holdout: [],
      strength: 'V2',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),

  buildTaskManifest({
    taskId: 'batch-a-ts-date-leapyear-001',
    category: 'repo-understanding',
    benchmarkEligible: true,
    repository: {
      name: 'ts-date',
      url: `${REPO_BASE}/ts-date`,
      baseCommit: 'caec83c4132ff226fedec62c577a6a80d5bde138',
      referenceFixCommit: '002ca7c511ff172f4d7759fd1d7b626436588713',
      dependencyLockHash: 'a92d9f99c665ea437af2c667c40a1d22778b2a96e926c4195cda069674afef2b',
    },
    repoSize: 'small',
    task: {
      title: 'Fix isLeapYear to use correct leap year formula',
      description: 'The `isLeapYear` function in `src/leapYear.ts` uses an incorrect formula. It only checks divisibility by 4, but leap years also require non-divisibility by 100 unless divisible by 400. The test file `tests/leapYear.test.ts` has failing tests for years like 1900 (not a leap year) and 2000 (is a leap year). Fix the formula.',
      source: 'synthetic',
    },
    verification: {
      build: { command: 'npm run build', expectedExitCode: 0 },
      diagnostic: [{ command: 'npx vitest run tests/leapYear.test.ts', expectedExitCode: 0 }],
      holdout: [{ command: 'npx vitest run --config vitest.holdout.config.ts tests/leapYear.holdout.test.ts', expectedExitCode: 0 }],
      strength: 'V3',
    },
    limits: { ...FROZEN_V018_LIMITS },
  }),
]

/** Category quota targets for Batch A. */
export const BATCH_A_QUOTAS: Record<string, number> = {
  'bug-fix': 7,
  'failing-test': 3,
  'type-build-error': 2,
  'multi-file-feature': 3,
  'refactor': 3,
  'api-integration': 2,
  'repo-understanding': 2,
  'algorithm': 2,
  'config-deps': 1,
}

/** Verification strength targets for Batch A. */
export const BATCH_A_STRENGTH_QUOTAS: Record<string, number> = {
  V3: 15,
  V2: 9,
  V1: 1,
  V0: 0,
}
