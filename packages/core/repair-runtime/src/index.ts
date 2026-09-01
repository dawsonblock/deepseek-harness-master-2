/**
 * Repair runtime plugin: hooks goal verification failure to the
 * {@link RepairControllerService} with durable event persistence. Opt-in via
 * cordis.yml config; does not change existing workflows when disabled.
 *
 * The plugin watches `goal/verification` session events. When verification
 * fails, it builds a {@link FailurePackage} from the verification checks,
 * calls `RepairController.decide()`, emits `repair/evidence` and
 * `repair/decision`, and either queues a repair followup message (with
 * failure evidence for the model) or blocks the goal.
 *
 * Repair model selection goes through the durable routing authority: before
 * calling `agent.followup()`, the plugin claims a `policy`-authority model
 * selection so the router creates a real `model/routing-decision` event. The
 * `model/escalation` event is emitted after that real routing decision
 * arrives, referencing its actual `routingDecisionId` as
 * `toRoutingDecisionId`. On completion or stop, the plugin emits
 * `repair/completed` with task-level accounting and releases the model
 * selection back to automatic routing.
 *
 * @module @deepseek-ai/dsh-repair-runtime
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { claimModelSelection, reconstructSelectionState, releaseToAuto } from '@deepseek-ai/dsh-agent'
import type { GoalRef, GoalVerificationCheck, GoalView } from '@deepseek-ai/dsh-goal'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { BuildErrorDetail, EscalationReason, FailurePackage, ModelRef, ProgressClass, RepairAttempt, RepairDecision, RepairDecisionInput, RepairLimits, RepairOutcome, TestFailureDetail } from '@deepseek-ai/dsh-repair-controller'
import { classifyProgress, computeFailureFingerprint, computeFailurePackageId, decideRepair } from '@deepseek-ai/dsh-repair-controller'
// Import the events module to trigger declaration merging for repair/* and model/escalation events.
import '@deepseek-ai/dsh-repair-controller/events'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { calculateCost, DEFAULT_PRICING_REGISTRY, lookupPricingAt } from '@deepseek-ai/dsh-token-meter'
import type { ModelPricing } from '@deepseek-ai/dsh-token-meter'

/** Plugin configuration. */
export interface RepairRuntimeConfig {
  /** Whether the repair loop is enabled. Default: false. */
  enabled: boolean
  /** The Flash model ref for repair attempts. Required when enabled. */
  flashModel?: { provider: string; model: string }
  /** The Pro model ref for escalation. Required when enabled. */
  proModel?: { provider: string; model: string }
  /** Max Flash attempts. Default: 3. */
  maxFlashAttempts?: number
  /** Max Pro attempts. Default: 2. */
  maxProAttempts?: number
  /** Max total attempts. Default: 5. */
  maxTotalAttempts?: number
  /** Maximum cumulative cost per task in USD. When exceeded, the controller stops with `cost-limit`. */
  maxTaskCostUsd?: number
  /** Maximum elapsed time per task in milliseconds. When exceeded, the controller stops with `time-limit`. */
  maxElapsedMs?: number
  /** Maximum output tokens per task. Reserved for future token-budget enforcement. */
  maxOutputTokens?: number
  /**
   * Whether the Pro model is available for escalation. When false, the
   * controller stops with `escalation-model-unavailable` instead of
   * escalating. Default: true. Set to false when the Pro model is
   * unconfigured, rate-limited, or otherwise unreachable.
   */
  proModelAvailable?: boolean
  /**
   * Optional qualification holdout verifier. When present, runs after
   * diagnostic verification passes. A holdout failure emits
   * `repair/completed` with `verified: false` and `qualificationFailure: true`
   * but does NOT trigger another repair attempt. A holdout pass proceeds to
   * normal completion.
   */
  holdoutVerifier?: HoldoutVerifier
  /**
   * Optional workspace provenance provider. When present, called before each
   * `repair/evidence` emission to compute a SHA-256 hash of the workspace
   * file contents. The hash is stored in the durable event and on the
   * `RepairAttempt`, enabling replay to verify workspace state consistency.
   */
  workspaceProvenanceProvider?: WorkspaceProvenanceProvider
  /**
   * Optional workspace rollback provider. When present, called before each
   * repair attempt to restore the workspace to a known checkpoint. The
   * rollback is recorded as a durable `repair/rollback` event so replay can
   * verify the workspace was restored by the harness, not by the model.
   */
  rollbackProvider?: RollbackProvider
  /**
   * Optional changed-files provider. When present, called to compute the
   * actual set of files changed in the current turn by diffing the workspace
   * against a known baseline, rather than inferring changes from tool-call
   * event names. When absent, falls back to tool-observation inference.
   */
  changedFilesProvider?: ChangedFilesProvider
  /**
   * Whether to throw on missing `model/usage` events for paid routing
   * decisions. When true, a paid request without usage evidence is a
   * control-plane failure rather than a zero-cost attempt. Production
   * qualification enables this; unit tests may disable it. Default: false.
   */
  failOnMissingUsage?: boolean
}

/**
 * Computes the set of files changed in the current turn by diffing the
 * workspace against a known baseline. Replaces tool-observation inference
 * with real filesystem state, catching changes made by shell commands,
 * build tools, and other non-tool paths.
 */
export type ChangedFilesProvider = () => readonly string[]

/** Context passed to a workspace provenance provider. */
export interface WorkspaceProvenanceContext {
  /** The session being repaired. */
  readonly session: Session
  /** File paths changed in the current turn. */
  readonly changedFiles: readonly string[]
}

/**
 * Computes a SHA-256 hash binding repair evidence to the workspace state
 * that produced it. The hash should cover the content of the changed files
 * at the time of verification, so replay after restart can detect workspace
 * divergence. Must return synchronously — async provenance computation is
 * not supported in the synchronous repair handler.
 */
export type WorkspaceProvenanceProvider = (context: WorkspaceProvenanceContext) => string

/** Context passed to a rollback provider. */
export interface RollbackContext {
  /** The session being repaired. */
  readonly session: Session
  /** The repair id for this repair sequence. */
  readonly repairId: string
  /** The failed attempt number whose changes should be rolled back. */
  readonly attempt: number
  /** The routing decision of the failed attempt. */
  readonly routingDecisionId: string
  /** Workspace hash of the failed attempt, when provenance is tracked. */
  readonly workspaceHash?: string
}

/** Result of a rollback operation. */
export interface RollbackResult {
  /** Whether the rollback succeeded. */
  readonly success: boolean
  /** The workspace hash or checkpoint identifier restored. */
  readonly rollbackTarget: string
  /** Human-readable reason when rollback failed. */
  readonly failureReason?: string
  /** The expected baseline hash that rollback should restore. */
  readonly targetHash?: string
  /** The actual workspace hash after rollback. Must match `targetHash` for success. */
  readonly resultHash?: string
}

/**
 * Harness-owned workspace rollback provider. Called before each repair
 * attempt to restore the workspace to a known checkpoint. The rollback is
 * recorded as a durable `repair/rollback` event so replay can verify the
 * harness performed the restoration, not the model. Must return
 * synchronously — async rollback is not supported in the synchronous
 * repair handler.
 */
export type RollbackProvider = (context: RollbackContext) => RollbackResult

/** Context passed to a holdout verifier. */
export interface HoldoutVerifierContext {
  /** The session being verified. */
  readonly session: Session
  /** The repair state for this goal. */
  readonly state: RepairState
  /** The routing decision that produced the passing diagnostic verification. */
  readonly routingDecisionId: string
  /** The goal id being verified. */
  readonly goalId: string
}

/** Result of a holdout verification check. */
export interface HoldoutVerifierResult {
  /** Whether the holdout verification passed. */
  readonly passed: boolean
  /** Human-readable reason for the result. */
  readonly reason: string
  /** Optional evidence lines for the durable event. */
  readonly evidence?: readonly string[]
}

/**
 * Independent qualification verifier that runs after diagnostic verification
 * passes. Holdout failures never trigger repair — they report qualification
 * failure and stop the repair loop.
 */
export type HoldoutVerifier = (context: HoldoutVerifierContext) => HoldoutVerifierResult | Promise<HoldoutVerifierResult>

/** Per-goal repair state. */
export interface RepairState {
  repairId: string
  attempts: RepairAttempt[]
  totalCostUsd: number
  elapsedMs: number
  startedAt: number
  flashAttempts: number
  proAttempts: number
  /** Cumulative output tokens across all attempts, from model/usage events. */
  totalOutputTokens: number
}

/**
 * Deterministic repair identity, stable across crash/restart. Derived from
 * the stable execution identity of the originating routing decision, not from
 * wall-clock time. The `repair:v1:` prefix prevents future identifier schemes
 * from colliding with this one.
 * @param sessionId - the session id.
 * @param goalId - the goal id.
 * @param goalRevision - the goal revision.
 * @param originatingRoutingDecisionId - the routing decision that started this goal's turn.
 * @returns a deterministic repair id of the form `repair:v1:<hex>`.
 */
export function computeRepairId(
  sessionId: string,
  goalId: string,
  goalRevision: number,
  originatingRoutingDecisionId: string,
): string {
  return `repair:v1:${createHash('sha256')
    .update(`${sessionId}:${goalId}:${goalRevision}:${originatingRoutingDecisionId}`)
    .digest('hex')
    .slice(0, 24)}`
}

/** Pending Pro escalation awaiting a real routing decision to reference. */
export interface PendingEscalation {
  repairId: string
  fromRoutingDecisionId: string
  fromModel: string
  toModel: string
  reason: EscalationReason
  failureFingerprint: string
  flashAttempts: number
  turn: number
}

/** Build a FailurePackage from verification checks. */
function buildFailurePackage(checks: readonly GoalVerificationCheck[], changedFiles: readonly string[]): FailurePackage {
  const failedCriteria = checks
    .filter(check => check.role === 'acceptance' && !check.passed)
    .flatMap(check => check.evidence !== undefined && check.evidence.length > 0
      ? [check.reason, ...check.evidence]
      : [check.reason])
  const failingTests = checks
    .filter(check => check.name.includes('test'))
    .filter(check => !check.passed)
    .flatMap(check => check.evidence !== undefined && check.evidence.length > 0
      ? [check.reason, ...check.evidence]
      : [check.reason])
  const typeErrors = checks
    .filter(check => check.name.includes('type'))
    .filter(check => !check.passed)
    .flatMap(check => check.evidence ?? [check.reason])
  const buildErrors = checks
    .filter(check => check.name.includes('build'))
    .filter(check => !check.passed)
    .flatMap(check => check.evidence ?? [check.reason])

  // For diagnostic verifiers whose name does not contain 'test', 'type',
  // or 'build' (e.g. 'v019-diagnostic'), classify the failure using the
  // evidence content. This ensures captured stdout/stderr reaches the
  // model-visible failure arrays rather than being discarded.
  const unclassifiedChecks = checks.filter(check =>
    !check.passed
    && !check.name.includes('test')
    && !check.name.includes('type')
    && !check.name.includes('build'),
  )
  for (const check of unclassifiedChecks) {
    const evidence = check.evidence ?? []
    const combined = evidence.join('\n')
    if (/test|vitest|jest|mocha|pytest/i.test(combined)) {
      failingTests.push(check.reason, ...evidence)
    } else if (/error TS\d|tsc|type error|typeError/i.test(combined)) {
      typeErrors.push(...evidence.length > 0 ? evidence : [check.reason])
    } else if (/build failed|npm run build|webpack|vite build|cargo build|make:/i.test(combined)) {
      buildErrors.push(...evidence.length > 0 ? evidence : [check.reason])
    }
  }

  // Extract structured test failure details: test names, assertion diffs, exit codes.
  const testDetails: TestFailureDetail[] = checks
    .filter(check => !check.passed)
    .map(check => ({
      testName: check.name,
      ...check.evidence !== undefined && check.evidence.length > 0
        ? { assertionDiff: check.evidence.join('\n') }
        : {},
      ...check.reason.length > 0 ? { assertionDiff: check.reason } : {},
    }))

  // Extract structured build/type error details: file paths, line numbers, exit codes.
  const buildDetails: BuildErrorDetail[] = checks
    .filter(check => !check.passed)
    .map((check) => {
      const evidence = (check.evidence ?? [check.reason]).join('\n')
      // Parse file:line patterns from the evidence.
      const fileMatch = evidence.match(/([^\s]+\.(?:ts|js|tsx|jsx|json|py|rs|go|java)):(\d+)/)
      return {
        message: check.reason,
        ...fileMatch !== null ? { file: fileMatch[1], line: Number(fileMatch[2]) } : {},
      }
    })

  // Extract diagnostic kind from evidence lines like "Kind: test".
  const allEvidence = checks
    .filter(check => !check.passed)
    .flatMap(check => check.evidence ?? [])
  const kindMatch = allEvidence.find(e => /^Kind: (test|typecheck|build|lint)$/.test(e))
  const failedKind = kindMatch !== undefined ? kindMatch.replace(/^Kind: /, '') : undefined
  const exitCodeMatch = allEvidence.find(e => /^ExitCode: \d+$/.test(e))
  const diagnosticExitCode = exitCodeMatch !== undefined ? Number(exitCodeMatch.replace(/^ExitCode: /, '')) : undefined

  return {
    failedCriteria,
    failingTests,
    typeErrors,
    buildErrors,
    changedFiles,
    ...testDetails.length > 0 ? { testDetails } : {},
    ...buildDetails.length > 0 ? { buildDetails } : {},
    ...failedKind !== undefined ? { failedKind } : {},
    ...diagnosticExitCode !== undefined ? { diagnosticExitCode } : {},
  }
}

/**
 * Immutable, sanitized projection of a {@link FailurePackage} for model
 * consumption. Contains only model-relevant failure evidence — no internal
 * harness metadata (repair IDs, routing decision IDs, fingerprints, session
 * IDs). The projection is frozen so the model-visible representation cannot
 * be accidentally mutated by the caller.
 */
export interface ModelVisibleFailureProjection {
  /** Failed acceptance criteria, sanitized to human-readable strings. */
  readonly failedCriteria: readonly string[]
  /** Failing test descriptions, sanitized to human-readable strings. */
  readonly failingTests: readonly string[]
  /** Type error messages, sanitized to human-readable strings. */
  readonly typeErrors: readonly string[]
  /** Build error messages, sanitized to human-readable strings. */
  readonly buildErrors: readonly string[]
  /** Changed file paths, sanitized to human-readable strings. */
  readonly changedFiles: readonly string[]
  /** Structured test failure details: test names, assertion diffs, exit codes. */
  readonly testDetails?: readonly TestFailureDetail[]
  /** Structured build/type error details: file paths, line numbers, exit codes. */
  readonly buildDetails?: readonly BuildErrorDetail[]
  /** Diagnostic exit code from the verification process. */
  readonly diagnosticExitCode?: number
  /** Diagnostic kind of the failing command (test/typecheck/build/lint). */
  readonly failedKind?: string
}

/**
 * Sanitize a single evidence string for model consumption. Strips internal
 * harness identifiers that may appear in verifier output (repair IDs,
 * routing decision IDs, session IDs) while preserving the diagnostic
 * content the model needs to repair.
 *
 * @param value - the raw evidence string from a verification check.
 * @returns the sanitized string with internal identifiers and secrets removed.
 */
function sanitizeEvidenceString(value: string): string {
  return value
    // Internal harness identifiers
    .replace(/repair:v1:[0-9a-f]+/g, '[repair-id]')
    .replace(/rd-[a-zA-Z0-9_-]+/g, '[routing-decision]')
    .replace(/session-[a-zA-Z0-9_-]+/g, '[session]')
    // Authorization headers and bearer tokens (case-insensitive)
    .replace(/authorization:\s*bearer\s+[a-z0-9._~+=/-]+/gi, 'Authorization: Bearer [redacted]')
    .replace(/authorization:\s*basic\s+[a-z0-9+/=]+/gi, 'Authorization: Basic [redacted]')
    // API key patterns (common formats: sk-..., DEEPSEEK_API_KEY=..., OPENAI_API_KEY=...)
    .replace(/\bsk-[a-z0-9]{20,}\b/gi, '[api-key]')
    .replace(/\b(DEEPSEEK|OPENAI|ANTHROPIC|GEMINI|GOOGLE|AZURE)_API_KEY\s*=\s*[a-z0-9._~+=/-]+/gi, '$1_API_KEY=[redacted]')
    .replace(/\b[A-Z_]*API_KEY\s*=\s*[a-z0-9._~+=/-]+/gi, '[api-key]=[redacted]')
    // Password assignments in connection strings and env vars
    .replace(/password\s*=\s*[^\s;,)]+/gi, 'password=[redacted]')
    .replace(/passwd\s*=\s*[^\s;,)]+/gi, 'passwd=[redacted]')
    .replace(/pwd\s*=\s*[^\s;,)]+/gi, 'pwd=[redacted]')
    // Database URLs with credentials (postgres://, mysql://, mongodb://, redis://)
    .replace(/(postgres|postgresql|mysql|mongodb|redis|amqp|amqps):\/\/[^:\s]+:[^@\s]+@[^\s/]+/gi, '$1://[user]:[redacted]@[host]')
    .replace(/(https?):\/\/[^:\s]+:[^@\s]+@[^\s/]+/gi, '$1://[user]:[redacted]@[host]')
    // AWS credentials
    .replace(/\bAWS_ACCESS_KEY_ID\s*=\s*[A-Z0-9]{20}\b/g, 'AWS_ACCESS_KEY_ID=[redacted]')
    .replace(/\bAWS_SECRET_ACCESS_KEY\s*=\s*[A-Za-z0-9/+=]{40}\b/g, 'AWS_SECRET_ACCESS_KEY=[redacted]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[aws-access-key]')
    // Cookies and session tokens
    .replace(/cookie\s*:\s*[^\n\r]+/gi, 'Cookie: [redacted]')
    .replace(/set-cookie\s*:\s*[^\n\r]+/gi, 'Set-Cookie: [redacted]')
    .replace(/\bsession[_-]?token\s*=\s*[a-z0-9._~+=/-]+/gi, 'session_token=[redacted]')
    .replace(/\bcsrf[_-]?token\s*=\s*[a-z0-9._~+=/-]+/gi, 'csrf_token=[redacted]')
    // JWT tokens
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[jwt]')
    // Private host paths (Unix home directories with private/secret/.ssh)
    .replace(/\/(?:Users|home)\/[^/\s]+\/\.ssh\/[^\s]+/g, '[ssh-path]')
    .replace(/\/(?:Users|home)\/[^/\s]+\/private\/[^\s]+/g, '[private-path]')
    .replace(/\/(?:Users|home)\/[^/\s]+\/\.env[^\s]*/g, '[env-file]')
    // Generic token/secret env assignments
    .replace(/\b(?:SECRET|TOKEN|PRIVATE_KEY|ACCESS_TOKEN|REFRESH_TOKEN)\s*=\s*[a-z0-9._~+=/-]+/gi, '[secret]=[redacted]')
    .trim()
}

/**
 * Create an immutable, sanitized projection of a {@link FailurePackage}
 * for model consumption. The returned object is frozen and contains only
 * model-relevant evidence with internal harness identifiers stripped.
 *
 * @param failure - the raw failure package from verification.
 * @returns a frozen, sanitized projection safe for model prompts.
 */
export function projectFailureForModel(failure: FailurePackage): ModelVisibleFailureProjection {
  return Object.freeze({
    failedCriteria: Object.freeze(failure.failedCriteria.map(sanitizeEvidenceString)),
    failingTests: Object.freeze(failure.failingTests.map(sanitizeEvidenceString)),
    typeErrors: Object.freeze(failure.typeErrors.map(sanitizeEvidenceString)),
    buildErrors: Object.freeze(failure.buildErrors.map(sanitizeEvidenceString)),
    changedFiles: Object.freeze([...failure.changedFiles]),
    ...failure.testDetails !== undefined ? {
      testDetails: Object.freeze(failure.testDetails.map(d => ({
        ...d,
        ...d.assertionDiff !== undefined ? { assertionDiff: sanitizeEvidenceString(d.assertionDiff) } : {},
      }))),
    } : {},
    ...failure.buildDetails !== undefined ? {
      buildDetails: Object.freeze(failure.buildDetails.map(d => ({
        ...d,
        ...d.message !== undefined ? { message: sanitizeEvidenceString(d.message) } : {},
      }))),
    } : {},
    ...failure.diagnosticExitCode !== undefined ? { diagnosticExitCode: failure.diagnosticExitCode } : {},
    ...failure.failedKind !== undefined ? { failedKind: failure.failedKind } : {},
  })
}

/** Render a repair prompt for the model from a sanitized failure projection. */
function renderRepairPrompt(projection: ModelVisibleFailureProjection, attempt: number, progress?: ProgressClass): ContentBlock[] {
  const sections: string[] = [`Repair attempt ${attempt}: the previous attempt failed verification.`]
  if (progress !== undefined && progress !== 'none') {
    sections.push(`Progress: ${progress} — the failure changed from the prior attempt.`)
  }
  if (projection.failedCriteria.length > 0) {
    sections.push('', 'Failed criteria:', ...projection.failedCriteria.map(c => `- ${c}`))
  }
  if (projection.failingTests.length > 0) {
    sections.push('', 'Failing tests:', ...projection.failingTests.map(t => `- ${t}`))
  }
  if (projection.testDetails !== undefined && projection.testDetails.length > 0) {
    sections.push('', 'Test details:')
    for (const d of projection.testDetails) {
      sections.push(`- ${d.testName}${d.assertionDiff !== undefined ? `: ${d.assertionDiff}` : ''}`)
    }
  }
  if (projection.typeErrors.length > 0) {
    sections.push('', 'Type errors:', ...projection.typeErrors.map(e => `- ${e}`))
  }
  if (projection.buildErrors.length > 0) {
    sections.push('', 'Build errors:', ...projection.buildErrors.map(e => `- ${e}`))
  }
  if (projection.buildDetails !== undefined && projection.buildDetails.length > 0) {
    sections.push('', 'Build details:')
    for (const d of projection.buildDetails) {
      sections.push(`- ${d.file}${d.line !== undefined ? `:${d.line}` : ''}${d.message !== undefined ? `: ${d.message}` : ''}`)
    }
  }
  if (projection.changedFiles.length > 0) {
    sections.push('', 'Files changed in the failed attempt:', ...projection.changedFiles.map(f => `- ${f}`))
  }
  sections.push('', 'Fix the issues above. The workspace has been rolled back to the trusted base state before this repair attempt. Start your fix from the base source, not from the failed attempt.')
  return [{ type: 'text', text: sections.join('\n') }]
}

/** Render a Pro escalation prompt with sanitized context. */
function renderProEscalationPrompt(
  projection: ModelVisibleFailureProjection,
  flashAttempts: number,
  progress?: ProgressClass,
): ContentBlock[] {
  const sections: string[] = [
    `Escalation from Flash after ${flashAttempts} failed attempt(s).`,
    'You are taking over a task that Flash could not complete.',
    'The workspace state from the previous attempts is preserved.',
  ]
  if (progress !== undefined && progress !== 'none') {
    sections.push(`Progress: ${progress} — the failure changed across attempts.`)
  }
  if (projection.failedCriteria.length > 0) {
    sections.push('', 'Failed criteria:', ...projection.failedCriteria.map(c => `- ${c}`))
  }
  if (projection.failingTests.length > 0) {
    sections.push('', 'Failing tests:', ...projection.failingTests.map(t => `- ${t}`))
  }
  if (projection.testDetails !== undefined && projection.testDetails.length > 0) {
    sections.push('', 'Test details:')
    for (const d of projection.testDetails) {
      sections.push(`- ${d.testName}${d.assertionDiff !== undefined ? `: ${d.assertionDiff}` : ''}`)
    }
  }
  if (projection.typeErrors.length > 0) {
    sections.push('', 'Type errors:', ...projection.typeErrors.map(e => `- ${e}`))
  }
  if (projection.buildErrors.length > 0) {
    sections.push('', 'Build errors:', ...projection.buildErrors.map(e => `- ${e}`))
  }
  if (projection.buildDetails !== undefined && projection.buildDetails.length > 0) {
    sections.push('', 'Build details:')
    for (const d of projection.buildDetails) {
      sections.push(`- ${d.file}${d.line !== undefined ? `:${d.line}` : ''}${d.message !== undefined ? `: ${d.message}` : ''}`)
    }
  }
  if (projection.changedFiles.length > 0) {
    sections.push('', 'Files changed in the failed attempt:', ...projection.changedFiles.map(f => `- ${f}`))
  }
  sections.push('', 'Repair the work. You may rewrite the previous attempts\' changes or start fresh.')
  return [{ type: 'text', text: sections.join('\n') }]
}

/** Extract the model ref from a routing decision event. */
function modelFromRoutingDecision(events: readonly SessionEvent[], routingDecisionId: string): ModelRef | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event === undefined) continue
    if ((event.type as string) === 'model/routing-decision') {
      const data = event.data as unknown as { routingDecisionId?: string; selected: { provider: string; model: string } }
      if (data.routingDecisionId === routingDecisionId) {
        return { provider: data.selected.provider, model: data.selected.model }
      }
    }
  }
  return undefined
}

/**
 * Resolved model-selection authority for a session, reconstructed from the
 * durable `model/selection-authority` event log. Used to determine whether
 * the repair runtime may transition the model.
 *
 * - `manual`: the latest durable state is a deliberate claim. The controller
 *   does not escalate to a different model unless policy requires it.
 * - `automatic`: the latest durable state is router/default-owned. The
 *   controller may escalate normally.
 * - `absent`: no selection-authority event exists. Treated as automatic.
 * - `undecidable`: a future-schema or uninterpretable authority record
 *   exists. The repair runtime MUST fail closed: no model transition occurs.
 */
export type SelectionAuthorityResolution =
  | { readonly kind: 'manual' }
  | { readonly kind: 'automatic' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'undecidable' }

/**
 * Resolve the current model-selection authority for a session from the
 * durable `model/selection-authority` event log. Follows the fail-closed
 * principle from v0.15 authority work: a future-schema or uninterpretable
 * authority record produces `undecidable`, not `automatic`.
 *
 * @param events - the full session event log.
 * @returns the resolved authority kind.
 */
export function resolveSelectionAuthority(events: readonly SessionEvent[]): SelectionAuthorityResolution {
  const state = reconstructSelectionState(events)
  if (state === undefined) return { kind: 'absent' }
  if ('undecidable' in state) return { kind: 'undecidable' }
  return state.mode === 'manual' ? { kind: 'manual' } : { kind: 'automatic' }
}

/** Find the latest routing decision id for a turn. */
function latestRoutingDecisionId(events: readonly SessionEvent[], turn: number): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event === undefined) continue
    if ((event.type as string) === 'model/routing-decision') {
      const data = event.data as unknown as { turn?: number; routingDecisionId?: string }
      if (data.turn === turn && data.routingDecisionId !== undefined) {
        return data.routingDecisionId
      }
    }
  }
  return undefined
}

/** Find the first routing decision id for a turn. The first routing decision
 * establishes the model that started the attempt; a mid-turn escalation to a
 * heavier model is a routing feature, not a repair escalation, so repair
 * counters must attribute the attempt to the starting model. */
function firstRoutingDecisionId(events: readonly SessionEvent[], turn: number): string | undefined {
  for (const event of events) {
    if ((event.type as string) !== 'model/routing-decision') continue
    const data = event.data as unknown as { turn?: number; routingDecisionId?: string }
    if (data.turn === turn && data.routingDecisionId !== undefined) {
      return data.routingDecisionId
    }
  }
  return undefined
}

/** Derive the current turn number from the session log. Prefers the latest
 * turn/start event; falls back to the latest model/routing-decision's turn
 * field so repair works when the agent-loop has not yet opened a turn (e.g.
 * qualification fixtures that emit routing decisions without a turn/start). */
function currentTurn(events: readonly SessionEvent[]): number {
  let fromTurnStart = 0
  let fromRouting = 0
  for (const event of events) {
    if (event.type === 'turn/start') {
      fromTurnStart = Math.max(fromTurnStart, event.data.turn)
    }
    if ((event.type as string) === 'model/routing-decision') {
      const data = event.data as unknown as { turn?: number }
      if (typeof data.turn === 'number') {
        fromRouting = Math.max(fromRouting, data.turn)
      }
    }
  }
  return Math.max(fromTurnStart, fromRouting)
}

/**
 * Result of validating repair event ordering and idempotency for one repair
 * sequence. Used to detect duplicate or out-of-order events during replay.
 */
export interface RepairEventInvariantResult {
  /** Whether all invariants hold. */
  readonly valid: boolean
  /** Human-readable descriptions of each violation, when any. */
  readonly violations: readonly string[]
}

/**
 * Validate repair event ordering and idempotency for one repair sequence.
 * Checks that:
 *
 * 1. Each `repair/evidence` event has a unique `failurePackageId` within the
 *    sequence (no duplicate evidence for the same attempt).
 * 2. Each `repair/decision` event references a unique attempt number (no
 *    duplicate decisions for the same attempt).
 * 3. `repair/evidence` for attempt N appears before `repair/decision` for
 *    attempt N (evidence precedes decision).
 * 4. At most one `repair/completed` event exists per repair sequence.
 * 5. `repair/completed` appears after all evidence and decision events.
 * 6. `repair/rollback` events reference attempts that have evidence.
 *
 * @param events - the full session event log.
 * @param repairId - the repair sequence to validate.
 * @returns the validation result with any violations.
 */
export function validateRepairEventInvariants(
  events: readonly SessionEvent[],
  repairId: string,
): RepairEventInvariantResult {
  const violations: string[] = []
  const evidenceAttempts = new Set<number>()
  const evidencePackageIds = new Set<string>()
  const decisionAttempts = new Set<number>()
  let completedCount = 0
  let lastDecisionSeq = -1
  let completedSeq = -1

  for (const event of events) {
    const type = event.type as string
    if (type !== 'repair/evidence'
      && type !== 'repair/decision'
      && type !== 'repair/completed'
      && type !== 'repair/rollback') continue
    const data = event.data as Record<string, unknown>
    if (data.repairId !== repairId) continue

    if (type === 'repair/evidence') {
      const attempt = data.attempt as number
      const packageId = data.failurePackageId as string
      if (evidenceAttempts.has(attempt)) {
        violations.push(`duplicate repair/evidence for attempt ${attempt}`)
      }
      evidenceAttempts.add(attempt)
      if (typeof packageId === 'string') {
        if (evidencePackageIds.has(packageId)) {
          violations.push(`duplicate failurePackageId "${packageId}"`)
        }
        evidencePackageIds.add(packageId)
      }
    } else if (type === 'repair/decision') {
      const attempt = data.attempt as number
      if (decisionAttempts.has(attempt)) {
        violations.push(`duplicate repair/decision for attempt ${attempt}`)
      }
      decisionAttempts.add(attempt)
      lastDecisionSeq = event.seq
      // Evidence must precede decision for the same attempt
      if (!evidenceAttempts.has(attempt)) {
        violations.push(`repair/decision for attempt ${attempt} without preceding repair/evidence`)
      }
    } else if (type === 'repair/completed') {
      completedCount += 1
      completedSeq = event.seq
    } else {
      // repair/rollback: must reference an attempt that has evidence
      const attempt = data.attempt as number
      if (!evidenceAttempts.has(attempt)) {
        violations.push(`repair/rollback for attempt ${attempt} without preceding repair/evidence`)
      }
    }
  }

  if (completedCount > 1) {
    violations.push(`multiple repair/completed events (${completedCount})`)
  }
  if (completedCount === 1 && completedSeq < lastDecisionSeq) {
    violations.push('repair/completed appears before a repair/decision event')
  }

  return { valid: violations.length === 0, violations }
}

/**
 * Count provider invocations (model/usage events) for a specific routing
 * decision. Used to prove side-effect idempotency: after crash and restart,
 * each logical attempt must have at most one provider invocation.
 *
 * @param events - the full session event log.
 * @param routingDecisionId - the routing decision to count invocations for.
 * @returns the number of model/usage events referencing this routing decision.
 */
export function countProviderInvocations(
  events: readonly SessionEvent[],
  routingDecisionId: string,
): number {
  let count = 0
  for (const event of events) {
    if ((event.type as string) !== 'model/usage') continue
    const data = event.data as { routingDecisionId?: string }
    if (data.routingDecisionId === routingDecisionId) count += 1
  }
  return count
}

/**
 * Check whether a repair decision has been consumed — i.e., whether a
 * subsequent `model/routing-decision` event exists for the repair followup.
 * Used during crash recovery to distinguish "decision recorded but request
 * not issued" from "request already issued."
 *
 * @param events - the full session event log.
 * @param repairId - the repair sequence.
 * @param attemptNumber - the attempt number of the decision.
 * @returns true if a routing decision exists after the repair/decision for this attempt.
 */
export function isRepairDecisionConsumed(
  events: readonly SessionEvent[],
  repairId: string,
  attemptNumber: number,
): boolean {
  // Find the repair/decision event for this attempt
  let decisionSeq = -1
  for (const event of events) {
    if ((event.type as string) !== 'repair/decision') continue
    const data = event.data as { repairId?: string; attempt?: number }
    if (data.repairId === repairId && data.attempt === attemptNumber) {
      decisionSeq = event.seq
      break
    }
  }
  if (decisionSeq < 0) return false

  // Check if any model/routing-decision event exists after the decision
  for (const event of events) {
    if (event.seq <= decisionSeq) continue
    if ((event.type as string) === 'model/routing-decision') return true
  }
  return false
}

/** Find changed files from tool calls in the current turn. */
function changedFilesInTurn(events: readonly SessionEvent[], turn: number): string[] {
  const files: string[] = []
  for (const event of events) {
    if (event.type === 'tool/call' && (event.data as { turn?: number }).turn === turn) {
      const data = event.data as { name: string; arguments: string }
      if (data.name === 'write_file' || data.name === 'edit_file' || data.name === 'str_replace_editor') {
        try {
          const args = JSON.parse(data.arguments) as { file_path?: string; path?: string }
          const path = args.file_path ?? args.path
          if (path !== undefined) files.push(path)
        } catch {
          /* ignore unparseable args */
        }
      }
    }
  }
  return [...new Set(files)]
}

/**
 * Compute the cost and latency for one attempt from the durable `model/usage`
 * event matching the routing decision. Cost is derived from `TokenUsage` +
 * `ModelPricing` via the canonical token-meter pricing registry. Latency is
 * the wall-clock difference between the `model/routing-decision` event and
 * the `model/usage` event.
 *
 * When no `model/usage` event exists (e.g. the provider returned no usage
 * data), cost and latency are zero — the attempt is still counted, just
 * unpriced. When a `model/usage` event exists but the model has no pricing
 * entry, the behavior depends on `failOnUnpriced`: when true, the function
 * throws `UNPRICED_USAGE`; when false (default), the cost is zero.
 *
 * @param events - the full session event log.
 * @param routingDecisionId - the routing decision for this attempt.
 * @param pricingRegistry - the pricing registry for cost lookup.
 * @param failOnUnpriced - when true, throw on unpriced usage instead of returning $0.
 * @returns the cost in USD and latency in milliseconds.
 */
export function computeAttemptAccounting(
  events: readonly SessionEvent[],
  routingDecisionId: string,
  pricingRegistry: readonly ModelPricing[] = DEFAULT_PRICING_REGISTRY,
  failOnUnpriced = false,
  failOnMissingUsage = false,
): { costUsd: number; latencyMs: number; outputTokens: number } {
  let routingTime: number | undefined
  let lastUsageTime: number | undefined
  let costUsd = 0
  let outputTokens = 0
  let usageFound = false
  let failureFound = false

  for (const event of events) {
    if ((event.type as string) === 'model/routing-decision') {
      const data = event.data as { routingDecisionId?: string }
      if (data.routingDecisionId === routingDecisionId) {
        routingTime = event.time
      }
    }
    if (event.type === 'model/usage') {
      const data = event.data as {
        routingDecisionId?: string
        turn: number
        provider: string
        model: string
        usage: import('@deepseek-ai/dsh-llm').TokenUsage
      }
      // Sum all usage events for this routing decision. A logical attempt
      // can contain multiple provider calls (e.g. Flash then Pro mid-turn),
      // each with its own usage event. Breaking after the first undercounts
      // cost, tokens, and latency.
      if (data.routingDecisionId === routingDecisionId) {
        usageFound = true
        lastUsageTime = event.time
        outputTokens += data.usage.outputTokens
        const pricing = lookupPricingAt(
          pricingRegistry,
          data.provider,
          data.model,
          new Date(event.time),
        )
        if (pricing !== undefined) {
          costUsd += calculateCost(data.usage, pricing).amount
        } else if (failOnUnpriced) {
          throw new Error(`UNPRICED_USAGE: no pricing found for model ${data.provider}/${data.model}`)
        }
      }
    }
    if ((event.type as string) === 'model/request-outcome') {
      const data = event.data as { routingDecisionId?: string; outcome: string; usage?: import('@deepseek-ai/dsh-llm').TokenUsage }
      if (data.routingDecisionId === routingDecisionId && (data.outcome === 'error' || data.outcome === 'aborted')) {
        failureFound = true
      }
    }
  }

  if (failOnMissingUsage && !usageFound && !failureFound) {
    throw new Error(`MISSING_USAGE: no model/usage or model/request-outcome(failure) event found for routingDecisionId ${routingDecisionId}`)
  }

  const latencyMs = routingTime !== undefined && lastUsageTime !== undefined
    ? Math.max(0, lastUsageTime - routingTime)
    : 0

  return { costUsd, latencyMs, outputTokens }
}

/**
 * Compute cumulative cost across all repair attempts for one goal from the
 * durable `model/usage` events. Used by `reconstructRepairState` to recover
 * real cost after restart.
 *
 * @param events - the full session event log.
 * @param routingDecisionIds - the routing decision IDs for each attempt.
 * @returns the total cost in USD.
 */
function computeTotalCost(
  events: readonly SessionEvent[],
  routingDecisionIds: readonly string[],
  pricingRegistry: readonly ModelPricing[] = DEFAULT_PRICING_REGISTRY,
): number {
  let total = 0
  for (const rdId of routingDecisionIds) {
    total += computeAttemptAccounting(events, rdId, pricingRegistry).costUsd
  }
  return total
}

/**
 * Compute cumulative output tokens across all repair attempts from the
 * durable `model/usage` events. Used by `reconstructRepairState` to recover
 * the output-token budget after restart.
 *
 * @param events - the full session event log.
 * @param routingDecisionIds - the routing decision IDs for each attempt.
 * @returns the total output tokens.
 */
function computeTotalOutputTokens(
  events: readonly SessionEvent[],
  routingDecisionIds: readonly string[],
): number {
  let total = 0
  for (const rdId of routingDecisionIds) {
    total += computeAttemptAccounting(events, rdId).outputTokens
  }
  return total
}

/**
 * Reconstruct repair state for one goal from the durable session log.
 *
 * Attempts are reconstructed from real execution events
 * (`model/routing-decision` → `model/request` → `goal/verification`),
 * not from repair decisions. Repair events (`repair/evidence`,
 * `repair/decision`, `model/escalation`) overlay as annotations: they
 * supply the `FailurePackage`, progress, and repair-attribution metadata
 * that the controller needs, but they never change an attempt's model or
 * routing identity. A later `pro-escalate` decision does not retroactively
 * convert a Flash attempt into Pro.
 *
 * Each reconstructed failed attempt carries its full `FailurePackage`,
 * restored from the `repair/evidence` event, so `classifyProgress` and
 * `computeProgressMetrics` produce identical results before and after
 * restart.
 *
 * @param events - the full session event log.
 * @param goalId - the goal id to reconstruct state for.
 * @param pricingRegistry - optional pricing registry for cost recovery. Defaults to {@link DEFAULT_PRICING_REGISTRY}.
 * @returns the reconstructed state, or undefined if no repair or repair completed.
 */
export function reconstructRepairState(
  events: readonly SessionEvent[],
  goalId: string,
  pricingRegistry: readonly ModelPricing[] = DEFAULT_PRICING_REGISTRY,
): RepairState | undefined {
  // Find the repairId for this goal by tracing execution events.
  // goal/verification events reference the goal; the preceding
  // model/routing-decision has the routingDecisionId; repair/evidence
  // events reference the same routingDecisionId and carry the repairId.
  // This works for both legacy timestamp-based IDs (which embed the
  // goalId) and deterministic `repair:v1:<hash>` IDs (which do not).
  const routingForGoal = new Set<string>()
  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    if (event === undefined) continue
    if (event.type !== 'goal/verification') continue
    const vData = event.data as { goal: { id: string } }
    if (vData.goal.id !== goalId) continue
    for (let j = i - 1; j >= 0; j--) {
      const prev = events[j]
      if (prev === undefined) break
      if ((prev.type as string) !== 'model/routing-decision') continue
      const rdData = prev.data as { routingDecisionId?: string }
      if (rdData.routingDecisionId !== undefined) {
        routingForGoal.add(rdData.routingDecisionId)
        break
      }
    }
  }

  let repairId: string | undefined
  for (const event of events) {
    if ((event.type as string) !== 'repair/evidence') continue
    const data = event.data as Record<string, unknown>
    if (typeof data.routingDecisionId === 'string' && routingForGoal.has(data.routingDecisionId)) {
      if (typeof data.repairId === 'string') {
        repairId = data.repairId
        break
      }
    }
  }

  if (repairId === undefined) return undefined

  let completed = false
  for (const event of events) {
    if ((event.type as string) !== 'repair/completed') continue
    const data = event.data as Record<string, unknown>
    if (data.repairId === repairId) {
      completed = true
      break
    }
  }
  if (completed) return undefined

  // Index repair/evidence events by routingDecisionId for full FailurePackage
  // reconstruction. Each evidence event carries the complete failure data.
  const evidenceByRouting = new Map<string, {
    attempt: number
    fingerprint: string
    progress: RepairAttempt['progress']
    failurePackage: FailurePackage
    failurePackageId: string
    workspaceHash?: string
  }>()
  for (const event of events) {
    if ((event.type as string) !== 'repair/evidence') continue
    const data = event.data as Record<string, unknown>
    if (data.repairId !== repairId) continue
    const routingDecisionId = data.routingDecisionId as string
    const failurePackage: FailurePackage = {
      failedCriteria: data.failedCriteria as string[],
      failingTests: data.failingTests as string[],
      typeErrors: data.typeErrors as string[],
      buildErrors: data.buildErrors as string[],
      changedFiles: data.changedFiles as string[],
    }
    evidenceByRouting.set(routingDecisionId, {
      attempt: data.attempt as number,
      fingerprint: data.failureFingerprint as string,
      progress: data.progress as RepairAttempt['progress'],
      failurePackage,
      failurePackageId: data.failurePackageId as string,
      ...data.workspaceHash !== undefined ? { workspaceHash: data.workspaceHash as string } : {},
    })
  }

  // Reconstruct attempts from real execution events. Each
  // model/routing-decision followed by a goal/verification FAIL is one
  // attempt. The model comes from the routing decision's `selected` field,
  // not from a later repair decision.
  const attempts: RepairAttempt[] = []
  let flashAttempts = 0
  let proAttempts = 0

  // Track repair/decision events to count flash/pro attempts.
  for (const event of events) {
    if ((event.type as string) !== 'repair/decision') continue
    const data = event.data as Record<string, unknown>
    if (data.repairId !== repairId) continue
    const action = data.action as string
    if (action === 'flash-repair') flashAttempts += 1
    if (action === 'pro-escalate') proAttempts += 1
  }

  // Build attempts from routing-decision + verification pairs.
  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    if (event === undefined) continue
    if ((event.type as string) !== 'model/routing-decision') continue
    const rdData = event.data as unknown as {
      routingDecisionId?: string
      selected: { provider: string; model: string }
    }
    const routingDecisionId = rdData.routingDecisionId
    if (routingDecisionId === undefined) continue

    // Find the goal/verification event that follows this routing decision.
    // It must be for the same goal and must be a FAIL to count as a repair
    // attempt.
    let verificationEvent: SessionEvent | undefined
    for (let j = i + 1; j < events.length; j++) {
      const next = events[j]
      if (next === undefined) break
      if ((next.type as string) === 'model/routing-decision') break
      if (next.type !== 'goal/verification') continue
      const vData = next.data as { goal: { id: string }; passed: boolean }
      if (vData.goal.id !== goalId) continue
      verificationEvent = next
      break
    }
    if (verificationEvent === undefined) continue
    const vData = verificationEvent.data as { passed: boolean }
    if (vData.passed) continue

    // This routing decision led to a failed verification for this goal.
    const model: ModelRef = {
      provider: rdData.selected.provider,
      model: rdData.selected.model,
    }
    const evidence = evidenceByRouting.get(routingDecisionId)
    if (evidence === undefined) continue

    // Compute real cost and latency from the durable model/usage event.
    const { costUsd, latencyMs } = computeAttemptAccounting(events, routingDecisionId, pricingRegistry)

    attempts.push({
      attempt: evidence.attempt,
      attemptId: `${repairId}#attempt-${evidence.attempt}`,
      model,
      routingDecisionId,
      verified: false,
      verificationStatus: 'verified-fail',
      failureFingerprint: evidence.fingerprint,
      ...(evidence.progress !== undefined ? { progress: evidence.progress } : {}),
      failurePackage: evidence.failurePackage,
      failurePackageId: evidence.failurePackageId,
      costUsd,
      latencyMs,
      ...evidence.workspaceHash !== undefined ? { workspaceHash: evidence.workspaceHash } : {},
    })
  }

  // Sort attempts by attempt number for stable reconstruction.
  attempts.sort((a, b) => a.attempt - b.attempt)

  // Recover cumulative cost from durable usage events.
  const totalCostUsd = computeTotalCost(events, attempts.map(a => a.routingDecisionId), pricingRegistry)
  const totalOutputTokens = computeTotalOutputTokens(events, attempts.map(a => a.routingDecisionId))

  // Recover the original repair start time from the first repair/evidence
  // event for this repair sequence. This ensures elapsed time remains
  // accurate after crash/restart.
  let startedAt = Date.now()
  for (const event of events) {
    if ((event.type as string) === 'repair/evidence') {
      const data = event.data as { repairId?: string }
      if (data.repairId === repairId) {
        startedAt = event.time
        break
      }
    }
  }

  return {
    repairId,
    attempts,
    totalCostUsd,
    elapsedMs: Date.now() - startedAt,
    startedAt,
    flashAttempts,
    proAttempts,
    totalOutputTokens,
  }
}

/** Dependencies needed by the extracted repair event handler. */
export interface RepairHandlerDeps {
  /** The Flash model ref. */
  readonly flashModel: ModelRef
  /** The Pro model ref. */
  readonly proModel: ModelRef
  /** Repair limits. */
  readonly limits: RepairLimits
  /** The decide function (production or injected). */
  readonly decide: typeof decideRepair
  /** Whether Pro model is available for escalation. */
  readonly proModelAvailable: boolean
  /** Whether the current model was manually selected. */
  readonly manualModelSelection: boolean
  /** Pricing registry for cost calculation. Defaults to {@link DEFAULT_PRICING_REGISTRY}. */
  readonly pricingRegistry?: readonly ModelPricing[]
  /** Whether to throw on missing model/usage events. When true, a paid
   * request without usage evidence is a control-plane failure. Production
   * qualification enables this; unit tests may disable it to avoid
   * injecting usage events for non-accounting scenarios. Default: false.
   */
  readonly failOnMissingUsage?: boolean
  /** Optional workspace provenance provider for SHA-256 file content hashing. */
  readonly workspaceProvenanceProvider?: WorkspaceProvenanceProvider
  /** Optional harness-owned rollback provider for workspace restoration. */
  readonly rollbackProvider?: RollbackProvider
  /** Optional changed-files provider for real filesystem diffs. */
  readonly changedFilesProvider?: ChangedFilesProvider
}

/** Result of handling one verification failure. */
export interface RepairHandlerResult {
  readonly action: RepairDecision['action']
  readonly reason: string | undefined
  readonly followupContent: ContentBlock[] | undefined
  readonly events: SessionEvent[]
  readonly repairId: string
  readonly attemptNumber: number
  /** On pro-escalate, the pending escalation awaiting a real routing decision. */
  readonly pendingEscalation: PendingEscalation | undefined
  /** On flash-repair or pro-escalate, the model to claim via routing authority. */
  readonly claimModel: ModelRef | undefined
}

/**
 * Handle one goal/verification FAIL event through the full repair
 * runtime path: build evidence, call the controller, emit durable
 * events, and produce a followup message if needed. This is the
 * extracted core of the plugin's session/event handler, testable
 * without a full Cordis context.
 *
 * @param session - the session to append events to.
 * @param state - the mutable repair state for this goal.
 * @param deps - handler dependencies (models, limits, decide function).
 * @param turn - the current turn number.
 * @param checks - the verification checks from the failed goal.
 * @returns the handler result with action, events, and optional followup.
 */
export function handleVerificationFailure(
  session: Session,
  state: RepairState,
  deps: RepairHandlerDeps,
  turn: number,
  checks: readonly GoalVerificationCheck[],
): RepairHandlerResult {
  const changedFiles = deps.changedFilesProvider !== undefined
    ? [...deps.changedFilesProvider()]
    : changedFilesInTurn(session.events, turn)
  const failure = buildFailurePackage(checks, changedFiles)

  const routingDecisionId = latestRoutingDecisionId(session.events, turn) ?? `unknown-${state.attempts.length + 1}`
  const model = modelFromRoutingDecision(session.events, routingDecisionId) ?? deps.flashModel

  const attemptNumber = state.attempts.length + 1
  const attemptId = `${state.repairId}#attempt-${attemptNumber}`
  const lastAttempt = state.attempts.length > 0
    ? state.attempts[state.attempts.length - 1]
    : undefined
  const priorFailure = lastAttempt?.failurePackage
  const progress = priorFailure !== undefined
    ? classifyProgress(priorFailure, failure)
    : 'none'
  const fingerprint = computeFailureFingerprint(failure)
  const failurePackageId = computeFailurePackageId(session.id, turn, routingDecisionId)

  // Compute real cost and latency from the durable model/usage event.
  // Fail closed on unpriced usage: unknown pricing must not silently become $0.
  // Fail closed on missing usage when enabled: a paid request without usage
  // evidence is a control-plane failure, not a zero-cost attempt.
  const { costUsd, latencyMs, outputTokens } = computeAttemptAccounting(
    session.events, routingDecisionId, deps.pricingRegistry, true, deps.failOnMissingUsage ?? false,
  )

  // Compute workspace provenance hash when a provider is configured.
  let workspaceHash: string | undefined
  if (deps.workspaceProvenanceProvider !== undefined) {
    workspaceHash = deps.workspaceProvenanceProvider({ session, changedFiles })
  }

  const attempt: RepairAttempt = {
    attempt: attemptNumber,
    attemptId,
    model,
    routingDecisionId,
    verified: false,
    verificationStatus: 'verified-fail',
    failureFingerprint: fingerprint,
    progress,
    failurePackage: failure,
    failurePackageId,
    costUsd,
    latencyMs,
    ...workspaceHash !== undefined ? { workspaceHash } : {},
  }
  state.attempts.push(attempt)
  state.totalCostUsd += costUsd
  state.totalOutputTokens += outputTokens

  // Emit repair/evidence — sanitized before persistence so the durable
  // ledger cannot retain credentials or internal identifiers from raw
  // verifier output. The same sanitized projection is used for both the
  // durable event and the model prompt, so the ledger and the model see
  // identical evidence.
  const sanitized = projectFailureForModel(failure)
  session.append('repair/evidence', {
    repairId: state.repairId,
    turn,
    step: 0,
    attempt: attemptNumber,
    attemptId,
    routingDecisionId,
    failureFingerprint: fingerprint,
    failurePackageId,
    progress,
    failedCriteria: sanitized.failedCriteria,
    failingTests: sanitized.failingTests,
    typeErrors: sanitized.typeErrors,
    buildErrors: sanitized.buildErrors,
    changedFiles: sanitized.changedFiles,
    ...workspaceHash !== undefined ? { workspaceHash } : {},
    ...sanitized.failedKind !== undefined ? { failedKind: sanitized.failedKind } : {},
  }, { ignorable: true })

  // Call the repair controller
  const decisionInput: RepairDecisionInput = {
    sessionId: session.id,
    turn,
    step: 0,
    initialModel: deps.flashModel,
    currentModel: model,
    attempts: state.attempts,
    latestFailure: failure,
    budget: {
      totalCostUsd: state.totalCostUsd,
      elapsedMs: Date.now() - state.startedAt,
      totalOutputTokens: state.totalOutputTokens,
    },
    limits: deps.limits,
    ...(!deps.proModelAvailable ? { proModelAvailable: false } : {}),
    ...(deps.manualModelSelection ? { manualModelSelection: true } : {}),
  }
  const decision = deps.decide(decisionInput)

  // Emit repair/decision
  session.append('repair/decision', {
    repairId: state.repairId,
    turn,
    step: 0,
    attempt: attemptNumber,
    attemptId,
    action: decision.action,
    ...(decision.action === 'pro-escalate' ? { reason: decision.reason } : {}),
    ...(decision.action === 'stop' ? { reason: decision.reason } : {}),
    failureFingerprint: fingerprint,
  }, { ignorable: true })

  let followupContent: ContentBlock[] | undefined
  let pendingEscalation: PendingEscalation | undefined
  let claimModel: ModelRef | undefined

  // Perform harness-owned workspace rollback before the next repair attempt
  // (flash-repair or pro-escalate). Rollback is NOT performed for complete
  // or stop, since no new attempt will be made. When rollback fails, the
  // repair MUST fail closed: no new model attempt is issued.
  if (deps.rollbackProvider !== undefined
    && (decision.action === 'flash-repair' || decision.action === 'pro-escalate')) {
    const rollbackResult = deps.rollbackProvider({
      session,
      repairId: state.repairId,
      attempt: attemptNumber,
      routingDecisionId,
      ...workspaceHash !== undefined ? { workspaceHash } : {},
    })
    session.append('repair/rollback', {
      repairId: state.repairId,
      turn,
      step: 0,
      attempt: attemptNumber,
      attemptId,
      routingDecisionId,
      rollbackTarget: rollbackResult.rollbackTarget,
      success: rollbackResult.success,
      ...rollbackResult.failureReason !== undefined ? { failureReason: rollbackResult.failureReason } : {},
      ...rollbackResult.targetHash !== undefined ? { targetHash: rollbackResult.targetHash } : {},
      ...rollbackResult.resultHash !== undefined ? { resultHash: rollbackResult.resultHash } : {},
    }, { ignorable: true })

    // Fail closed: rollback failure stops repair immediately.
    // No agent.followup(), no new model/routing-decision, no provider call.
    if (!rollbackResult.success) {
      session.append('repair/completed', {
        repairId: state.repairId,
        turn,
        step: 0,
        finalRoutingDecisionId: routingDecisionId,
        verified: false,
        totalAttempts: state.attempts.length,
        flashAttempts: state.flashAttempts,
        proAttempts: state.proAttempts,
        totalCostUsd: state.totalCostUsd,
        elapsedMs: Date.now() - state.startedAt,
        outcome: 'rollback-failed',
      }, { ignorable: true })
      return {
        action: 'stop',
        reason: 'rollback-failed',
        followupContent: undefined,
        events: [],
        repairId: state.repairId,
        attemptNumber,
        pendingEscalation: undefined,
        claimModel: undefined,
      }
    }
  }

  switch (decision.action) {
    case 'complete': {
      session.append('repair/completed', {
        repairId: state.repairId,
        turn,
        step: 0,
        finalRoutingDecisionId: routingDecisionId,
        verified: true,
        totalAttempts: state.attempts.length,
        flashAttempts: state.flashAttempts,
        proAttempts: state.proAttempts,
        totalCostUsd: state.totalCostUsd,
        elapsedMs: Date.now() - state.startedAt,
        outcome: 'verified',
      }, { ignorable: true })
      break
    }
    case 'flash-repair': {
      state.flashAttempts += 1
      claimModel = deps.flashModel
      followupContent = renderRepairPrompt(projectFailureForModel(decision.evidence), state.attempts.length + 1, progress)
      break
    }
    case 'pro-escalate': {
      state.proAttempts += 1
      // The model/escalation event is emitted after the real routing
      // decision arrives, not here. The plugin claims the Pro model via
      // the routing authority, calls agent.followup(), and when the next
      // model/routing-decision event fires, it emits model/escalation
      // with the real toRoutingDecisionId.
      pendingEscalation = {
        repairId: state.repairId,
        fromRoutingDecisionId: routingDecisionId,
        fromModel: model.model,
        toModel: deps.proModel.model,
        reason: decision.reason,
        failureFingerprint: fingerprint,
        flashAttempts: state.flashAttempts,
        turn,
      }
      claimModel = deps.proModel
      followupContent = renderProEscalationPrompt(projectFailureForModel(decision.evidence), state.flashAttempts, progress)
      break
    }
    case 'stop': {
      const stopOutcome: RepairOutcome = decision.reason === 'cost-limit'
        ? 'cost-limit'
        : decision.reason === 'time-limit'
          ? 'time-limit'
          : decision.reason === 'output-token-limit'
            ? 'output-token-limit'
            : decision.reason === 'escalation-model-unavailable'
              ? 'model-unavailable'
              : 'attempts-exhausted'
      session.append('repair/completed', {
        repairId: state.repairId,
        turn,
        step: 0,
        finalRoutingDecisionId: routingDecisionId,
        verified: false,
        totalAttempts: state.attempts.length,
        flashAttempts: state.flashAttempts,
        proAttempts: state.proAttempts,
        totalCostUsd: state.totalCostUsd,
        elapsedMs: Date.now() - state.startedAt,
        outcome: stopOutcome,
      }, { ignorable: true })
      break
    }
  }

  const eventsBefore = session.events.length
  const newEvents = session.events.slice(eventsBefore)

  return {
    action: decision.action,
    reason: decision.action === 'pro-escalate' || decision.action === 'stop'
      ? decision.reason
      : undefined,
    followupContent,
    events: newEvents,
    repairId: state.repairId,
    attemptNumber,
    pendingEscalation,
    claimModel,
  }
}

/**
 * Emit `repair/completed` for an active repair that passes diagnostic
 * verification. When a holdout verifier is provided, runs it before
 * completing: a holdout failure emits `repair/completed` with
 * `verified: false` and `qualificationFailure` but does NOT trigger repair.
 *
 * @param session - the session to append the completion event to.
 * @param state - the mutable repair state for this goal.
 * @param turn - the current turn number.
 * @param routingDecisionId - the routing decision that produced the passing diagnostic verification.
 * @param pricingRegistry - optional pricing registry for cost calculation. Defaults to {@link DEFAULT_PRICING_REGISTRY}.
 * @param holdoutVerifier - optional qualification holdout verifier. When present, must pass before completion.
 * @param goalId - the goal id being verified, required when holdoutVerifier is present.
 * @returns the completion event, or undefined if no active repair.
 */
/** Result of a passing verification, returned to the plugin for goal transition. */
export interface VerificationPassResult {
  /** Whether the holdout (if any) passed. */
  readonly verified: boolean
  /** Terminal outcome: verified or qualification-failed. */
  readonly outcome: 'verified' | 'qualification-failed'
  /** Holdout failure details when the holdout failed. */
  readonly qualificationFailure?: { reason: string; evidence?: readonly string[] }
  /** SHA-256 workspace content hash at verification time, when provenance is tracked. */
  readonly workspaceHash?: string
}

/**
 * Handle a passing diagnostic verification. Accounts for the passing
 * attempt's cost and tokens, adds it to repair state, and runs the holdout
 * verifier when configured. Does NOT append repair/completed — the caller
 * must transition the goal (completeVerified or block) before appending
 * repair/completed, so that goal/verification PASS remains the latest event
 * for completeVerified's freshness check.
 *
 * @param session - the session.
 * @param state - the repair state.
 * @param turn - the current turn.
 * @param routingDecisionId - the routing decision for the passing attempt.
 * @param pricingRegistry - the pricing registry for cost lookup.
 * @param holdoutVerifier - optional holdout verifier.
 * @param goalId - required when holdoutVerifier is provided.
 * @param workspaceProvenanceProvider - optional provenance provider; when
 *   present, a provider error is fatal (fail-closed) so benchmark
 *   qualification cannot silently omit the workspace hash.
 * @param changedFiles - files changed in the passing turn, passed to the
 *   provenance provider so the hash reflects the actual workspace state.
 * @returns the verification pass result for goal transition and repair/completed.
 */
export async function handleVerificationPass(
  session: Session,
  state: RepairState,
  _turn: number,
  routingDecisionId: string,
  pricingRegistry: readonly ModelPricing[] = DEFAULT_PRICING_REGISTRY,
  holdoutVerifier?: HoldoutVerifier,
  goalId?: string,
  workspaceProvenanceProvider?: WorkspaceProvenanceProvider,
  changedFiles: readonly string[] = [],
  failOnMissingUsage = false,
): Promise<VerificationPassResult> {
  // Account for the passing attempt's cost and output tokens from the durable model/usage event.
  // Fail closed on unpriced usage: unknown pricing must not silently become $0.
  // Fail closed on missing usage when enabled: a paid request without usage
  // evidence is a control-plane failure, not a zero-cost attempt.
  const { costUsd, latencyMs, outputTokens } = computeAttemptAccounting(
    session.events, routingDecisionId, pricingRegistry, true, failOnMissingUsage,
  )
  state.totalCostUsd += costUsd
  state.totalOutputTokens += outputTokens

  // Add the passing attempt to repair state so terminal accounting agrees
  // with execution truth. A one-shot success now counts as 1 attempt.
  const model = modelFromRoutingDecision(session.events, routingDecisionId) ?? { provider: 'deepseek', model: 'deepseek-v4-flash' }
  const attemptNumber = state.attempts.length + 1
  const attemptId = `${state.repairId}#attempt-${attemptNumber}`
  state.attempts.push({
    attempt: attemptNumber,
    attemptId,
    model,
    routingDecisionId,
    verified: true,
    verificationStatus: 'verified-pass',
    costUsd,
    latencyMs,
  })
  // Increment the model-specific counter. Match by model name across
  // provider aliases (deepseek, deepseek-official) so the counter works
  // regardless of which provider alias the routing decision used.
  if (model.model === 'deepseek-v4-flash') {
    state.flashAttempts += 1
  } else if (model.model === 'deepseek-v4-pro') {
    state.proAttempts += 1
  }

  // Run holdout verification when configured. Holdout failures do NOT
  // trigger repair — they report qualification failure and stop.
  let qualificationFailure: { reason: string; evidence?: readonly string[] } | undefined
  if (holdoutVerifier !== undefined) {
    if (goalId === undefined) {
      throw new Error('handleVerificationPass: goalId is required when holdoutVerifier is provided')
    }
    const holdoutResult = await holdoutVerifier({ session, state, routingDecisionId, goalId })
    if (!holdoutResult.passed) {
      qualificationFailure = {
        reason: sanitizeEvidenceString(holdoutResult.reason),
        ...holdoutResult.evidence !== undefined ? { evidence: holdoutResult.evidence.map(sanitizeEvidenceString) } : {},
      }
    }
  }

  // Compute workspace hash at verification time when a provenance provider is
  // configured. The hash binds the workspace state to the verification result,
  // so replay can detect post-verification tampering. Provenance failure is
  // fatal: a benchmark-qualified run must not silently omit the workspace hash.
  let workspaceHash: string | undefined
  if (workspaceProvenanceProvider !== undefined) {
    workspaceHash = workspaceProvenanceProvider({
      session,
      changedFiles,
    })
  }

  return {
    verified: qualificationFailure === undefined,
    outcome: qualificationFailure === undefined ? 'verified' : 'qualification-failed',
    ...qualificationFailure !== undefined ? { qualificationFailure } : {},
    ...workspaceHash !== undefined ? { workspaceHash } : {},
  }
}

/** Plugin name. */
export const name = 'repair-runtime'

/** Services required before the plugin can register its event handlers. */
export const inject = ['agents', 'goals', 'sessions', 'repairController']

/** Plugin entry point. */
export function apply(ctx: Context, config: RepairRuntimeConfig = { enabled: false }): void {
  if (!config.enabled) return

  const flashModel: ModelRef = config.flashModel ?? { provider: 'deepseek', model: 'deepseek-v4-flash' }
  const proModel: ModelRef = config.proModel ?? { provider: 'deepseek', model: 'deepseek-v4-pro' }

  const repairStates = new Map<string, RepairState>()
  /** Pending Pro escalations keyed by session id, awaiting a real routing decision. */
  const pendingEscalations = new Map<string, PendingEscalation>()

  /** Get or create repair state for a goal, reconstructing from the log on first access. */
  function stateFor(agent: Agent, goal: GoalView): RepairState {
    const key = `${agent.id}:${goal.id}`
    const existing = repairStates.get(key)
    if (existing !== undefined) return existing
    const reconstructed = reconstructRepairState(agent.session.events, goal.id)
    if (reconstructed !== undefined) {
      repairStates.set(key, reconstructed)
      return reconstructed
    }
    // Derive a deterministic repairId from stable execution identity. The
    // originating routing decision is the latest one for the current turn.
    const turn = currentTurn(agent.session.events)
    const originatingRoutingDecisionId = latestRoutingDecisionId(agent.session.events, turn) ?? 'unknown'
    const state: RepairState = {
      repairId: computeRepairId(agent.session.id, goal.id, goal.revision, originatingRoutingDecisionId),
      attempts: [],
      totalCostUsd: 0,
      elapsedMs: 0,
      startedAt: Date.now(),
      flashAttempts: 0,
      proAttempts: 0,
      totalOutputTokens: 0,
    }
    repairStates.set(key, state)
    return state
  }

  // Watch goal/verification for both PASS and FAIL. Global so the
  // handler fires for every agent session regardless of which fiber
  // created it.
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'goal/verification') return
    const data = event.data as {
      goal: GoalRef
      passed: boolean
      checks: readonly GoalVerificationCheck[]
    }

    const agent = ctx.agents.get(session.id)
    if (agent === undefined || agent.session !== session) return

    const goal = ctx.goals.get(agent)
    if (goal === undefined || goal.id !== data.goal.id) return

    const turn = currentTurn(session.events)

    const key = `${agent.id}:${goal.id}`
    const state = repairStates.get(key)

    // PASS: run holdout (if configured), transition the goal, then emit
    // repair/completed. The goal transition MUST happen before
    // repair/completed is appended, because completeVerified() requires
    // goal/verification PASS as the latest durable event. Holdout failures
    // do NOT trigger repair — they block the goal as qualification-failed.
    // On a one-shot success (no prior repair state), create fresh state so
    // the same completion pipeline owns one-shot success, repair success,
    // and Pro success.
    if (data.passed) {
      const passState = state ?? stateFor(agent, goal)
      // Use the FIRST routing decision for the turn, not the latest. A
      // mid-turn escalation from Flash to Pro is a routing feature, not a
      // repair escalation. The attempt's model attribution must reflect
      // which model started the attempt, not which model finished it.
      const routingDecisionId = firstRoutingDecisionId(session.events, turn) ?? 'unknown'
      const passChangedFiles = config.changedFilesProvider !== undefined
        ? [...config.changedFilesProvider()]
        : changedFilesInTurn(session.events, turn)
      void handleVerificationPass(
        session, passState, turn, routingDecisionId,
        DEFAULT_PRICING_REGISTRY,
        config.holdoutVerifier,
        goal.id,
        config.workspaceProvenanceProvider,
        passChangedFiles,
        config.failOnMissingUsage ?? false,
      ).then((result) => {
        // Transition the goal while goal/verification PASS is still the
        // latest event. completeVerified() checks this freshness.
        if (result.verified) {
          // Re-compute the workspace hash at completion time. If the
          // workspace mutated between verification and completion, the
          // hash will differ and completeVerified() will reject.
          let currentWorkspaceHash: string | undefined
          if (config.workspaceProvenanceProvider !== undefined && result.workspaceHash !== undefined) {
            try {
              currentWorkspaceHash = config.workspaceProvenanceProvider({
                session,
                changedFiles: passChangedFiles,
              })
            } catch {
              // Provenance failure at completion is fatal — the workspace
              // state cannot be verified, so refuse completion.
              ctx.goals.block(agent, { id: goal.id, revision: goal.revision }, {
                code: 'workspace-provenance-failed',
                message: 'workspace provenance provider failed at completion time',
              })
              session.append('repair/completed', {
                repairId: passState.repairId,
                turn,
                step: 0,
                finalRoutingDecisionId: routingDecisionId,
                verified: false,
                totalAttempts: passState.attempts.length,
                flashAttempts: passState.flashAttempts,
                proAttempts: passState.proAttempts,
                totalCostUsd: passState.totalCostUsd,
                elapsedMs: Date.now() - passState.startedAt,
                outcome: 'workspace-provenance-failed',
              }, { ignorable: true })
              releaseToAuto(session, 'system')
              repairStates.delete(key)
              return
            }
          }
          try {
            ctx.goals.completeVerified(agent, { id: goal.id, revision: goal.revision }, currentWorkspaceHash)
          } catch (completionError: unknown) {
            // GOAL_WORKSPACE_MUTATED or other completion failure must
            // terminalize explicitly rather than escaping as an
            // unhandled promise rejection.
            ctx.goals.block(agent, { id: goal.id, revision: goal.revision }, {
              code: 'workspace-provenance-failed',
              message: completionError instanceof Error ? completionError.message : String(completionError),
            })
            session.append('repair/completed', {
              repairId: passState.repairId,
              turn,
              step: 0,
              finalRoutingDecisionId: routingDecisionId,
              verified: false,
              totalAttempts: passState.attempts.length,
              flashAttempts: passState.flashAttempts,
              proAttempts: passState.proAttempts,
              totalCostUsd: passState.totalCostUsd,
              elapsedMs: Date.now() - passState.startedAt,
              outcome: 'workspace-provenance-failed',
            }, { ignorable: true })
            releaseToAuto(session, 'system')
            repairStates.delete(key)
            return
          }
        } else {
          ctx.goals.block(agent, { id: goal.id, revision: goal.revision }, {
            code: 'qualification-failed',
            message: result.qualificationFailure?.reason ?? 'holdout verification failed',
          })
        }

        // Now append repair/completed after the goal transition.
        session.append('repair/completed', {
          repairId: passState.repairId,
          turn,
          step: 0,
          finalRoutingDecisionId: routingDecisionId,
          verified: result.verified,
          totalAttempts: passState.attempts.length,
          flashAttempts: passState.flashAttempts,
          proAttempts: passState.proAttempts,
          totalCostUsd: passState.totalCostUsd,
          elapsedMs: Date.now() - passState.startedAt,
          outcome: result.outcome,
          ...result.qualificationFailure !== undefined ? { qualificationFailure: result.qualificationFailure } : {},
          ...result.workspaceHash !== undefined ? { workspaceHash: result.workspaceHash } : {},
        }, { ignorable: true })

        // Release the model selection back to automatic routing.
        releaseToAuto(session, 'system')
        repairStates.delete(key)
      }).catch((handlerError: unknown) => {
        // Catch any unhandled errors from the pass handler chain so they
        // do not escape as unhandled promise rejections.
        ctx.logger.error(`repair-runtime: verification pass handler error: ${handlerError instanceof Error ? handlerError.message : String(handlerError)}`)
        ctx.goals.block(agent, { id: goal.id, revision: goal.revision }, {
          code: 'workspace-provenance-failed',
          message: handlerError instanceof Error ? handlerError.message : String(handlerError),
        })
        session.append('repair/completed', {
          repairId: passState.repairId,
          turn,
          step: 0,
          finalRoutingDecisionId: routingDecisionId,
          verified: false,
          totalAttempts: passState.attempts.length,
          flashAttempts: passState.flashAttempts,
          proAttempts: passState.proAttempts,
          totalCostUsd: passState.totalCostUsd,
          elapsedMs: Date.now() - passState.startedAt,
          outcome: 'workspace-provenance-failed',
        }, { ignorable: true })
        releaseToAuto(session, 'system')
        repairStates.delete(key)
      })
      return
    }

    // FAIL: proceed with repair logic. Defer to a microtask so the
    // goal/verification append completes before the failure handler
    // appends repair/evidence, repair/decision, repair/rollback, and
    // repair/completed events. Running synchronously inside the
    // session/event publish cycle would reenter session.append.
    const repairController = ctx.get('repairController') as { decide: (input: object) => RepairDecision } | undefined
    const failChecks = data.checks
    void Promise.resolve().then(() => {
      if (repairController === undefined) {
        ctx.logger.warn(`repair-runtime: RepairController service not available; blocking goal "${goal.id}"`)
        ctx.goals.block(agent, { id: goal.id, revision: goal.revision }, {
          code: 'repair-controller-unavailable',
          message: 'RepairController service is not registered',
        })
        return
      }

      const repairState = stateFor(agent, goal)

      // Fail closed on undecidable model-selection authority. A future-schema
      // or uninterpretable durable authority record must NOT be treated as
      // automatic — the repair runtime refuses to transition the model.
      const authority = resolveSelectionAuthority(session.events)
      if (authority.kind === 'undecidable') {
        ctx.logger.warn(
          `repair-runtime: selection authority undecidable for goal "${goal.id}"; refusing repair model transition`,
        )
        const routingDecisionId = latestRoutingDecisionId(session.events, turn) ?? 'unknown'
        session.append('repair/completed', {
          repairId: repairState.repairId,
          turn,
          step: 0,
          finalRoutingDecisionId: routingDecisionId,
          verified: false,
          totalAttempts: repairState.attempts.length,
          flashAttempts: repairState.flashAttempts,
          proAttempts: repairState.proAttempts,
          totalCostUsd: repairState.totalCostUsd,
          elapsedMs: Date.now() - repairState.startedAt,
          outcome: 'authority-undecidable',
        }, { ignorable: true })
        ctx.goals.block(agent, { id: goal.id, revision: goal.revision }, {
          code: 'selection-authority-undecidable',
          message: 'Model selection authority cannot be reconstructed from the durable log',
        })
        repairStates.delete(`${agent.id}:${goal.id}`)
        return
      }

      const deps: RepairHandlerDeps = {
        flashModel,
        proModel,
        limits: {
          maxFlashAttempts: config.maxFlashAttempts ?? 3,
          maxProAttempts: config.maxProAttempts ?? 2,
          maxTotalAttempts: config.maxTotalAttempts ?? 5,
          ...config.maxTaskCostUsd !== undefined ? { maxTaskCostUsd: config.maxTaskCostUsd } : {},
          ...config.maxElapsedMs !== undefined ? { maxElapsedMs: config.maxElapsedMs } : {},
          ...config.maxOutputTokens !== undefined ? { maxOutputTokens: config.maxOutputTokens } : {},
        },
        decide: repairController.decide.bind(repairController),
        proModelAvailable: config.proModelAvailable ?? true,
        manualModelSelection: authority.kind === 'manual',
        ...config.failOnMissingUsage !== undefined ? { failOnMissingUsage: config.failOnMissingUsage } : {},
        ...config.workspaceProvenanceProvider !== undefined ? { workspaceProvenanceProvider: config.workspaceProvenanceProvider } : {},
        ...config.rollbackProvider !== undefined ? { rollbackProvider: config.rollbackProvider } : {},
        ...config.changedFilesProvider !== undefined ? { changedFilesProvider: config.changedFilesProvider } : {},
      }

      let result: RepairHandlerResult
      try {
        result = handleVerificationFailure(session, repairState, deps, turn, failChecks)
      } catch (handlerError) {
        ctx.logger.error(`repair-runtime: verification failure handler error: ${handlerError instanceof Error ? handlerError.message : String(handlerError)}`)
        ctx.goals.block(agent, { id: goal.id, revision: goal.revision }, {
          code: 'repair-handler-error',
          message: handlerError instanceof Error ? handlerError.message : String(handlerError),
        })
        session.append('repair/completed', {
          repairId: repairState.repairId,
          turn,
          step: 0,
          finalRoutingDecisionId: latestRoutingDecisionId(session.events, turn) ?? 'unknown',
          verified: false,
          totalAttempts: repairState.attempts.length,
          flashAttempts: repairState.flashAttempts,
          proAttempts: repairState.proAttempts,
          totalCostUsd: repairState.totalCostUsd,
          elapsedMs: Date.now() - repairState.startedAt,
          outcome: 'repair-handler-error',
        }, { ignorable: true })
        releaseToAuto(session, 'system')
        repairStates.delete(key)
        return
      }

      switch (result.action) {
        case 'complete': {
          // Transition the goal to complete. Use complete() rather than
          // completeVerified() because the latest event is goal/verification
          // FAIL, not PASS — the repair controller decided to complete
          // despite the verification failure (e.g. a prior attempt passed).
          ctx.goals.complete(agent, { id: goal.id, revision: goal.revision })
          releaseToAuto(session, 'system')
          repairStates.delete(key)
          return
        }
        case 'flash-repair':
        case 'pro-escalate': {
          // Claim the model selection through the durable routing authority
          // so the router creates a real model/routing-decision event. The
          // repair runtime uses 'policy' authority because repair escalation
          // is a deployment policy decision, not a user or SDK choice.
          if (result.claimModel !== undefined) {
            claimModelSelection(session, {
              authority: 'policy',
              source: 'system',
              selection: {
                provider: result.claimModel.provider,
                model: result.claimModel.model,
              },
              reason: `repair escalation: ${result.action}`,
            })
          }
          // Store pending escalation so the model/routing-decision handler
          // can emit model/escalation with the real toRoutingDecisionId.
          if (result.pendingEscalation !== undefined) {
            pendingEscalations.set(session.id, result.pendingEscalation)
          }
          if (result.followupContent !== undefined) {
            const message = createUserMessage({
              content: result.followupContent,
              source: { kind: 'plugin', plugin: 'repair-runtime' },
            })
            agent.followup(message)
          }
          return
        }
        case 'stop': {
          releaseToAuto(session, 'system')
          ctx.goals.block(agent, { id: goal.id, revision: goal.revision }, {
            code: 'repair-exhausted',
            message: `Repair exhausted: ${result.reason ?? 'unknown'}`,
          })
          repairStates.delete(key)
          return
        }
      }
    })
  }, { global: true })

  // Watch model/routing-decision to resolve pending escalations with the
  // real toRoutingDecisionId. Global so the handler fires for every
  // agent session regardless of which fiber created it.
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if ((event.type as string) !== 'model/routing-decision') return
    const pending = pendingEscalations.get(session.id)
    if (pending === undefined) return
    const rdData = event.data as { routingDecisionId?: string }
    const realRoutingDecisionId = rdData.routingDecisionId
    if (realRoutingDecisionId === undefined) return
    // Defer the model/escalation append to avoid reentering session.append
    // while the model/routing-decision event is still being published.
    const escalationPending = pending
    pendingEscalations.delete(session.id)
    void Promise.resolve().then(() => {
      session.append('model/escalation', {
        repairId: escalationPending.repairId,
        turn: escalationPending.turn,
        step: 0,
        fromRoutingDecisionId: escalationPending.fromRoutingDecisionId,
        toRoutingDecisionId: realRoutingDecisionId,
        repairOf: escalationPending.fromRoutingDecisionId,
        fromModel: escalationPending.fromModel,
        toModel: escalationPending.toModel,
        reason: escalationPending.reason,
        failureFingerprint: escalationPending.failureFingerprint,
        flashAttempts: escalationPending.flashAttempts,
      }, { ignorable: true })
    })
  }, { global: true })

  ctx.on('agent/disposed', ({ agent }) => {
    for (const key of repairStates.keys()) {
      if (key.startsWith(`${agent.id}:`)) repairStates.delete(key)
    }
    pendingEscalations.delete(agent.session.id)
  })
}
