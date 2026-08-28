/**
 * Sandbox backend qualification status for v0.18. Records which
 * backends have been adversarially tested and which are implemented
 * but not yet qualified in this release environment.
 *
 * Each backend carries explicit test counts so unavailable platforms
 * report `supported = false` and `qualification = "not-run"` rather
 * than implying success.
 *
 * @module v018-sandbox-qualification
 */

/** Qualification outcome for one backend. */
export type SandboxQualificationStatus = 'pass' | 'fail' | 'not-run'

/** Sandbox backend qualification record with explicit test counts. */
export interface SandboxBackendQualification {
  readonly platform: string
  readonly backend: string
  readonly supported: boolean
  readonly qualification: SandboxQualificationStatus
  readonly isolationModel: string
  readonly requiredTests: number
  readonly executedTests: number
  readonly passedTests: number
  readonly skippedTests: number
  readonly detail: string
}

/** Total tests in the adversarial read-isolation suite. */
export const SANDBOX_REQUIRED_TEST_COUNT = 9

/** Current qualification status for all sandbox backends. */
export const SANDBOX_BACKEND_QUALIFICATION: readonly SandboxBackendQualification[] = [
  {
    platform: 'darwin',
    backend: 'seatbelt',
    supported: true,
    qualification: 'pass',
    isolationModel: 'protected-path-denylist',
    requiredTests: SANDBOX_REQUIRED_TEST_COUNT,
    executedTests: SANDBOX_REQUIRED_TEST_COUNT,
    passedTests: SANDBOX_REQUIRED_TEST_COUNT,
    skippedTests: 0,
    detail: 'Adversarially tested: direct reads, traversal, symlinks, child processes',
  },
  {
    platform: 'linux',
    backend: 'bwrap',
    supported: true,
    qualification: 'not-run',
    isolationModel: 'mount-namespace-allowlist',
    requiredTests: SANDBOX_REQUIRED_TEST_COUNT,
    executedTests: 0,
    passedTests: 0,
    skippedTests: SANDBOX_REQUIRED_TEST_COUNT,
    detail: 'Implemented; not qualified in this release environment (no Linux test run)',
  },
  {
    platform: 'linux',
    backend: 'landlock',
    supported: true,
    qualification: 'not-run',
    isolationModel: 'allow-list-grants',
    requiredTests: SANDBOX_REQUIRED_TEST_COUNT,
    executedTests: 0,
    passedTests: 0,
    skippedTests: SANDBOX_REQUIRED_TEST_COUNT,
    detail: 'Implemented; not qualified in this release environment (no Linux test run)',
  },
  {
    platform: 'win32',
    backend: 'restricted-token-acl',
    supported: false,
    qualification: 'not-run',
    isolationModel: 'restricted-token-acl',
    requiredTests: SANDBOX_REQUIRED_TEST_COUNT,
    executedTests: 0,
    passedTests: 0,
    skippedTests: SANDBOX_REQUIRED_TEST_COUNT,
    detail: 'Not implemented in this release',
  },
]

/** Sandbox qualification identity bound into the v018 manifest. */
export const SANDBOX_QUALIFICATION_ID = 'v018-sandbox-v1'

/**
 * Get the qualification status for the current platform's backend.
 * @param platform - the platform string (process.platform).
 * @returns the qualification record, or undefined if no backend for this platform.
 */
export function getBackendQualification(platform: string): SandboxBackendQualification | undefined {
  return SANDBOX_BACKEND_QUALIFICATION.find(q => q.platform === platform && q.qualification === 'pass')
}

/**
 * Check whether the current platform has a qualified sandbox backend.
 * @param platform - the platform string (process.platform).
 * @returns true if a qualified backend exists for this platform.
 */
export function hasQualifiedBackend(platform: string): boolean {
  return SANDBOX_BACKEND_QUALIFICATION.some(q => q.platform === platform && q.qualification === 'pass')
}

/**
 * Format the sandbox qualification status for the qualification report.
 * @returns formatted status string.
 */
export function formatSandboxQualification(): string {
  const lines: string[] = ['Sandbox Backend Qualification:', '-'.repeat(40)]
  for (const q of SANDBOX_BACKEND_QUALIFICATION) {
    const status = q.qualification === 'pass' ? 'PASS' : q.qualification === 'fail' ? 'FAIL' : 'NOT-RUN'
    const supported = q.supported ? 'supported' : 'unsupported'
    lines.push(`  [${status}] ${q.platform}/${q.backend} (${supported}): ${q.isolationModel}`)
    lines.push(`    tests: ${q.passedTests}/${q.executedTests} passed, ${q.skippedTests} skipped (required: ${q.requiredTests})`)
    lines.push(`    ${q.detail}`)
  }
  return lines.join('\n')
}
