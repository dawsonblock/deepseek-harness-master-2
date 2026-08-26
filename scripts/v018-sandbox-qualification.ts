/**
 * Sandbox backend qualification status for v0.18. Records which
 * backends have been adversarially tested and which are implemented
 * but not yet qualified in this release environment.
 *
 * @module v018-sandbox-qualification
 */

/** Sandbox backend qualification record. */
export interface SandboxBackendQualification {
  readonly platform: string
  readonly backend: string
  readonly qualified: boolean
  readonly readIsolationModel: string
  readonly detail: string
}

/** Current qualification status for all sandbox backends. */
export const SANDBOX_BACKEND_QUALIFICATION: readonly SandboxBackendQualification[] = [
  {
    platform: 'darwin',
    backend: 'seatbelt',
    qualified: true,
    readIsolationModel: 'protected-path-denylist',
    detail: 'Adversarially tested: direct reads, traversal, symlinks, child processes',
  },
  {
    platform: 'linux',
    backend: 'bwrap',
    qualified: false,
    readIsolationModel: 'mount-namespace-allowlist',
    detail: 'Implemented; not qualified in this release environment (no Linux test run)',
  },
  {
    platform: 'linux',
    backend: 'landlock',
    qualified: false,
    readIsolationModel: 'allow-list-grants',
    detail: 'Implemented; not qualified in this release environment (no Linux test run)',
  },
  {
    platform: 'win32',
    backend: 'restricted-token-acl',
    qualified: false,
    readIsolationModel: 'restricted-token-acl',
    detail: 'Not implemented in this release',
  },
]

/**
 * Get the qualification status for the current platform's backend.
 * @param platform - the platform string (process.platform).
 * @returns the qualification record, or undefined if no backend for this platform.
 */
export function getBackendQualification(platform: string): SandboxBackendQualification | undefined {
  return SANDBOX_BACKEND_QUALIFICATION.find(q => q.platform === platform && q.qualified)
}

/**
 * Check whether the current platform has a qualified sandbox backend.
 * @param platform - the platform string (process.platform).
 * @returns true if a qualified backend exists for this platform.
 */
export function hasQualifiedBackend(platform: string): boolean {
  return SANDBOX_BACKEND_QUALIFICATION.some(q => q.platform === platform && q.qualified)
}

/**
 * Format the sandbox qualification status for the qualification report.
 * @returns formatted status string.
 */
export function formatSandboxQualification(): string {
  const lines: string[] = ['Sandbox Backend Qualification:', '-' .repeat(40)]
  for (const q of SANDBOX_BACKEND_QUALIFICATION) {
    const status = q.qualified ? 'QUALIFIED' : 'NOT-QUALIFIED'
    lines.push(`  [${status}] ${q.platform}/${q.backend}: ${q.readIsolationModel}`)
    lines.push(`    ${q.detail}`)
  }
  return lines.join('\n')
}
