/**
 * Durable routing-decision record types. The browser-safe payload of the
 * `model/routing-decision` session event, shared by the policy runtime and any
 * remote renderer that wants to explain a route without loading it.
 *
 * v0.15.3 split: WHO owns a session's model selection lives in the separate
 * `model/selection-authority` event (declared in `@deepseek-ai/dsh-agent`,
 * policy-version independent); THIS event records WHAT the router decided.
 * `activeAuthority` joins the two streams per decision.
 *
 * @module @deepseek-ai/dsh-llm-model-router/types
 */

import type { ModelSelectionAuthority } from '@deepseek-ai/dsh-agent'
import type { ComplexitySignals } from './complexity.ts'

/** Who owned the route of one request (strongest first). */
export type RoutingAuthority =
  /** A deliberate selection (web picker, SDK initialize) named the route. */
  | 'explicit-selection'
  /** The session's operator configured a model outside both tiers. */
  | 'foreign-route'
  /** The owning delegation owns a subagent's route. */
  | 'subagent-owner'
  /** The router policy owned the route for this request. */
  | 'router'

/** Why the decision came out the way it did; every value is log-renderable. */
export type RoutingReason =
  | 'subagent-passthrough'
  | 'foreign-route-passthrough'
  | 'explicit-selection-passthrough'
  | 'explicit-heavy-retained'
  | 'turn-route-retained'
  | 'mid-turn-escalated'
  | 'escalated-to-heavy'
  | 'routed-fast'

/**
 * Monotonic per-session authority epoch. Every recorded authority transition
 * increments it, so a record with a lower epoch can never regain authority over
 * a later one. v0.15.3 moved epoch authority to the `model/selection-authority`
 * event; this type survives for READING v0.15.2 routing decisions, whose
 * `authorityEpoch` field (optional below) is the legacy carrier.
 */
export type AuthorityEpoch = number

/** Which discovered-complexity bound triggered one mid-turn escalation. */
export type DiscoveredTrigger =
  | 'tool-calls'
  | 'tool-result-volume'
  | 'composite'

/** The measured facts behind one mid-turn escalation, for threshold calibration. */
export interface DiscoveredComplexity {
  /** `tool/call` events inside the turn at the escalation step. */
  toolCalls: number
  /** Cumulative `tool/result` text characters inside the turn at the escalation step. */
  toolResultChars: number
  /** Which bound (or both) crossed the configured trigger. */
  trigger: DiscoveredTrigger
}

/** Durable, non-surface record of one routing decision that changed or claimed route ownership. */
export interface ModelRoutingDecisionEventData {
  /** The open turn the decision covers. */
  turn: number
  /** The step whose request the decision routed. */
  step: number
  /** Correlation id for outcome/cost joins (v0.15.3+); absent on earlier records. */
  routingDecisionId?: string
  /** The provider/model the rest of the waterfall proposed. */
  proposed: { provider: string; model: string }
  /** The provider/model the router returned. */
  selected: { provider: string; model: string }
  /** Who owned THIS decision (router, or the authority the router deferred to). */
  authority: RoutingAuthority
  /** The session's durable selection authority in force at this decision (v0.15.3+); absent on earlier records. */
  activeAuthority?: ModelSelectionAuthority
  /** Legacy v0.15.2 carrier of the authority epoch; v0.15.3+ writes no value here. */
  authorityEpoch?: AuthorityEpoch
  /** The deterministic reason for the outcome. */
  reason: RoutingReason
  /** The complexity score behind a scoring decision; absent on passthroughs. */
  score?: number
  /** Raw per-signal counts behind the score; same presence rule as {@link score}. */
  signals?: ComplexitySignals
  /** The measured facts behind a mid-turn escalation; present only on `mid-turn-escalated`. */
  discovered?: DiscoveredComplexity
  /** The escalation threshold in force. */
  threshold: number
  /** Router policy version, for correlating decisions across releases. */
  policyVersion: number
  /** Complexity scorer implementation version; v0.15.4+ records. */
  scorerVersion?: number
  /** Canonical hash of the effective routing configuration; v0.15.4+ records. */
  configFingerprint?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable, non-surface record of one tiered-routing decision that changed or claimed route ownership. */
    'model/routing-decision': ModelRoutingDecisionEventData
  }
}
