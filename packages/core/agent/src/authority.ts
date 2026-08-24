/**
 * Durable model-selection state: the ONE authoritative record of who owns a
 * session's model choice and what that choice is, as a session event rather
 * than process-local state.
 *
 * v0.15.4 replaces the fragmented control plane (authority event + WeakMap +
 * picked model + request header) with a single durable `ModelSelectionState`:
 * mode `auto` (automatic routing / deployment default owns the choice) or
 * mode `manual` (a deliberate claim owns it, carrying the COMPLETE selection
 * — provider, model, and reasoning effort). Every semantic change appends a
 * new state (a same-authority Pro→Flash switch is a transition, not a
 * no-op); epochs are strictly increasing across every schema version; and
 * reconstruction is exhaustive and conservative — a manual state restores
 * both authority AND selection, an unknown FUTURE schema fails closed
 * (defers) instead of resurrecting older history.
 *
 * Authority and routing policy remain deliberately different concepts: this
 * event carries its own `authoritySchemaVersion`, never a router policy
 * version, so no router upgrade can erase a recorded human choice.
 *
 * @module @deepseek-ai/dsh-agent/authority
 */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** Who owns the model selection of a session. */
export type ModelSelectionAuthority =
  /** No deliberate claim recorded; the deployment default and any routing policy apply. */
  | 'default'
  /** Automatic routing owns the tier choice (the "Auto" operator mode). */
  | 'router'
  /** A human user made the selection (web picker, TUI). */
  | 'user'
  /** An SDK caller made the selection (initialize parameters). */
  | 'sdk'
  /** A deployment policy made the selection. */
  | 'policy'
  /** The owning delegation owns a subagent's selection. */
  | 'subagent-owner'

/** Which surface made one authority claim. */
export type AuthoritySource =
  | 'web'
  | 'sdk'
  | 'api'
  | 'cli'
  | 'router'
  | 'subagent'
  | 'system'

/** Schema version of the authority event itself — independent of every router policy version. */
export const AUTHORITY_SCHEMA_VERSION = 2

/** The complete selected route carried by a manual state. */
export interface ManualModelSelection {
  /** Provider route of the deliberate selection. */
  provider: string
  /** Model of the deliberate selection. */
  model: string
  /** Adapter-owned reasoning effort of the deliberate selection. */
  reasoningEffort?: string
}

/** One durable model-selection state: automatic, or manually claimed. */
export type ModelSelectionState =
  | {
    /** Automatic: the router (or deployment default without one) owns the choice. */
    readonly mode: 'auto'
    /** Why automatic applies: the router owns routing, or no claim exists. */
    readonly authority: 'router' | 'default'
    /** Session-level authority epoch; strictly increasing, never reset. */
    readonly authorityEpoch: number
    /** Which surface produced this state. */
    readonly source: AuthoritySource
  }
  | {
    /** Manual: a deliberate claim owns the choice. */
    readonly mode: 'manual'
    /** The claiming authority. */
    readonly authority: Extract<ModelSelectionAuthority, 'user' | 'sdk' | 'policy' | 'subagent-owner'>
    /** The complete selection this claim owns. */
    readonly selection: ManualModelSelection
    /** Session-level authority epoch; strictly increasing, never reset. */
    readonly authorityEpoch: number
    /** Which surface produced this state. */
    readonly source: AuthoritySource
  }

/**
 * Durable, non-surface record of one complete model-selection state
 * transition. The LATEST such event for a session is the authoritative
 * selection state; every earlier one is history.
 */
export interface ModelSelectionAuthorityEventData {
  /** Which mode this state establishes. */
  mode: 'auto' | 'manual'
  /** The authority in force under this state. */
  authority: ModelSelectionAuthority
  /** The complete selection; present on manual states, absent on auto states. */
  selection?: ManualModelSelection
  /** Session-level authority epoch: strictly increasing across claims, never reset by policy changes. */
  authorityEpoch: number
  /** Which surface made the claim. */
  source: AuthoritySource
  /** Short human-readable cause of the transition. */
  reason?: string
  /** Schema version of this event; readers refuse other versions. */
  authoritySchemaVersion: 2
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable, non-surface record of one complete model-selection state transition (manual claim, Auto release, delegation). */
    'model/selection-authority': ModelSelectionAuthorityEventData
  }
}

/** Live process-local cache of one session's current manual state. */
export interface ExplicitSelectionMark {
  /** Epoch milliseconds of the claim. */
  at: number
  /** The complete manual state as claimed. */
  state: Extract<ModelSelectionState, { mode: 'manual' }>
}

const explicitSelections = new WeakMap<object, ExplicitSelectionMark>()

/** Authority/permission mapping: which sources may claim which authority. */
const SOURCE_AUTHORITIES: Readonly<Record<AuthoritySource, readonly ModelSelectionAuthority[]>> = {
  web: ['user'],
  api: ['user', 'policy'],
  cli: ['user', 'policy'],
  sdk: ['sdk'],
  router: ['router', 'default'],
  subagent: ['subagent-owner'],
  system: ['policy', 'default', 'router'],
}

/**
 * The epoch of the next authority claim for one session: one above the highest
 * epoch ever persisted, across BOTH authority events (all schema versions —
 * reusing an epoch some future-schema event already wrote could collide when
 * that schema becomes current) and the legacy `model/routing-decision` events
 * (which carried `authorityEpoch` between v0.15.2 and v0.15.3). Epochs never
 * reset — a restart or a router policy upgrade cannot make an old epoch
 * reusable.
 * @param events - the session's durable event log.
 * @returns the next authority epoch (1 for a session with no claims yet).
 */
export function nextAuthorityEpoch(events: readonly SessionEvent[]): number {
  let max = 0
  for (const event of events) {
    if (event.type === 'model/selection-authority') {
      const epoch = event.data.authorityEpoch
      if (typeof epoch === 'number' && epoch > max) max = epoch
      continue
    }
    // Legacy field: routing decisions recorded an epoch before authority
    // moved to its own event. Widened string comparison — the
    // routing-decision vocabulary belongs to the router package, which is
    // deliberately NOT a dependency (or project reference) here, so the
    // compile-time event union does not include it.
    if ((event.type as string) === 'model/routing-decision') {
      const epoch = (event.data as { authorityEpoch?: unknown }).authorityEpoch
      if (typeof epoch === 'number' && epoch > max) max = epoch
    }
  }
  return max + 1
}

/** Compare two manual selections field-wise (reasoningEffort included). */
function sameSelection(a: ManualModelSelection | undefined, b: ManualModelSelection | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort
}

/**
 * Reconstruct the LATEST durable model-selection state of one session.
 *
 * Exhaustive over the current schema's vocabulary and conservative about
 * everything else:
 * - a current-schema event decides (manual restores authority AND the
 *   complete selection; auto releases to automatic; `default` means no
 *   deliberate claim);
 * - a v0.15.3 schema-1 event decides by its legacy meaning (router/default →
 *   auto; user/sdk/policy/subagent-owner → manual over its provider/model);
 * - an event from a FUTURE schema version fails closed: reconstruction stops
 *   and reports the unknown state, so an older runtime never resurrects
 *   superseded history after a downgrade.
 * @param events - the session's durable event log.
 * @returns the latest state, `{ undecidable: true }` when only a future
 * schema can explain the log, or `undefined` when no state was ever recorded.
 */
export function reconstructSelectionState(
  events: readonly SessionEvent[],
): ModelSelectionState | { readonly undecidable: true } | undefined {
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const event: SessionEvent | undefined = events[at]
    if (event === undefined) continue
    if (event.type !== 'model/selection-authority') continue
    const version = event.data.authoritySchemaVersion
    if (typeof version === 'number' && version > AUTHORITY_SCHEMA_VERSION) {
      // Future schema: this runtime cannot know what that state means.
      // Failing closed (deferring) is safe; reinterpreting older history is not.
      return { undecidable: true }
    }
    if (version !== AUTHORITY_SCHEMA_VERSION) {
      // Legacy v0.15.3 schema-1 carrier: map its meaning.
      const legacy = event.data as unknown as {
        authority: ModelSelectionAuthority
        provider?: string
        model?: string
        authorityEpoch: number
        source: AuthoritySource
      }
      if (legacy.authority === 'user' || legacy.authority === 'sdk'
        || legacy.authority === 'policy' || legacy.authority === 'subagent-owner') {
        return {
          mode: 'manual',
          authority: legacy.authority,
          selection: { provider: legacy.provider ?? '', model: legacy.model ?? '' },
          authorityEpoch: legacy.authorityEpoch,
          source: legacy.source,
        }
      }
      // router | default → automatic.
      return {
        mode: 'auto',
        authority: legacy.authority === 'default' ? 'default' : 'router',
        authorityEpoch: legacy.authorityEpoch,
        source: legacy.source,
      }
    }
    const data = event.data
    if (data.mode === 'manual') {
      const authority = data.authority as Extract<ModelSelectionAuthority, 'user' | 'sdk' | 'policy' | 'subagent-owner'>
      if (authority !== 'user' && authority !== 'sdk' && authority !== 'policy' && authority !== 'subagent-owner') {
        // Malformed manual state (authority not in the manual vocabulary):
        // treat conservatively as undecidable rather than guessing.
        return { undecidable: true }
      }
      const selection = data.selection
      if (selection === undefined || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
        return { undecidable: true }
      }
      return {
        mode: 'manual',
        authority,
        selection,
        authorityEpoch: data.authorityEpoch,
        source: data.source,
      }
    }
    // mode auto: exhaustive over the authorities that may establish it.
    if (data.authority === 'router' || data.authority === 'default') {
      return {
        mode: 'auto',
        authority: data.authority,
        authorityEpoch: data.authorityEpoch,
        source: data.source,
      }
    }
    // An auto state naming a manual authority is malformed: fail closed.
    return { undecidable: true }
  }
  return undefined
}

/** Append one state transition when it is a real semantic change. */
function appendState(
  session: Session,
  next: ModelSelectionState,
  reason: string,
  prior: ModelSelectionState | { undecidable: true } | undefined,
): void {
  // Suppress ONLY a complete no-op: same mode, authority, selection, and
  // source. A same-authority Pro→Flash switch, or a web→api provenance
  // change, is a semantic transition and records.
  if (prior !== undefined && !('undecidable' in prior) && prior.mode === next.mode
    && prior.authority === next.authority && prior.source === next.source
    && sameSelection(
      prior.mode === 'manual' ? prior.selection : undefined,
      next.mode === 'manual' ? next.selection : undefined,
    )) {
    return
  }
  session.append('model/selection-authority', {
    mode: next.mode,
    authority: next.authority,
    ...next.mode === 'manual' ? { selection: next.selection } : {},
    authorityEpoch: nextAuthorityEpoch(session.events),
    source: next.source,
    reason,
    authoritySchemaVersion: AUTHORITY_SCHEMA_VERSION,
  } as ModelSelectionAuthorityEventData)
}

/**
 * Claim a deliberate manual model selection for one session: sets the live
 * cache AND appends a durable complete-state transition, so the claim (with
 * its full selection) survives restarts and router policy upgrades
 * independently of any routing plugin. Authority/source combinations are
 * validated — provenance is never silently reinterpreted.
 * @param session - the live Session whose selection is claimed.
 * @param claim - the claiming authority, surface, and complete selection.
 * @throws when the surface may not claim that authority.
 */
export function claimModelSelection(
  session: Session,
  claim: {
    authority: Extract<ModelSelectionAuthority, 'user' | 'sdk' | 'policy' | 'subagent-owner'>
    source: AuthoritySource
    selection: ManualModelSelection
    reason?: string
  },
): void {
  const allowed = SOURCE_AUTHORITIES[claim.source] ?? []
  if (!allowed.includes(claim.authority)) {
    throw new Error(
      `model-selection authority "${claim.authority}" may not be claimed from source "${claim.source}" `
      + `(allowed: ${allowed.join(', ') || 'none'})`,
    )
  }
  const prior = reconstructSelectionState(session.events)
  const next: ModelSelectionState = {
    mode: 'manual',
    authority: claim.authority,
    selection: claim.selection,
    authorityEpoch: 0,
    source: claim.source,
  }
  explicitSelections.set(session, { at: Date.now(), state: next })
  appendState(session, next, claim.reason ?? `manual selection via ${claim.source}`, prior)
}

/**
 * Release manual authority — the "Auto" operator mode. Appends a durable
 * auto state whenever the DURABLE state is manual (reconstructed from the
 * event log, never gated on the process-local WeakMap), so Auto works after a
 * real process restart. Idempotent: an already-automatic session records
 * nothing.
 * @param session - the live Session returning to automatic selection.
 * @param source - the surface requesting Auto.
 */
export function releaseToAuto(session: Session, source: AuthoritySource = 'web'): void {
  const prior = reconstructSelectionState(session.events)
  if (prior === undefined || (!('undecidable' in prior) && prior.mode === 'auto')) {
    // No durable manual state exists (never claimed, already automatic, or an
    // auto state is already latest): nothing to release, the cache agrees.
    explicitSelections.delete(session)
    return
  }
  const next: ModelSelectionState = {
    mode: 'auto',
    authority: 'router',
    authorityEpoch: 0,
    source,
  }
  explicitSelections.delete(session)
  appendState(session, next, 'automatic selection restored', prior)
}

/** Backward-compatible alias: the v0.15.3 name for {@link releaseToAuto}. */
export const clearExplicitModelSelection = releaseToAuto

/**
 * Record a deliberate explicit model selection (validated provenance; complete
 * durable state). Kept as the v0.15.3-compatible entry point used by the web
 * picker and SDK initialize surfaces.
 * @param session - the live Session whose selection was explicitly made.
 * @param source - the surface making the claim (web picker, SDK, …).
 * @param route - the selected provider/model pair, when the claim names one.
 */
export function markExplicitModelSelection(
  session: Session,
  source: AuthoritySource = 'web',
  route?: { provider: string; model: string; reasoningEffort?: string },
): void {
  if (route === undefined || route.provider.length === 0 || route.model.length === 0) {
    throw new Error(
      'a manual model selection must name its complete route (provider and model); '
      + 'a selection without a route is not a claim — use releaseToAuto for automatic selection',
    )
  }
  const authority: Extract<ModelSelectionAuthority, 'user' | 'sdk'> = source === 'sdk' ? 'sdk' : 'user'
  claimModelSelection(session, {
    authority,
    source,
    selection: {
      provider: route.provider,
      model: route.model,
      ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
    },
  })
}

/**
 * Read one session's live manual-selection mark, if any. The mark is a
 * process-local cache; the durable `model/selection-authority` events are
 * authoritative across restarts.
 * @param session - the live Session to inspect.
 * @returns the mark recorded by the most recent manual claim, or `undefined`.
 */
export function explicitModelSelectionMark(session: object): ExplicitSelectionMark | undefined {
  return explicitSelections.get(session)
}
