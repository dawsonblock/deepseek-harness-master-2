/**
 * Package-owned durable authority/routing-event invariants. The router
 * participates in TWO durable vocabularies — `model/selection-authority`
 * (declared in dsh-agent; validated there for shape) and
 * `model/routing-decision` (declared here) — and this companion polices the
 * CROSS-EVENT rules that keep the control plane provably consistent:
 *
 * - selection-state epochs never regress (each recorded state outranks the
 *   previous one; a stale state may never reappear over a newer one);
 * - a manual state always carries a complete selection, an auto state never
 *   does;
 * - a router decision never supersedes manual authority without an
 *   intervening auto/release state (the audit's central authority rule);
 * - every recorded decision carries a deterministic identity, the scorer
 *   version, and the configuration fingerprint it was made under.
 *
 * @module @deepseek-ai/dsh-llm-model-router/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { AUTHORITY_SCHEMA_VERSION } from '@deepseek-ai/dsh-agent'
import { POLICY_VERSION, SCORER_VERSION } from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-llm-model-router'

/** Cordis companion plugin name. */
export const name = 'llm-model-router-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

/** Structural validation of one authority state record. */
function validateAuthorityEvent(event: SessionEvent<'model/selection-authority'>, fail: InvariantFailure): void {
  const data = event.data
  if (data.authoritySchemaVersion !== AUTHORITY_SCHEMA_VERSION) {
    // Older-schema records are valid history; anything else is foreign.
    if (typeof data.authoritySchemaVersion !== 'number' || data.authoritySchemaVersion > AUTHORITY_SCHEMA_VERSION) {
      fail('model/selection-authority carries an authority schema version this runtime does not understand')
    }
    return
  }
  if (data.mode === 'manual') {
    const selection = data.selection
    if (typeof selection?.provider !== 'string' || selection.provider.length === 0
      || typeof selection.model !== 'string' || selection.model.length === 0) {
      fail('a manual model/selection-authority state must carry a complete non-empty selection')
    }
    if (data.authority !== 'user' && data.authority !== 'sdk' && data.authority !== 'policy' && data.authority !== 'subagent-owner') {
      fail('a manual model/selection-authority state names an authority outside the manual vocabulary')
    }
    return
  }
  if (data.mode === 'auto') {
    if (data.selection !== undefined) {
      fail('an auto model/selection-authority state must not carry a manual selection')
    }
    if (data.authority !== 'router' && data.authority !== 'default') {
      fail('an auto model/selection-authority state names an authority outside the automatic vocabulary')
    }
    return
  }
  fail('model/selection-authority mode must be auto or manual')
}

/** Validate one routing decision against the selection state in force. */
function validateRoutingDecision(
  history: readonly SessionEvent[],
  event: SessionEvent<'model/routing-decision'>,
  fail: InvariantFailure,
): void {
  const data = event.data
  if (typeof data.routingDecisionId !== 'string' || data.routingDecisionId.length === 0) {
    fail('model/routing-decision must carry a non-empty deterministic routingDecisionId')
  }
  if (data.scorerVersion !== SCORER_VERSION) {
    fail(`model/routing-decision must record the scoring implementation (expected ${String(SCORER_VERSION)})`)
  }
  if (typeof data.configFingerprint !== 'string' || data.configFingerprint.length === 0) {
    fail('model/routing-decision must record the configuration fingerprint it was made under')
  }
  // A router-owned decision is only legal while automatic selection is in
  // force: a manual state (any schema version this runtime understands, or a
  // legacy explicit barrier) must have been released to auto BEFORE the
  // router may claim a route — the audit's central authority rule.
  if (data.authority === 'router' && data.policyVersion === POLICY_VERSION) {
    for (let at = event.seq - 1; at >= 0; at -= 1) {
      const prior: SessionEvent | undefined = history[at]
      if (prior === undefined) continue
      if (prior.type === 'model/selection-authority') {
        const state = prior.data
        if (state.mode === 'manual') {
          fail('model/routing-decision claims router authority while a manual selection is in force (missing auto release)')
        }
        break
      }
      if (prior.type === 'model/routing-decision' && prior.data.authority === 'explicit-selection') {
        fail('model/routing-decision claims router authority while an explicit selection barrier is in force (missing auto release)')
      }
    }
  }
}

/** Validate the authority-state epoch sequence of one loaded session. */
function validateEpochSequence(session: Session, fail: InvariantFailure): void {
  let highest = 0
  for (const event of session.events) {
    if (event.type !== 'model/selection-authority') continue
    validateAuthorityEvent(event, fail)
    const epoch = event.data.authorityEpoch
    if (!Number.isSafeInteger(epoch) || epoch < 1) {
      fail('model/selection-authority authorityEpoch must be a positive safe integer')
      continue
    }
    if (epoch <= highest) {
      fail(`model/selection-authority authorityEpoch ${epoch} regressed below an earlier epoch ${highest}`)
    }
    highest = epoch
  }
}

/** Validate every routing record already present in one loaded session. */
function validateSession(session: Session, fail: InvariantFailure): void {
  validateEpochSequence(session, fail)
  for (const [index, event] of session.events.entries()) {
    if (event.type === 'model/routing-decision') {
      validateRoutingDecision(session.events.slice(0, index), event, fail)
    }
  }
}

/** Install validation for loaded and newly appended routing records. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateSession(session, fail)
  ctx.on('session/created', (session) => { validateSession(session, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type === 'model/selection-authority') {
      validateAuthorityEvent(event, fail)
      // Epoch progression must also hold for freshly appended states.
      const epoch = event.data.authorityEpoch
      const last = session.events[session.events.length - 1]
      if (last !== undefined && last.type === 'model/selection-authority' && last.seq === event.seq) {
        // The event is already in the log; the prior state sits just below it.
      }
      for (let at = session.events.length - (last !== undefined && last.seq === event.seq ? 2 : 1); at >= 0; at -= 1) {
        const prior: SessionEvent | undefined = session.events[at]
        if (prior === undefined || prior.type !== 'model/selection-authority') continue
        if (typeof epoch === 'number' && epoch <= prior.data.authorityEpoch) {
          fail(`model/selection-authority authorityEpoch ${epoch} regressed below an earlier epoch ${prior.data.authorityEpoch}`)
        }
        break
      }
    }
    else if (event.type === 'model/routing-decision') validateRoutingDecision(session.events, event, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the model-router invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
