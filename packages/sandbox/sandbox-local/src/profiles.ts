/**
 * Internal platform-profile builders for the local sandbox provider.
 *
 * `workspace-isolated` has different read-isolation semantics by platform:
 *
 * - **bwrap (Linux): mount-namespace allowlist.** Only the workspace root and
 *   essential system directories (bin, lib, usr, etc) are mounted. Host files
 *   outside the mount set are invisible — genuine filesystem isolation.
 *   `protectedReadPaths` is not consumed because unmounted paths are
 *   inherently unreachable. Network is unshared (`--unshare-net`) so confined
 *   processes cannot reach external services.
 *
 * - **Landlock (Linux): allow-list grants.** Read access is granted only to
 *   essential system paths and the workspace root. Like bwrap, ungranted paths
 *   are unreachable. `protectedReadPaths` is not consumed.
 *
 * - **Seatbelt (macOS): protected-path denylist.** A deny-by-default read
 *   policy causes process aborts because the macOS dynamic linker and system
 *   frameworks require broad read access. The practical approach is
 *   allow-all-reads with explicit `(deny file-read*)` rules for each entry in
 *   `protectedReadPaths`. Seatbelt resolves symlinks before matching, so
 *   symlink escapes to protected paths are denied. This is not the same
 *   guarantee as "the process can only read the workspace" — it is "the
 *   process cannot read the listed paths." The completeness of isolation
 *   depends on the denylist covering every sensitive host path. Network is
 *   denied (`(deny network*)`) so confined processes cannot reach external
 *   services.
 *
 * Qualify each backend separately with the same adversarial test suite; do
 * not assume that proving one backend proves another.
 *
 * @module @deepseek-ai/dsh-sandbox-local/profiles
 */

import { grantArgs as landlockGrantArgs } from '@deepseek-ai/node-addon-landlock-run'
import { canonicalPath, writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { existsSync } from 'node:fs'

/**
 * Build the bwrap profile arguments for one file-effect policy.
 * `workspace-isolated` uses a mount-namespace allowlist; see module doc.
 * @param policy - file-effect policy to express as bwrap mounts.
 * @returns profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(policy: SandboxPolicy): string[] {
  if (policy.mode === 'workspace-isolated') {
    const args = [
      '--dev', '/dev',
      '--proc', '/proc',
      '--unshare-pid',
      '--unshare-net',
      '--die-with-parent',
      '--ro-bind', '/usr', '/usr',
      '--ro-bind', '/lib', '/lib',
      '--ro-bind', '/lib64', '/lib64',
      '--ro-bind', '/bin', '/bin',
      '--ro-bind', '/etc', '/etc',
      '--tmpfs', '/tmp',
      '--bind', policy.workspaceRoot, policy.workspaceRoot,
    ]
    // readOnlyPaths: re-mount specified subdirectories read-only after
    // the workspace bind mount. bwrap processes later mounts on top of
    // earlier ones, so a --ro-bind for a subdirectory overrides the
    // parent --bind. Protects verifier-affecting state such as
    // node_modules from model mutation via shell subprocesses.
    // Skip paths that do not exist — bwrap fails if asked to bind a
    // nonexistent path, and optional directories like dist may not be
    // present in all workspaces.
    for (const roPath of policy.readOnlyPaths ?? []) {
      if (existsSync(roPath)) {
        args.push('--ro-bind', roPath, roPath)
      }
    }
    return args
  }
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
    for (const roPath of policy.readOnlyPaths ?? []) {
      if (existsSync(roPath)) {
        args.push('--ro-bind', roPath, roPath)
      }
    }
  }
  return args
}

/**
 * Build the Landlock launcher grants for one file-effect policy.
 * `workspace-isolated` uses allow-list grants; see module doc.
 * @param policy - file-effect policy to express as Landlock allow-list grants.
 * @returns launcher grant arguments before the trailing separator and command argv.
 */
export function landlockProfileArgs(policy: SandboxPolicy): string[] {
  const readWrite = ['/dev/null']
  if (policy.mode === 'workspace-write') {
    readWrite.push('/tmp', policy.workspaceRoot)
  } else if (policy.mode === 'workspace-isolated') {
    // workspace-isolated: only the workspace root is read-write.
    // Host /tmp is NOT granted — verifier-owned secrets stored outside
    // the workspace (holdouts, fixtures) must be unreachable.
    readWrite.push(policy.workspaceRoot)
  }
  // readOnlyPaths: add as readOnly grants. Landlock's nested rule model
  // restricts writes to subdirectories even when the parent is read-write.
  // Protects verifier-affecting state such as node_modules. Skip paths
  // that do not exist — the Landlock launcher opens each grant path with
  // O_PATH and fails closed if the path is missing, so optional
  // directories like dist must be filtered out.
  const roPaths = (policy.readOnlyPaths ?? []).filter(existsSync)
  if (policy.mode === 'workspace-isolated') {
    return landlockGrantArgs({
      readOnly: ['/usr', '/lib', '/lib64', '/bin', '/etc', '/dev', '/proc', ...roPaths],
      readWrite,
    })
  }
  return landlockGrantArgs({ readOnly: ['/', ...roPaths], readWrite })
}

/** Quote one path as an SBPL string literal. */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/**
 * Build the sandbox-exec arguments and SBPL profile for one policy. The
 * writable roots come from the shared {@link writableRoots} helper (canonical,
 * deduplicated) so the Seatbelt grant and the in-process fs fence
 * (`@deepseek-ai/dsh-fs-sandbox`) can never drift apart.
 * `workspace-isolated` uses a protected-path denylist; see module doc.
 * @param policy - file-effect policy to express as an SBPL profile.
 * @returns sandbox-exec arguments before the trailing separator and command argv.
 */
export function seatbeltProfileArgs(policy: SandboxPolicy): string[] {
  if (policy.mode === 'workspace-isolated') {
    const ws = sbplString(canonicalPath(policy.workspaceRoot))
    const denyPaths = (policy.protectedReadPaths ?? []).map(canonicalPath)
    const denyForms = denyPaths.map(p => `(deny file-read* (subpath ${sbplString(p)}))`)
    // readOnlyPaths: deny writes to specified subdirectories within the
    // workspace. Protects verifier-affecting state such as node_modules
    // from model mutation via shell subprocesses. Skip paths that do not
    // exist — deny rules for missing paths are no-ops but filtering keeps
    // the SBPL profile consistent with the in-process fs fence.
    const roPaths = (policy.readOnlyPaths ?? []).filter(existsSync).map(canonicalPath)
    const roDenyForms = roPaths.map(p => `(deny file-write* (subpath ${sbplString(p)}))`)
    const forms = [
      '(version 1)',
      '(deny default)',
      '(allow file-read*)',
      ...denyForms,
      `(allow file-write* (subpath ${ws}))`,
      ...roDenyForms,
      '(allow file-write* (literal "/dev/null"))',
      '(deny file-write*)',
      '(allow process-exec)',
      '(allow process-fork)',
      '(allow mach-lookup)',
      '(allow signal)',
      '(allow ipc-posix-shm)',
      '(allow sysctl-read)',
      '(allow iokit-open)',
      '(deny network*)',
    ]
    return ['-p', forms.join(' ')]
  }
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* (literal ${sbplString('/dev/null')}))`]
  const roots = writableRoots(policy)
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  // readOnlyPaths under workspace-write: deny writes to specified subdirectories.
  // Skip paths that do not exist for consistency with bwrap and Landlock.
  const roPaths = (policy.readOnlyPaths ?? []).filter(existsSync).map(canonicalPath)
  for (const p of roPaths) {
    forms.push(`(deny file-write* (subpath ${sbplString(p)}))`)
  }
  return ['-p', forms.join(' ')]
}
