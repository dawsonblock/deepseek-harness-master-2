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
import { claimModelSelection, releaseToAuto } from '@deepseek-ai/dsh-agent'
import type { GoalRef, GoalVerificationCheck, GoalView } from '@deepseek-ai/dsh-goal'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { EscalationReason, FailurePackage, ModelRef, RepairAttempt, RepairDecision, RepairDecisionInput, RepairLimits } from '@deepseek-ai/dsh-repair-controller'
import { classifyProgress, computeFailureFingerprint, computeFailurePackageId, decideRepair } from '@deepseek-ai/dsh-repair-controller'
// Import the events module to trigger declaration merging for repair/* and model/escalation events.
import '@deepseek-ai/dsh-repair-controller/events'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

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
}

/** Per-goal repair state. */
export interface RepairState {
  repairId: string
  attempts: RepairAttempt[]
  totalCostUsd: number
  elapsedMs: number
  startedAt: number
  flashAttempts: number
  proAttempts: number
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
    .map(check => check.reason)
  const failingTests = checks
    .filter(check => check.name.includes('test'))
    .filter(check => !check.passed)
    .map(check => check.reason)
  const typeErrors = checks
    .filter(check => check.name.includes('type'))
    .filter(check => !check.passed)
    .flatMap(check => check.evidence ?? [check.reason])
  const buildErrors = checks
    .filter(check => check.name.includes('build'))
    .filter(check => !check.passed)
    .flatMap(check => check.evidence ?? [check.reason])
  return {
    failedCriteria,
    failingTests,
    typeErrors,
    buildErrors,
    changedFiles,
  }
}

/** Render a repair prompt for the model from failure evidence. */
function renderRepairPrompt(failure: FailurePackage, attempt: number): ContentBlock[] {
  const lines: string[] = [
    `Repair attempt ${attempt}: the previous attempt failed verification.`,
    '',
    'Failed criteria:',
    ...failure.failedCriteria.map(c => `- ${c}`),
    '',
    'Failing tests:',
    ...failure.failingTests.map(t => `- ${t}`),
    '',
    'Type errors:',
    ...failure.typeErrors.map(e => `- ${e}`),
    '',
    'Build errors:',
    ...failure.buildErrors.map(e => `- ${e}`),
    '',
    'Fix the issues above. The workspace state from the previous attempt is preserved.',
  ]
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Render a Pro escalation prompt with full context. */
function renderProEscalationPrompt(failure: FailurePackage, flashAttempts: number): ContentBlock[] {
  const lines: string[] = [
    `Escalation from Flash after ${flashAttempts} failed attempt(s).`,
    'You are taking over a task that Flash could not complete.',
    'The workspace state from the previous attempts is preserved.',
    '',
    'Failed criteria:',
    ...failure.failedCriteria.map(c => `- ${c}`),
    '',
    'Failing tests:',
    ...failure.failingTests.map(t => `- ${t}`),
    '',
    'Type errors:',
    ...failure.typeErrors.map(e => `- ${e}`),
    '',
    'Build errors:',
    ...failure.buildErrors.map(e => `- ${e}`),
    '',
    'Repair the work. You may rewrite the previous attempts\' changes or start fresh.',
  ]
  return [{ type: 'text', text: lines.join('\n') }]
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
 * @returns the reconstructed state, or undefined if no repair or repair completed.
 */
export function reconstructRepairState(
  events: readonly SessionEvent[],
  goalId: string,
): RepairState | undefined {
  // Find the repairId for this goal from repair events.
  let repairId: string | undefined
  let completed = false
  for (const event of events) {
    if ((event.type as string) === 'repair/completed') {
      const data = event.data as Record<string, unknown>
      if (typeof data.repairId === 'string' && data.repairId.includes(goalId)) {
        completed = true
        break
      }
    }
    if (repairId === undefined && (event.type as string).startsWith('repair/')) {
      const data = event.data as Record<string, unknown>
      if (typeof data.repairId === 'string' && data.repairId.includes(goalId)) {
        repairId = data.repairId
      }
    }
  }
  if (repairId === undefined || completed) return undefined

  // Index repair/evidence events by routingDecisionId for full FailurePackage
  // reconstruction. Each evidence event carries the complete failure data.
  const evidenceByRouting = new Map<string, {
    attempt: number
    fingerprint: string
    progress: RepairAttempt['progress']
    failurePackage: FailurePackage
    failurePackageId: string
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

    attempts.push({
      attempt: evidence.attempt,
      model,
      routingDecisionId,
      verified: false,
      verificationStatus: 'verified-fail',
      failureFingerprint: evidence.fingerprint,
      ...(evidence.progress !== undefined ? { progress: evidence.progress } : {}),
      failurePackage: evidence.failurePackage,
      failurePackageId: evidence.failurePackageId,
      costUsd: 0,
      latencyMs: 0,
    })
  }

  // Sort attempts by attempt number for stable reconstruction.
  attempts.sort((a, b) => a.attempt - b.attempt)

  return {
    repairId,
    attempts,
    totalCostUsd: 0,
    elapsedMs: 0,
    startedAt: Date.now(),
    flashAttempts,
    proAttempts,
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
  const changedFiles = changedFilesInTurn(session.events, turn)
  const failure = buildFailurePackage(checks, changedFiles)

  const routingDecisionId = latestRoutingDecisionId(session.events, turn) ?? `unknown-${state.attempts.length + 1}`
  const model = modelFromRoutingDecision(session.events, routingDecisionId) ?? deps.flashModel

  const attemptNumber = state.attempts.length + 1
  const lastAttempt = state.attempts.length > 0
    ? state.attempts[state.attempts.length - 1]
    : undefined
  const priorFailure = lastAttempt?.failurePackage
  const progress = priorFailure !== undefined
    ? classifyProgress(priorFailure, failure)
    : 'none'
  const fingerprint = computeFailureFingerprint(failure)
  const failurePackageId = computeFailurePackageId(session.id, turn, routingDecisionId)

  const attempt: RepairAttempt = {
    attempt: attemptNumber,
    model,
    routingDecisionId,
    verified: false,
    verificationStatus: 'verified-fail',
    failureFingerprint: fingerprint,
    progress,
    failurePackage: failure,
    failurePackageId,
    costUsd: 0,
    latencyMs: 0,
  }
  state.attempts.push(attempt)

  // Emit repair/evidence
  session.append('repair/evidence', {
    repairId: state.repairId,
    turn,
    step: 0,
    attempt: attemptNumber,
    routingDecisionId,
    failureFingerprint: fingerprint,
    failurePackageId,
    progress,
    failedCriteria: failure.failedCriteria,
    failingTests: failure.failingTests,
    typeErrors: failure.typeErrors,
    buildErrors: failure.buildErrors,
    changedFiles: failure.changedFiles,
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
    action: decision.action,
    ...(decision.action === 'pro-escalate' ? { reason: decision.reason } : {}),
    ...(decision.action === 'stop' ? { reason: decision.reason } : {}),
    failureFingerprint: fingerprint,
  }, { ignorable: true })

  let followupContent: ContentBlock[] | undefined
  let pendingEscalation: PendingEscalation | undefined
  let claimModel: ModelRef | undefined

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
      }, { ignorable: true })
      break
    }
    case 'flash-repair': {
      state.flashAttempts += 1
      claimModel = deps.flashModel
      followupContent = renderRepairPrompt(decision.evidence, state.attempts.length + 1)
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
      followupContent = renderProEscalationPrompt(decision.evidence, state.flashAttempts)
      break
    }
    case 'stop': {
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
 * Emit `repair/completed` for an active repair that passes verification.
 * Called when `goal/verification` PASS arrives while a repair is active.
 * Clears the repair state after recording the completion event.
 *
 * @param session - the session to append the completion event to.
 * @param state - the mutable repair state for this goal.
 * @param turn - the current turn number.
 * @param routingDecisionId - the routing decision that produced the passing verification.
 * @returns the completion event, or undefined if no active repair.
 */
export function handleVerificationPass(
  session: Session,
  state: RepairState,
  turn: number,
  routingDecisionId: string,
): SessionEvent | undefined {
  const eventsBefore = session.events.length
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
  }, { ignorable: true })
  const newEvents = session.events.slice(eventsBefore)
  return newEvents[0]
}

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
    const turn = agent.session.events.reduce(
      (max, e) => e.type === 'turn/start' ? Math.max(max, e.data.turn) : max, 0,
    )
    const originatingRoutingDecisionId = latestRoutingDecisionId(agent.session.events, turn) ?? 'unknown'
    const state: RepairState = {
      repairId: computeRepairId(agent.session.id, goal.id, goal.revision, originatingRoutingDecisionId),
      attempts: [],
      totalCostUsd: 0,
      elapsedMs: 0,
      startedAt: Date.now(),
      flashAttempts: 0,
      proAttempts: 0,
    }
    repairStates.set(key, state)
    return state
  }

  ctx.effect(function* () {
    // Watch goal/verification for both PASS and FAIL.
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

      const turn = session.events.reduce(
        (max, e) => e.type === 'turn/start' ? Math.max(max, e.data.turn) : max, 0,
      )

      const key = `${agent.id}:${goal.id}`
      const state = repairStates.get(key)

      // PASS with an active repair: emit repair/completed and clear state.
      if (data.passed) {
        if (state === undefined) return
        const routingDecisionId = latestRoutingDecisionId(session.events, turn) ?? 'unknown'
        handleVerificationPass(session, state, turn, routingDecisionId)
        // Release the model selection back to automatic routing.
        releaseToAuto(session, 'system')
        repairStates.delete(key)
        return
      }

      // FAIL: proceed with repair logic.
      const repairController = ctx.get('repairController') as { decide: (input: object) => RepairDecision } | undefined
      if (repairController === undefined) {
        ctx.logger.warn(`repair-runtime: RepairController service not available; blocking goal "${goal.id}"`)
        ctx.goals.block(agent, { id: goal.id, revision: goal.revision }, {
          code: 'repair-controller-unavailable',
          message: 'RepairController service is not registered',
        })
        return
      }

      const repairState = stateFor(agent, goal)

      const deps: RepairHandlerDeps = {
        flashModel,
        proModel,
        limits: {
          maxFlashAttempts: config.maxFlashAttempts ?? 3,
          maxProAttempts: config.maxProAttempts ?? 2,
          maxTotalAttempts: config.maxTotalAttempts ?? 5,
        },
        decide: repairController.decide,
        proModelAvailable: true,
        manualModelSelection: false,
      }

      const result = handleVerificationFailure(session, repairState, deps, turn, data.checks)

      switch (result.action) {
        case 'complete': {
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
              source: { kind: 'goal', goalId: goal.id, revision: goal.revision, round: goal.roundsStarted + 1 },
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

    // Watch model/routing-decision to resolve pending escalations with the
    // real toRoutingDecisionId.
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if ((event.type as string) !== 'model/routing-decision') return
      const pending = pendingEscalations.get(session.id)
      if (pending === undefined) return
      const rdData = event.data as { routingDecisionId?: string }
      const realRoutingDecisionId = rdData.routingDecisionId
      if (realRoutingDecisionId === undefined) return
      // Emit the model/escalation event with the real destination routing
      // decision id, now that the router has created it.
      session.append('model/escalation', {
        repairId: pending.repairId,
        turn: pending.turn,
        step: 0,
        fromRoutingDecisionId: pending.fromRoutingDecisionId,
        toRoutingDecisionId: realRoutingDecisionId,
        repairOf: pending.fromRoutingDecisionId,
        fromModel: pending.fromModel,
        toModel: pending.toModel,
        reason: pending.reason,
        failureFingerprint: pending.failureFingerprint,
        flashAttempts: pending.flashAttempts,
      }, { ignorable: true })
      pendingEscalations.delete(session.id)
    })

    ctx.on('agent/disposed', ({ agent }) => {
      for (const key of repairStates.keys()) {
        if (key.startsWith(`${agent.id}:`)) repairStates.delete(key)
      }
      pendingEscalations.delete(agent.session.id)
    })
  })
}

export { default as invariant } from './invariant.ts'
