/**
 * v0.18 qualification manifest and prerequisite gate.
 *
 * - Records qualification identity and all version stamps
 * - Verifies manifest consistency
 * - Runs prerequisite checks before live qualification
 * - Implements the API preflight smoke test
 * - Prints the prerequisite summary gate
 *
 * @module v018-qualification-manifest
 */

import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'

// ---------------------------------------------------------------------------
// E21-E23: Manifest and qualification identity
// ---------------------------------------------------------------------------

/** Qualification manifest recording all version stamps. */
export interface QualificationManifest {
  /** Qualification identity, e.g. v018-qualification-v1. */
  readonly qualificationId: string
  /** Git commit hash of the source tree. */
  readonly sourceCommit: string
  /** Repair controller package version. */
  readonly repairControllerVersion: string
  /** Repair runtime package version. */
  readonly repairRuntimeVersion: string
  /** Session event schema version. */
  readonly eventSchemaVersion: number
  /** Pricing registry version. */
  readonly pricingVersion: string
  /** Sandbox policy version. */
  readonly sandboxPolicyVersion: string
  /** Fixture content version. */
  readonly fixtureVersion: string
  /** Holdout test content version. */
  readonly holdoutVersion: string
  /** Manifest content hash for tamper detection. */
  readonly manifestHash: string
}

/** Build a qualification manifest from the current repository state. */
export async function buildManifest(params: {
  repairControllerVersion: string
  repairRuntimeVersion: string
  eventSchemaVersion: number
  pricingVersion: string
  sandboxPolicyVersion: string
  fixtureVersion: string
  holdoutVersion: string
}): Promise<QualificationManifest> {
  const sourceCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
  const qualificationId = 'v018-qualification-v1'
  const manifestContent = [
    qualificationId,
    sourceCommit,
    params.repairControllerVersion,
    params.repairRuntimeVersion,
    String(params.eventSchemaVersion),
    params.pricingVersion,
    params.sandboxPolicyVersion,
    params.fixtureVersion,
    params.holdoutVersion,
  ].join(':')
  const manifestHash = createHash('sha256').update(manifestContent).digest('hex').slice(0, 16)
  return {
    qualificationId,
    sourceCommit,
    repairControllerVersion: params.repairControllerVersion,
    repairRuntimeVersion: params.repairRuntimeVersion,
    eventSchemaVersion: params.eventSchemaVersion,
    pricingVersion: params.pricingVersion,
    sandboxPolicyVersion: params.sandboxPolicyVersion,
    fixtureVersion: params.fixtureVersion,
    holdoutVersion: params.holdoutVersion,
    manifestHash,
  }
}

/**
 * Verify a manifest is internally consistent and matches expected values.
 * @returns array of violation strings; empty means valid.
 */
export function verifyManifest(
  manifest: QualificationManifest,
  expected: Partial<QualificationManifest>,
): string[] {
  const violations: string[] = []
  for (const key of Object.keys(expected) as Array<keyof QualificationManifest>) {
    if (expected[key] !== undefined && manifest[key] !== expected[key]) {
      violations.push(`${key}: expected ${expected[key]}, got ${manifest[key]}`)
    }
  }
  // Verify manifest hash is deterministic
  const recomputed = createHash('sha256')
    .update([
      manifest.qualificationId,
      manifest.sourceCommit,
      manifest.repairControllerVersion,
      manifest.repairRuntimeVersion,
      String(manifest.eventSchemaVersion),
      manifest.pricingVersion,
      manifest.sandboxPolicyVersion,
      manifest.fixtureVersion,
      manifest.holdoutVersion,
    ].join(':'))
    .digest('hex')
    .slice(0, 16)
  if (recomputed !== manifest.manifestHash) {
    violations.push('manifestHash: tampered or stale')
  }
  return violations
}

// ---------------------------------------------------------------------------
// E22: Repository gate
// ---------------------------------------------------------------------------

/** One prerequisite check result. */
export interface PrerequisiteCheck {
  readonly name: string
  readonly passed: boolean
  readonly detail: string
}

/** Run the repository-clean check. */
export function checkRepoClean(): PrerequisiteCheck {
  try {
    const status = execSync('git status --porcelain', { encoding: 'utf8' }).trim()
    if (status === '') {
      return { name: 'repository-clean', passed: true, detail: 'no uncommitted changes' }
    }
    return {
      name: 'repository-clean',
      passed: false,
      detail: `${status.split('\n').length} uncommitted change(s)`,
    }
  } catch (error) {
    return {
      name: 'repository-clean',
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Run typecheck. */
export function checkTypecheck(): PrerequisiteCheck {
  try {
    execSync('pnpm run typecheck', { encoding: 'utf8', stdio: 'pipe' })
    return { name: 'typecheck', passed: true, detail: 'passed' }
  } catch (error) {
    return {
      name: 'typecheck',
      passed: false,
      detail: error instanceof Error ? error.message.slice(0, 200) : 'failed',
    }
  }
}

/** Run repair controller tests. */
export function checkRepairTests(): PrerequisiteCheck {
  try {
    execSync('npx vitest run packages/core/repair-controller/tests/ packages/core/repair-runtime/tests/', {
      encoding: 'utf8',
      stdio: 'pipe',
    })
    return { name: 'repair-tests', passed: true, detail: 'passed' }
  } catch (error) {
    return {
      name: 'repair-tests',
      passed: false,
      detail: error instanceof Error ? error.message.slice(0, 200) : 'failed',
    }
  }
}

// ---------------------------------------------------------------------------
// E25: Manual model authority
// ---------------------------------------------------------------------------

/**
 * Determine the effective model given manual selection and repair policy.
 * Manual selection takes priority over the durable authority and the
 * heuristic router. The repair controller may still escalate from a
 * manually selected Flash model to Pro after repeated failures.
 *
 * @param manualModel - the user's manual model selection, if any.
 * @param durableModel - the durable authority model, if any.
 * @param heuristicModel - the heuristic router's model.
 * @returns the effective model and its source.
 */
export function resolveEffectiveModel(
  manualModel: string | undefined,
  durableModel: string | undefined,
  heuristicModel: string,
): { model: string; source: 'manual' | 'durable' | 'heuristic' } {
  if (manualModel !== undefined) {
    return { model: manualModel, source: 'manual' }
  }
  if (durableModel !== undefined) {
    return { model: durableModel, source: 'durable' }
  }
  return { model: heuristicModel, source: 'heuristic' }
}

// ---------------------------------------------------------------------------
// F29: API preflight smoke and prerequisite summary
// ---------------------------------------------------------------------------

/** Result of a single API smoke call. */
export interface SmokeResult {
  readonly model: string
  readonly httpOk: boolean
  readonly hasAssistantOutput: boolean
  readonly hasUsage: boolean
  readonly modelIdentity: string | undefined
  readonly requestId: string | undefined
  readonly detail: string
}

/**
 * Run the prerequisite summary gate. All checks must pass before
 * printing LIVE QUALIFICATION ENABLED.
 *
 * @param checks - prerequisite check results.
 * @returns true if all prerequisites pass.
 */
export function prerequisiteGate(checks: readonly PrerequisiteCheck[]): boolean {
  return checks.every(c => c.passed)
}

/**
 * Format the prerequisite summary for display.
 * @param checks - prerequisite check results.
 * @returns formatted summary string.
 */
export function formatPrerequisiteSummary(checks: readonly PrerequisiteCheck[]): string {
  const lines: string[] = ['Prerequisite Summary:', '-' .repeat(40)]
  for (const check of checks) {
    const status = check.passed ? 'PASS' : 'FAIL'
    lines.push(`  [${status}] ${check.name}: ${check.detail}`)
  }
  lines.push('-'.repeat(40))
  const allPassed = prerequisiteGate(checks)
  if (allPassed) {
    lines.push('LIVE QUALIFICATION ENABLED')
  } else {
    lines.push('LIVE QUALIFICATION BLOCKED')
  }
  return lines.join('\n')
}

/**
 * Determine whether to proceed with live qualification based on
 * smoke results and prerequisite checks.
 *
 * @param smokeResults - API smoke test results.
 * @param prerequisites - prerequisite check results.
 * @returns true if live qualification should proceed.
 */
export function shouldProceedWithLiveQualification(
  smokeResults: readonly SmokeResult[],
  prerequisites: readonly PrerequisiteCheck[],
): boolean {
  const allPrereqsPass = prerequisiteGate(prerequisites)
  const allSmokePass = smokeResults.every(s => s.httpOk && s.hasAssistantOutput && s.hasUsage)
  return allPrereqsPass && allSmokePass
}
