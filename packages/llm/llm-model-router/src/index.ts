/**
 * Complexity-tiered model routing through the agent loop's `agent/request`
 * waterfall. A deployment names one fast route and one heavy route; each turn
 * is scored by its opening request messages and served by the fast route until
 * the reading crosses the escalation threshold.
 *
 * Authority rules (v2): a session whose model was selected explicitly in this
 * process (`markExplicitModelSelection`, set by the web model picker and SDK
 * entry points) is not router-managed at all — an explicit choice outranks any
 * optimization policy in both directions. When no explicit mark exists, a
 * heavy proposal counts as router-owned only while the router can prove
 * continuity: either its own durable `model/routing-decision` history (which
 * also reconstructs ownership after a process restart) or a field-wise match
 * against the config the router last returned. Model equality alone is never
 * proof of ownership.
 *
 * @module @deepseek-ai/dsh-llm-model-router
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { callConfigEquals } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { explicitModelSelectionMark, reconstructSelectionState } from '@deepseek-ai/dsh-agent'
import type { ModelSelectionAuthority } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { DEFAULT_ESCALATION_THRESHOLD, noFamilyAloneReaches, SCORER_VERSION, scoreComplexity } from './complexity.ts'
import { assertDistinctMarkers } from './complexity.ts'
import type { ComplexityReading, ExtraMarkers } from './complexity.ts'
import type { DiscoveredComplexity, DiscoveredTrigger, ModelRoutingDecisionEventData, RoutingReason } from './types.ts'

export { DEFAULT_ESCALATION_THRESHOLD, noFamilyAloneReaches, SCORER_VERSION, scoreComplexity } from './complexity.ts'
export type { ComplexityReading, ComplexitySignals, ExtraMarkers } from './complexity.ts'
export type { AuthorityEpoch, DiscoveredComplexity, DiscoveredTrigger, ModelRoutingDecisionEventData, RoutingAuthority, RoutingReason } from './types.ts'
export { classifyTaskType, taskTypeExpectsProAdvantage } from './task-classifier.ts'
export { WORKLOAD_FEATURE_VERSION, analyzeTaskStructure } from './task-structure.ts'
export type { TransformationType, RequestedOutputType, OutputLengthBand, WorkloadTaskCategory, WorkloadContextInput, ConstraintStructureFeatures, TransformationFeatures, OutputStructureFeatures, WorkloadFeaturesV2 } from './task-structure.ts'
export { deriveBayesianHistoricalFeatures } from './historical-features.ts'
export type { HistoricalOutcomeObservation, BayesianHistoryPrior, BayesianHistoricalFeatures } from './historical-features.ts'
export { trainModel, predict, flattenFeatures, FEATURE_NAMES, FEATURE_VERSION, MODEL_VERSION } from './learned-router.ts'
export type { TrainingExample, TrainedModel } from './learned-router.ts'
export type { TaskType, PreRoutingFeatureVector, StructuralFeatures, CategoricalFeatures, HistoricalFeatures, ModelPredictions } from './shadow-types.ts'

/** Router policy version; stamped into every durable routing decision. */
export const POLICY_VERSION = 2

/** Cordis plugin name used by loader diagnostics. */
export const name = 'llm-model-router'

/** No service dependency: the router is a pure `agent/request` listener. */
export const inject: readonly string[] = []

/** One configured tier: a provider route plus its optional reasoning effort. */
export interface RouteConfig {
  /** Provider route id as registered on `ctx.llm`. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort for this tier; omitted lets the adapter default apply. */
  reasoningEffort?: string
}

/** Discovered-complexity triggers for one-way mid-turn escalation. */
export interface DiscoveredEscalationConfig {
  /** Tool calls within the turn at or above which the turn escalates. Default 8. */
  minToolCalls?: number
  /** Cumulative tool-result characters at or above which the turn escalates. Default 24000. */
  minToolResultChars?: number
}

/** Plugin config: the two tiers and the routing policy scalars. */
export interface ModelRouterConfig {
  /** The default tier: fast, cheap, tool-shaped work. */
  fastRoute: RouteConfig
  /** The escalation tier: high-capacity reasoning. */
  heavyRoute: RouteConfig
  /** Complexity score at or above which the heavy route serves the turn. */
  escalationThreshold?: number
  /** Whether child (subagent) sessions are routed too; default leaves their model policy to their owner. */
  routeSubagents?: boolean
  /** Deployment-supplied marker vocabulary per signal family. */
  extraMarkers?: ExtraMarkers
  /** Discovered-complexity triggers for one-way mid-turn escalation; `false` disables. */
  discoveredEscalation?: DiscoveredEscalationConfig | false
  /** Record every routing decision durably (telemetry mode); default records only ownership changes. */
  recordAllDecisions?: boolean
}

const routeSchema: z<RouteConfig> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  reasoningEffort: z.string(),
})

/** Schemastery validation for {@link ModelRouterConfig}. */
export const Config: z<ModelRouterConfig> = z.object({
  fastRoute: routeSchema.required(),
  heavyRoute: routeSchema.required(),
  escalationThreshold: z.number().step(1).min(1).default(DEFAULT_ESCALATION_THRESHOLD),
  routeSubagents: z.boolean().default(false),
  extraMarkers: z.object({
    reasoning: z.array(String),
    math: z.array(String),
    architecture: z.array(String),
  }),
  discoveredEscalation: z.union([z.object({
    minToolCalls: z.number().step(1).min(1),
    minToolResultChars: z.number().step(1).min(1),
  }), z.const(false)]),
  recordAllDecisions: z.boolean().default(false),
})

/** Default tool-call count at which discovered complexity escalates a turn. */
export const DEFAULT_MIN_TOOL_CALLS = 8
/** Default cumulative tool-result characters at which discovered complexity escalates a turn. */
export const DEFAULT_MIN_TOOL_RESULT_CHARS = 24_000

/** One validated tier. */
export interface ResolvedRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: ReasoningEffortId
}

/** Validated plugin config, re-judged beyond Schemastery for programmatic construction. */
export interface ResolvedModelRouterConfig {
  readonly fastRoute: ResolvedRoute
  readonly heavyRoute: ResolvedRoute
  readonly escalationThreshold: number
  readonly routeSubagents: boolean
  readonly extraMarkers: ExtraMarkers
  readonly discoveredEscalation:
    | { readonly minToolCalls: number; readonly minToolResultChars: number }
    | false
  readonly recordAllDecisions: boolean
  /** Canonical hash of the effective configuration, stamped into every durable decision. */
  readonly configFingerprint: string
}

function resolveRoute(route: RouteConfig, label: string): ResolvedRoute {
  if (route.provider.length === 0) throw new Error(`llm-model-router: ${label} provider must be non-empty`)
  if (route.model.length === 0) throw new Error(`llm-model-router: ${label} model must be non-empty`)
  if (route.reasoningEffort !== undefined && route.reasoningEffort.length === 0) {
    throw new Error(`llm-model-router: ${label} reasoningEffort must be non-empty when present`)
  }
  return {
    provider: route.provider,
    model: route.model,
    ...route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) },
  }
}

function resolveMarkers(markers: ExtraMarkers | undefined): ExtraMarkers {
  if (markers === undefined) return {}
  for (const [family, list] of Object.entries(markers) as Array<[string, string[] | undefined]>) {
    if (list === undefined) continue
    if (list.some((marker: string) => marker.length === 0)) {
      throw new Error(`llm-model-router: extraMarkers.${family} must not contain empty markers`)
    }
  }
  // Cross-family corroboration must be real evidence: a marker that hits two
  // families (or double-counts one) is fake independence. Validated here, not
  // silently tolerated.
  assertDistinctMarkers(markers)
  return markers
}

/**
 * Validate and detach the plugin config.
 * @param config - raw plugin config.
 * @returns the two validated tiers and policy scalars.
 * @throws when a route is empty, the two tiers name the same provider/model
 * pair, the threshold is not a safe positive integer, the threshold sits at or
 * below a signal-family cap (the cross-family corroboration policy — "no
 * single family can escalate alone" — would then be silently violated), a
 * discovered-escalation bound is not a positive safe integer, or the configured
 * marker vocabulary overlaps across families.
 */
export function resolveConfig(config: ModelRouterConfig): ResolvedModelRouterConfig {
  const fastRoute = resolveRoute(config.fastRoute, 'fastRoute')
  const heavyRoute = resolveRoute(config.heavyRoute, 'heavyRoute')
  if (fastRoute.provider === heavyRoute.provider && fastRoute.model === heavyRoute.model) {
    throw new Error('llm-model-router: fastRoute and heavyRoute must name different provider/model pairs')
  }
  const escalationThreshold = config.escalationThreshold ?? DEFAULT_ESCALATION_THRESHOLD
  if (!Number.isSafeInteger(escalationThreshold) || escalationThreshold < 1) {
    throw new Error('llm-model-router: escalationThreshold must be a positive safe integer')
  }
  // Enforce the calibration contract at load, not just in docs: with the
  // default family caps (3/3/3/2/2), thresholds 1–3 would let one keyword
  // family escalate a turn alone.
  if (!noFamilyAloneReaches(escalationThreshold)) {
    throw new Error(
      `llm-model-router: escalationThreshold ${escalationThreshold} violates the cross-family corroboration policy: `
      + 'every signal-family cap must stay strictly below the threshold so no single family can escalate alone',
    )
  }
  const extraMarkers = resolveMarkers(config.extraMarkers)
  const discoveredEscalation = config.discoveredEscalation === false
    ? false
    : config.discoveredEscalation === undefined
      ? { minToolCalls: DEFAULT_MIN_TOOL_CALLS, minToolResultChars: DEFAULT_MIN_TOOL_RESULT_CHARS }
      : {
        minToolCalls: config.discoveredEscalation.minToolCalls ?? DEFAULT_MIN_TOOL_CALLS,
        minToolResultChars: config.discoveredEscalation.minToolResultChars ?? DEFAULT_MIN_TOOL_RESULT_CHARS,
      }
  if (discoveredEscalation !== false) {
    for (const [bound, value] of [['minToolCalls', discoveredEscalation.minToolCalls], ['minToolResultChars', discoveredEscalation.minToolResultChars]] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`llm-model-router: discoveredEscalation.${bound} must be a positive safe integer`)
      }
    }
  }
  const routeSubagents = config.routeSubagents ?? false
  const recordAllDecisions = config.recordAllDecisions ?? false
  // Configuration fingerprint: which exact configuration made these
  // decisions? Two deployments can share POLICY_VERSION and SCORER_VERSION
  // yet configure different markers, thresholds, or routes; the canonical
  // hash keeps experimental datasets honest under configuration drift.
  const canonical = JSON.stringify({
    escalationThreshold,
    fastRoute,
    heavyRoute,
    routeSubagents,
    extraMarkers,
    discoveredEscalation,
    recordAllDecisions,
  })
  const configFingerprint = createHash('sha256').update(canonical).digest('hex').slice(0, 16)
  return {
    fastRoute,
    heavyRoute,
    escalationThreshold,
    routeSubagents,
    extraMarkers,
    discoveredEscalation,
    recordAllDecisions,
    configFingerprint,
  }
}

/**
 * Derive the deterministic identity of one routing decision from its
 * execution coordinates: (session, turn, step) plus policy and configuration.
 * Replaying the same request under the same configuration reproduces the same
 * id — event-sourced analysis can join decisions without a random UUID that
 * differs per evaluation.
 * @param sessionId - the deciding session's id.
 * @param turn - the open turn.
 * @param step - the step whose request is being routed.
 * @param policyVersion - the router policy in force.
 * @param configFingerprint - the effective configuration's canonical hash.
 * @returns a stable decision identity string.
 */
export function routingDecisionIdentity(
  sessionId: string,
  turn: number,
  step: number,
  policyVersion: number,
  configFingerprint: string,
): string {
  return createHash('sha256')
    .update(`${sessionId}:${turn}:${step}:${policyVersion}:${configFingerprint}`)
    .digest('hex')
    .slice(0, 24)
}

/**
 * Concatenate one turn's request-authored message text from the session log.
 * Direct human prompts (`source.kind === 'user'`) and parent-coordinator
 * delegations (`source.kind === 'coordinator'`) both count — they are the two
 * sources that ASK for work — while plugin-injected context, child reports,
 * and tool output never move the routing needle.
 * @param events - the session log.
 * @param turn - the open turn number.
 * @returns the turn's request text joined by newlines, or `''` when the turn has none.
 */
export function turnUserText(events: readonly SessionEvent[], turn: number): string {
  const start = events.findLastIndex(event => event.type === 'turn/start' && event.data.turn === turn)
  if (start < 0) return ''
  const texts: string[] = []
  for (const event of events.slice(start + 1)) {
    // The next turn boundary closes the scan: an open turn never contains a
    // later turn/start, but a scoring call against a closed history must not
    // read past the turn it was asked about.
    if (event.type === 'turn/start') break
    if (event.type !== 'user/message') continue
    // Widened comparison: the coordinator source kind is merge-extensible and
    // declared by dsh-subagent, which is deliberately NOT a project reference
    // of this package — the runtime check stays string-based so the package
    // compiles against the base vocabulary alone.
    const sourceKind: string = event.data.source.kind
    if (sourceKind !== 'user' && sourceKind !== 'coordinator') continue
    for (const block of event.data.content) {
      if (block.type === 'text') texts.push(block.text)
    }
  }
  return texts.join('\n')
}

/** Discovered-complexity facts for one turn, gathered from its executed work. */
export interface DiscoveredFacts {
  /** `tool/call` events inside the turn so far. */
  readonly toolCalls: number
  /** Cumulative `tool/result` text characters inside the turn so far. */
  readonly toolResultChars: number
}

/** Count text characters across content blocks, recursing into tool-result wrappers. */
function textChars(blocks: readonly ContentBlock[]): number {
  let chars = 0
  for (const block of blocks) {
    if (block.type === 'text') chars += block.text.length
    else if (block.type === 'tool-result') chars += textChars(block.content)
  }
  return chars
}

/**
 * Count one turn's discovered-complexity facts from the session log. A single
 * reverse scan shared with scoring keeps the per-request cost proportional to
 * the turn, not the session.
 * @param events - the session log.
 * @param turn - the turn to measure.
 * @returns the turn's tool-call count and cumulative tool-result characters.
 */
export function turnDiscoveredFacts(events: readonly SessionEvent[], turn: number): DiscoveredFacts {
  const start = events.findLastIndex(event => event.type === 'turn/start' && event.data.turn === turn)
  if (start < 0) return { toolCalls: 0, toolResultChars: 0 }
  let toolCalls = 0
  let toolResultChars = 0
  for (const event of events.slice(start + 1)) {
    if (event.type === 'turn/start') break
    if (event.type === 'tool/call') toolCalls += 1
    if (event.type === 'tool/result') toolResultChars += textChars(event.data.message.content)
  }
  return { toolCalls, toolResultChars }
}

/** The router's per-session memory: what it decided for the last turn it saw. */
export interface RoutingMemory {
  /** The turn the memory describes; 0 when no route continuity applies. */
  readonly turn: number
  /** The config the router itself returned for that turn; `undefined` when it deferred. */
  readonly decided: LlmCallConfig | undefined
  /** Whether this memory came from the durable event history (restart) rather than a live decision. */
  readonly source: 'direct' | 'reconstructed'
  /**
   * Durable explicit authority: a live selection mark exists, or the latest
   * durable authority record names user/sdk/policy. While true the router
   * defers entirely — and unlike the process-local mark alone, the
   * reconstructed form survives restarts AND router policy upgrades.
   */
  readonly explicit: boolean
  /** The session's durable selection authority this memory describes. */
  readonly authority: ModelSelectionAuthority
}

/** Lazy per-request facts: computed at most once, only when the policy needs them. */
export interface LazyTurnFacts {
  /** The turn's request-authored text (user + coordinator). */
  readonly userText: () => string
  /** The turn's discovered complexity (tool calls and result volume). */
  readonly discovered: () => DiscoveredFacts
}

/** Inputs to one routing decision, all explicit so the policy is unit-testable. */
export interface RoutingDecisionInput {
  /** The deciding session's id; anchors the deterministic decision identity. */
  readonly sessionId: string
  /** The config downstream listeners (session selection, defaults) proposed. */
  readonly proposed: LlmCallConfig
  /** Whether the requesting session carries a live explicit-selection mark or durable explicit authority. */
  readonly explicitSelection: boolean
  /** The session's durable selection authority in force (user/sdk/policy when explicit). */
  readonly activeAuthority: ModelSelectionAuthority
  /** Whether the requesting session is a child (subagent) session. */
  readonly isSubagent: boolean
  /** The open turn number. */
  readonly turn: number
  /** The step whose request this is; step 1 opens the turn's route. */
  readonly step: number
  /** Lazy turn facts; read only when the policy actually scores or measures. */
  readonly facts: LazyTurnFacts
  /** The router's memory for this session, if any. */
  readonly memory: RoutingMemory | undefined
  /** Validated routing config. */
  readonly config: ResolvedModelRouterConfig
}

/** One routing decision: the config to use, the memory to keep, why, and the durable record. */
export interface RoutingDecision {
  /** The config the agent request should use. */
  readonly config: LlmCallConfig
  /** The memory to store for this session. */
  readonly memory: RoutingMemory
  /** The human-readable decision reason. */
  readonly reason: RoutingReason
  /** The complexity reading behind a scoring decision; absent on passthroughs. */
  readonly reading: ComplexityReading | undefined
  /** The measured facts behind a mid-turn escalation; present only with reason `mid-turn-escalated`. */
  readonly discovered: DiscoveredComplexity | undefined
  /** The durable record to append for this decision, or `undefined` when nothing changed. */
  readonly record: ModelRoutingDecisionEventData | undefined
}

/** Whether a proposed config already aims at one tier. */
function isRoute(config: LlmCallConfig, route: ResolvedRoute): boolean {
  return config.provider === route.provider && config.model === route.model
}

/** Re-aim a proposed config at one tier, keeping sampling scalars, dropping the previous model's effort. */
function routedConfig(proposed: LlmCallConfig, route: ResolvedRoute): LlmCallConfig {
  const { reasoningEffort: _previous, ...sampling } = proposed
  return {
    ...sampling,
    provider: route.provider,
    model: route.model,
    ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
  }
}

/** Assemble the durable record for one decision. The decision identity is
 * DETERMINISTIC (execution coordinates + policy + configuration): replaying
 * the same request reproduces the same id, so decideRoute stays pure. */
function decisionRecord(
  input: RoutingDecisionInput,
  decision: Omit<RoutingDecision, 'record'>,
  authority: ModelRoutingDecisionEventData['authority'],
  activeAuthority: ModelSelectionAuthority,
): ModelRoutingDecisionEventData {
  return {
    turn: input.turn,
    step: input.step,
    routingDecisionId: routingDecisionIdentity(
      input.sessionId, input.turn, input.step, POLICY_VERSION, input.config.configFingerprint,
    ),
    proposed: { provider: input.proposed.provider, model: input.proposed.model },
    selected: { provider: decision.config.provider, model: decision.config.model },
    authority,
    activeAuthority,
    reason: decision.reason,
    ...decision.reading === undefined
      ? {}
      : { score: decision.reading.score, signals: decision.reading.signals },
    ...decision.discovered === undefined ? {} : { discovered: decision.discovered },
    threshold: input.config.escalationThreshold,
    policyVersion: POLICY_VERSION,
    scorerVersion: SCORER_VERSION,
    configFingerprint: input.config.configFingerprint,
  }
}

/** Which discovered bound (or both) crossed the configured trigger. */
function discoveredTrigger(facts: DiscoveredFacts, minToolCalls: number, minToolResultChars: number): DiscoveredTrigger {
  const calls = facts.toolCalls >= minToolCalls
  const chars = facts.toolResultChars >= minToolResultChars
  if (calls && chars) return 'composite'
  return calls ? 'tool-calls' : 'tool-result-volume'
}

/**
 * Decide one agent request's route. Pure: given the same inputs it returns the
 * same decision, so turn routing is deterministic under replay.
 *
 * Policy, in precedence order:
 * 1. An explicit selection owns the session — live mark or durable
 *    `explicit-selection` record: pass everything through, whatever the route
 *    (an explicit Flash must not be escalated, an explicit Pro must not be
 *    downgraded), and record the authority claim durably the first time it is
 *    seen so it survives restarts.
 * 2. Subagent sessions pass through unless `routeSubagents` is set.
 * 3. A proposal aimed at neither configured tier passes through (an operator's
 *    foreign model choice is authoritative).
 * 4. Later steps keep the turn's step-1 route, with ONE one-way exception:
 *    discovered complexity (many tool calls or heavy tool output) may escalate
 *    fast→heavy mid-turn, recording the measured facts and which bound
 *    triggered. A heavy route is NEVER downgraded mid-turn.
 * 5. A turn scores at its first step; the heavy tier serves it when the score
 *    meets the threshold, the fast tier otherwise. A heavy proposal counts as
 *    router-owned only when the router's own memory proves continuity (it
 *    returned exactly this config last turn), so a genuinely explicit heavy
 *    selection — any field different from what the router last returned — is
 *    retained, never re-scored.
 *
 * Every recorded decision carries a strictly increasing `authorityEpoch`, so a
 * later record always outranks an earlier one: a stale router-owned record can
 * never regain authority over a newer explicit one.
 * @param input - the request's routing inputs.
 * @returns the decision, its reason, the memory to keep, and the durable record.
 */
export function decideRoute(input: RoutingDecisionInput): RoutingDecision {
  const { proposed, turn, step, memory, config } = input
  /** Record this decision durably: route changes and authority transitions
   * always record; telemetry mode records every decision. */
  const record = (
    decision: Omit<RoutingDecision, 'record'>,
    authority: ModelRoutingDecisionEventData['authority'],
    activeAuthority: ModelSelectionAuthority,
    force = false,
  ): RoutingDecision => {
    if (!force && !config.recordAllDecisions && decision.config === proposed) {
      return { ...decision, discovered: undefined, record: undefined }
    }
    return {
      ...decision,
      record: decisionRecord(input, decision, authority, activeAuthority),
    }
  }
  const passthroughMemory = (authority: ModelSelectionAuthority): RoutingMemory => ({
    turn,
    decided: undefined,
    source: 'direct',
    explicit: false,
    authority,
  })

  if (input.explicitSelection) {
    // An explicit selection owns this session's routing entirely. The routing
    // record fires only when the claim is new to the routing stream (the
    // authoritative durable claim is the model/selection-authority event the
    // selection surface wrote); it keeps the routing corpus complete.
    const claimIsNew = memory?.decided !== undefined || memory?.explicit !== true
    return record({
      config: proposed,
      memory: { turn: 0, decided: undefined, source: 'direct', explicit: true, authority: input.activeAuthority },
      reason: 'explicit-selection-passthrough',
      reading: undefined,
      discovered: undefined,
    }, 'explicit-selection', input.activeAuthority, claimIsNew)
  }

  if (input.isSubagent && !config.routeSubagents) {
    // A passthrough that ENDS prior router ownership is an authority
    // transition and records even in lean mode.
    const endedOwnership = memory?.decided !== undefined
    return record({
      config: proposed,
      memory: passthroughMemory('subagent-owner'),
      reason: 'subagent-passthrough',
      reading: undefined,
      discovered: undefined,
    }, 'subagent-owner', 'subagent-owner', endedOwnership)
  }

  const fast = isRoute(proposed, config.fastRoute)
  const heavy = isRoute(proposed, config.heavyRoute)
  if (!fast && !heavy) {
    const endedOwnership = memory?.decided !== undefined
    return record({
      config: proposed,
      memory: passthroughMemory('default'),
      reason: 'foreign-route-passthrough',
      reading: undefined,
      discovered: undefined,
    }, 'foreign-route', 'default', endedOwnership)
  }

  // Later steps keep the route their turn opened...
  if (step > 1 && memory !== undefined && memory.turn === turn) {
    // ...with one one-way exception: discovered complexity may escalate
    // fast→heavy mid-turn. Heavy is never downgraded mid-turn.
    if (fast && config.discoveredEscalation !== false && memory.decided !== undefined
      && isRoute(memory.decided, config.fastRoute)) {
      const facts = input.facts.discovered()
      const { minToolCalls, minToolResultChars } = config.discoveredEscalation
      if (facts.toolCalls >= minToolCalls || facts.toolResultChars >= minToolResultChars) {
        const discovered: DiscoveredComplexity = {
          toolCalls: facts.toolCalls,
          toolResultChars: facts.toolResultChars,
          trigger: discoveredTrigger(facts, minToolCalls, minToolResultChars),
        }
        const routed = routedConfig(proposed, config.heavyRoute)
        return record({
          config: routed,
          memory: { turn, decided: routed, source: 'direct', explicit: false, authority: 'router' },
          reason: 'mid-turn-escalated',
          reading: undefined,
          discovered,
        }, 'router', 'router')
      }
    }
    // Retention: no route or authority change. Telemetry mode still records
    // every retained decision (with `recordAllDecisions` truthfully meaning
    // ALL decisions); lean mode records nothing.
    if (config.recordAllDecisions) {
      const retained = memory.decided === undefined ? proposed : memory.decided
      const retainedAuthority = memory.decided === undefined ? 'foreign-route' : 'router'
      const retainedActive = memory.decided === undefined ? 'default' : 'router'
      return record({
        config: retained,
        memory,
        reason: 'turn-route-retained',
        reading: undefined,
        discovered: undefined,
      }, retainedAuthority, retainedActive, true)
    }
    return {
      config: memory.decided === undefined ? proposed : memory.decided,
      memory,
      reason: 'turn-route-retained',
      reading: undefined,
      discovered: undefined,
      record: undefined,
    }
  }

  const reading = scoreComplexity(input.facts.userText(), config.extraMarkers)
  // Continuity: the router owns this heavy proposal only when it can prove the
  // route is its own — a live decision must match field-wise (any difference
  // means someone else chose the route), while restart-reconstructed ownership
  // was already proven by the durable decision event itself, so the route pair
  // alone carries it (the header seed may carry sampling fields the event
  // deliberately omits).
  const routerOwnedHeavy = heavy && memory !== undefined && memory.decided !== undefined
    && isRoute(memory.decided, config.heavyRoute)
    && (memory.source === 'reconstructed' || callConfigEquals(memory.decided, proposed))
  // Durable Auto state: the authority stream released explicit authority back
  // to the router, and the router holds no route of its own — a heavy proposal
  // here is a leftover header from the prior era, NOT a fresh deliberate
  // choice, so the router re-scores it instead of "retaining" it.
  const autoManaged = !input.explicitSelection
    && memory?.source === 'reconstructed'
    && memory.authority === 'router'
    && memory.decided === undefined

  if (reading.score >= config.escalationThreshold) {
    if (heavy) {
      if (routerOwnedHeavy || autoManaged) {
        // Router-owned (or Auto-managed) heavy at a still-high score: keep the
        // proposal verbatim and own it.
        return record({
          config: proposed,
          memory: { turn, decided: proposed, source: 'direct', explicit: false, authority: 'router' },
          reason: 'escalated-to-heavy',
          reading,
          discovered: undefined,
        }, 'router', 'router')
      }
      // A heavy proposal the router cannot prove as its own is explicit
      // authority: retained verbatim, never re-scored down. Recorded when the
      // claim is new (the router previously owned the route).
      const claimIsNew = memory?.decided !== undefined
      return record({
        config: proposed,
        memory: passthroughMemory('default'),
        reason: 'explicit-heavy-retained',
        reading,
        discovered: undefined,
      }, 'explicit-selection', 'default', claimIsNew)
    }
    const routed = routedConfig(proposed, config.heavyRoute)
    return record({
      config: routed,
      memory: { turn, decided: routed, source: 'direct', explicit: false, authority: 'router' },
      reason: 'escalated-to-heavy',
      reading,
      discovered: undefined,
    }, 'router', 'router')
  }

  if (heavy && !routerOwnedHeavy) {
    if (autoManaged) {
      // Auto authority with a simple turn: the leftover heavy header routes
      // back down to the fast tier the score demands.
      const down = routedConfig(proposed, config.fastRoute)
      return record({
        config: down,
        memory: { turn, decided: down, source: 'direct', explicit: false, authority: 'router' },
        reason: 'routed-fast',
        reading,
        discovered: undefined,
      }, 'router', 'router')
    }
    const claimIsNew = memory?.decided !== undefined
    return record({
      config: proposed,
      memory: passthroughMemory('default'),
      reason: 'explicit-heavy-retained',
      reading,
      discovered: undefined,
    }, 'explicit-selection', 'default', claimIsNew)
  }

  if (fast) {
    return record({
      config: proposed,
      memory: { turn, decided: proposed, source: 'direct', explicit: false, authority: 'router' },
      reason: 'routed-fast',
      reading,
      discovered: undefined,
    }, 'router', 'router')
  }
  const routed = routedConfig(proposed, config.fastRoute)
  return record({
    config: routed,
    memory: { turn, decided: routed, source: 'direct', explicit: false, authority: 'router' },
    reason: 'routed-fast',
    reading,
    discovered: undefined,
  }, 'router', 'router')
}

/**
 * Reconstruct routing state for one session after a process restart, from the
 * durable event history.
 *
 * Two event streams, read in one backward scan (newest first):
 *
 * 1. `model/selection-authority` (v0.15.3+) — the AUTHORITATIVE authority
 *    record, deliberately independent of every router policy version: a
 *    user/sdk/policy claim means the router defers; `router` (Auto) means the
 *    router owns routing; `subagent-owner` defers to the owning delegation.
 * 2. Legacy `model/routing-decision` events (v0.15.1/v0.15.2 sessions, and
 *    barrier records thereafter) — explicit-selection, foreign-route, and
 *    subagent-owner records are authority BARRIERS honored at ANY policy
 *    version (a router policy upgrade must never erase a human choice); only
 *    router-owned records are policy-version filtered, and the newest
 *    current-policy one carries route continuity.
 *
 * This is what makes authority durable across both restarts and router policy
 * migrations: a router escalation followed by an explicit selection stays
 * explicit no matter which router version reads the log back.
 * @param events - the session's durable event log.
 * @returns the reconstructed memory, or `undefined` when nothing routing-
 * relevant was ever recorded for this session.
 */
export function reconstructRoutingState(events: readonly SessionEvent[]): RoutingMemory | undefined {
  // First: the durable SELECTION state (authoritative at any router policy
  // version). An undecidable (future-schema / malformed) state fails closed —
  // the router defers rather than reinterpreting superseded history.
  const selection = reconstructSelectionState(events)
  if (selection !== undefined) {
    if ('undecidable' in selection) {
      return { turn: 0, decided: undefined, source: 'reconstructed', explicit: true, authority: 'user' }
    }
    if (selection.mode === 'manual') {
      // A subagent-owner state is a claim by the owning delegation, not a
      // human/SDK selection the router defers to via the explicit branch —
      // the session's own subagent status routes it.
      if (selection.authority === 'subagent-owner') {
        return { turn: 0, decided: undefined, source: 'reconstructed', explicit: false, authority: 'subagent-owner' }
      }
      return { turn: 0, decided: undefined, source: 'reconstructed', explicit: true, authority: selection.authority }
    }
    // Auto (router) or default: automatic selection owns the choice; the
    // router keeps scanning for the newest current-policy ROUTE continuity
    // below — an auto release does not carry a route of its own.
  }

  // Second: legacy routing decisions (v0.15.1–v0.15.2 barriers, and route
  // continuity), newest first.
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const event: SessionEvent | undefined = events[at]
    if (event === undefined) continue
    if (event.type !== 'model/selection-authority') {
      // A later auto/default state releases authority: older routing barriers
      // beneath it no longer decide authority (they may still carry nothing —
      // the auto state already answered).
      if (selection !== undefined && !('undecidable' in selection) && selection.mode === 'auto') {
        // Auto is in force; only ROUTE continuity from the current router
        // policy is interesting, barriers are superseded.
        if (event.type !== 'model/routing-decision') continue
        const data = event.data
        if (data.authority === 'router') {
          if (data.policyVersion === POLICY_VERSION) {
            return {
              turn: data.turn,
              decided: { provider: data.selected.provider, model: data.selected.model },
              source: 'reconstructed',
              explicit: false,
              authority: 'router',
            }
          }
          continue
        }
        continue
      }
    }
    if (event.type !== 'model/routing-decision') continue
    const data = event.data
    if (data.authority === 'router') {
      // Router-owned route continuity is policy-scoped: only the current
      // policy's newest decision carries it, and it stops the scan.
      if (data.policyVersion === POLICY_VERSION) {
        return {
          turn: data.turn,
          decided: { provider: data.selected.provider, model: data.selected.model },
          source: 'reconstructed',
          explicit: false,
          authority: 'router',
        }
      }
      // Stale policy: that router era ended; keep scanning for the newest
      // deciding record (an older barrier may still rule).
      continue
    }
    if (data.authority === 'explicit-selection') {
      // Authority barrier, policy-version INDEPENDENT.
      return { turn: 0, decided: undefined, source: 'reconstructed', explicit: true, authority: 'user' }
    }
    // foreign-route | subagent-owner barriers: the router does not own the route.
    return { turn: 0, decided: undefined, source: 'reconstructed', explicit: false, authority: data.authority === 'subagent-owner' ? 'subagent-owner' : 'default' }
  }
  // An auto/default selection state with no router route beneath it.
  if (selection !== undefined && !('undecidable' in selection)) {
    return { turn: 0, decided: undefined, source: 'reconstructed', explicit: false, authority: selection.authority === 'default' ? 'default' : 'router' }
  }
  return undefined
}

/** The narrow structural view the router needs from one agent. */
export interface RoutingAgent {
  readonly session: {
    readonly header: { readonly parentSession?: SessionId }
    readonly events: readonly SessionEvent[]
  }
}

/**
 * Register the tiered routing listener for the lifetime of `ctx`.
 *
 * The listener runs on the root context, so it registers before any agent's
 * scoped listeners and wraps their proposals: it awaits `next()` (session
 * selection, agent default) and applies the tiered policy to the result.
 * Ownership comes from three sources, strongest first: a live explicit
 * selection mark on the session (web picker, SDK initialize), the router's
 * in-process memory, and — after a restart — the durable
 * `model/routing-decision` history, whose LATEST record is authoritative (an
 * explicit-selection record durably ends router ownership; a router record
 * restores it). Every ownership claim, route change, or — in telemetry mode —
 * decision is appended durably as a `model/routing-decision` event (ignorable,
 * non-surface: route optimization continuity, not ownership — ownership lives
 * exclusively in `model/selection-authority`) with a strictly increasing
 * per-session `authorityEpoch`, and route changes are accompanied by one
 * diagnostic log line.
 * @param ctx - plugin context; the listener is disposed with it.
 * @param config - the two tiers and the routing policy scalars.
 * @throws when {@link resolveConfig} rejects the config.
 */
export function apply(ctx: Context, config: ModelRouterConfig): void {
  const resolved = resolveConfig(config)
  const memoryBySession = new WeakMap<object, RoutingMemory>()
  ctx.on('agent/request', async ({ agent, turn, step }, next) => {
    const proposed = await next()
    const session = agent.session
    let memory = memoryBySession.get(session)
    if (memory === undefined) {
      // First request this process (or ever): the durable history decides
      // routing authority — including whether an explicit selection made
      // before the restart (or under an older router policy) still outranks
      // the router.
      memory = reconstructRoutingState(session.events) ?? undefined
    }
    // Lazy facts: computed at most once per request, and only when the policy
    // actually reads them (scoring or discovered-complexity measurement).
    let userText: string | undefined
    let discovered: DiscoveredFacts | undefined
    const facts: LazyTurnFacts = {
      userText: () => userText ??= turnUserText(session.events, turn),
      discovered: () => discovered ??= turnDiscoveredFacts(session.events, turn),
    }
    // Authority in force: the live manual mark when present, else the durable
    // reconstruction's authority, else the router itself — the subagent/foreign
    // branches stamp their own labels inside decideRoute.
    let mark = explicitModelSelectionMark(session)
    if (mark === undefined && memory?.explicit === true) {
      // The mark is absent while the cached memory still says explicit: the
      // durable authority stream may have ADVANCED past the cache (Auto was
      // selected between requests). Re-derive from the events — the latest
      // authority record wins, whatever released or claimed authority.
      const rederived = reconstructRoutingState(session.events)
      if (rederived === undefined || !rederived.explicit) {
        memory = rederived ?? undefined
      } else {
        mark = { at: 0, state: { mode: 'manual', authority: rederived.authority as 'user' | 'sdk' | 'policy', selection: { provider: '', model: '' }, authorityEpoch: 0, source: 'system' } }
      }
    }
    const activeAuthority: ModelSelectionAuthority = mark?.state.authority
      ?? (memory?.explicit === true ? memory.authority : 'router')
    const decision = decideRoute({
      sessionId: String(session.id),
      proposed,
      explicitSelection: mark !== undefined || (memory?.explicit ?? false),
      activeAuthority,
      isSubagent: session.header.parentSession !== undefined,
      turn,
      step,
      facts,
      memory,
      config: resolved,
    })
    memoryBySession.set(session, decision.memory)
    if (decision.record !== undefined) {
      session.append('model/routing-decision', decision.record, { ignorable: true })
    }
    if (decision.config !== proposed) {
      ctx.logger.info(
        'llm-model-router: turn %d %s -> %s/%s (%s)',
        turn,
        `${proposed.provider}/${proposed.model}`,
        decision.config.provider,
        decision.config.model,
        decision.reason,
      )
    }
    return decision.config
  })
}
