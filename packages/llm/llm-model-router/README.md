# `@deepseek-ai/dsh-llm-model-router`

English | [中文](README.zh.md)

Function plugin that routes each agent turn between two configured provider tiers through the agent loop's `agent/request` waterfall. A deployment names a fast route (e.g. `deepseek-v4-flash`) and a heavy route (e.g. `deepseek-v4-pro`); each turn's opening request messages are scored by a deterministic text policy, and the turn is served by the fast tier until the reading crosses the escalation threshold. The router does not wrap `ctx.llm.stream()` and performs no provider calls of its own: scoring is pure text analysis, so a replayed session routes identically.

## Calibration contract (v2)

**No single signal family can escalate a turn alone.** Every family's point cap is strictly below the default threshold of 4, and the contract is machine-verified (`noFamilyAloneReaches`) by tests and the release guard:

| Signal family | Points per match | Family cap |
|---|---:|---:|
| Explicit deep-reasoning request ("think step by step", "ultrathink", 一步步, …) | 3 | 3 |
| Formal-reasoning marker (prove, theorem, 证明, …) | 1 | 3 |
| System-design marker (architecture, refactor, 架构, …) | 1 | 3 |
| Fenced code block | 1 | 2 |
| Length band (800 characters) | 1 | 2 |

Escalation therefore requires one explicit deep-reasoning ask **plus** a corroborating signal, or several independent families agreeing. Concretely: "Fix the race condition in the scheduler." scores 0 (stays fast); "Prove the theorem." scores 2; "Think step by step" alone scores 3; a 1,600-character wall of padding scores 2; "Prove the theorem. Think step by step." scores 5 (escalates). English markers match as word-boundary regexes; Simplified Chinese markers and any deployment-configured `extraMarkers` match as plain substrings (CJK has no word boundaries), so the vocabulary grows without shipping regexes.

Scoring reads only the turn's request-authored text: direct human prompts (`source.kind === 'user'`) and parent-coordinator delegations (`source.kind === 'coordinator'`) count — they are the two sources that ask for work — while plugin-injected context (time snapshots, file notices), child reports, and tool results never move the initial score.

## Authority (v4): one durable ModelSelectionState

Selection state is ONE durable object, not a federation of a WeakMap, a picked model, and a request header. `model/selection-authority` records a complete `ModelSelectionState`: mode `manual` (authority `user`/`sdk`/`policy`/`subagent-owner` PLUS the complete selection — provider, model, reasoning effort) or mode `auto` (authority `router`/`default`, no selection). The web picker and the JSON-RPC SDK's `initialize` parameters claim manual states through `claimModelSelection`/`markExplicitModelSelection` in `@deepseek-ai/dsh-agent`, written unconditionally (never gated by router configuration or telemetry verbosity — authority is runtime state, not observability). **A manually selected session is not router-managed at all**: a manual Flash is never escalated, a manual Pro is never downgraded, and the selection itself — not just the authority — is crash-durable (a restart restores the claimed model even when the request header still names the older one).

The authority event is deliberately **independent of every router policy version** — it carries its own `authoritySchemaVersion`, never a router policy version — so a future router upgrade can never erase a recorded human or SDK choice. Each claim stamps a session-level `authorityEpoch` that never resets: `nextAuthorityEpoch` continues above every epoch ever persisted (including the legacy v0.15.2 carrier on routing decisions), so no restart, policy migration, or schema change ever reuses an epoch.

**Auto is a first-class state, through the production API.** `session.selectModel` accepts the discriminated `{ mode: 'auto' }` payload: it releases manual authority (deriving the current state from the DURABLE log, so Auto works after a real process restart — never from the WeakMap) and resets the effective selection to the deployment default through a non-claiming reset, so a stale picked route — including a foreign manual model — cannot keep impersonating a manual choice. The release survives restarts too.

Every SEMANTIC change records — a same-authority Pro→Flash switch is a transition, not a no-op (only a complete state match is suppressed), so a crash never restores yesterday's model under today's authority. After a process restart, `reconstructRoutingState` reads the LATEST deciding record: a manual state (or legacy explicit barrier, honored at ANY policy version) means the router defers; an auto state or the newest current-policy router-owned decision restores router management with route continuity. Reconstruction is exhaustive — the `default` state is a real state, not a zombie — and conservative: an authority event from a FUTURE schema version fails CLOSED (the router defers) instead of resurrecting superseded history after a downgrade. Without manual authority, a heavy proposal counts as router-owned only when the router can *prove continuity* (a field-wise `callConfigEquals` match, or its own durable decision history) — model equality alone is never proof.

## Discovered complexity: one-way mid-turn escalation

Difficulty is often discovered, not stated. From step 2 onward, a fast-tier turn escalates to heavy **once** when the work itself turns out heavy: 8+ tool calls in the turn, or 24,000+ cumulative tool-result characters (both configurable; `discoveredEscalation: false` disables). Escalation is one-way — a heavy route is never downgraded mid-turn — so reasoning continuity, provider cache behavior, and tool-loop consistency are preserved while the turn still adapts to evidence its opening words could not show. The durable record of a mid-turn escalation carries the measured facts (`toolCalls`, `toolResultChars`) and which bound triggered (`tool-calls`, `tool-result-volume`, or `composite`), so the adaptive threshold is empirically tunable from real sessions.

## Durable routing decisions

Two durable event streams, cleanly separated: **`model/selection-authority`** (WHO owns the selection and WHAT it is — the complete `ModelSelectionState`, written unconditionally by every deliberate selection surface) and **`model/routing-decision`** (WHAT the router decided — turn, step, a `routingDecisionId` for outcome/cost joins, proposed and selected routes, the decision authority, the session `activeAuthority` in force, reason, score with per-signal counts, the discovered facts behind a mid-turn escalation, threshold, router policy version, and — v0.15.4 — the `scorerVersion` and a canonical `configFingerprint`, so an experiment can always answer WHICH scoring implementation and WHICH exact configuration produced a decision). The decision identity is DETERMINISTIC — derived from (session, turn, step, policy, configuration) — so replaying the same request reproduces the same id and the policy path stays pure. An invariant companion polices the streams at runtime: epochs never regress, manual states always carry a complete selection and auto states never do, a router decision never supersedes manual authority without an intervening Auto release, and every decision carries its stamps. `recordAllDecisions: true` records **every** routing decision — including subagent passthroughs, foreign-route passthroughs, and quiet retained steps — so a telemetry corpus is complete; authority events are always durable, whatever the telemetry mode. Passthroughs that END prior router ownership (foreign model, subagent owner taking over) record the transition even in lean mode.

The **calibration contract is enforced at config load**: `escalationThreshold` values that would let a single signal family escalate alone (1–3 against the default family caps) are rejected, and the configured `extraMarkers` vocabulary is checked for fake independence — a marker duplicated across families, duplicated within a family after normalization (trim + lowercase + NFC), or colliding with a built-in family's vocabulary (either side of the family line) fails the load with the implicated marker and families named.

Other policy guarantees, each covered by tests: foreign routes pass through untouched (an operator's unlisted model is authoritative); subagent sessions pass through by default (`routeSubagents: true` opts them in, and coordinator-authored child requests then score); a turn's route is fixed at its first step; each tier may carry its own `reasoningEffort` (a tier switch drops the previous model's effort so the new model's adapter defaults apply) while sampling scalars (`temperature`, `maxTokens`, `stop`) survive; and turn facts are read lazily — request text is never scanned on passthrough or retention paths.

```yaml
- name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY

- name: '@deepseek-ai/dsh-llm-model-router'
  config:
    fastRoute:
      provider: deepseek-official
      model: deepseek-v4-flash
    heavyRoute:
      provider: deepseek-official
      model: deepseek-v4-pro
      reasoningEffort: max
    escalationThreshold: 4
    extraMarkers:
      math: [bewijs, stelling]   # deployment vocabulary, matched as substrings
    discoveredEscalation:
      minToolCalls: 8
      minToolResultChars: 24000
```

Both tiers must be distinct provider/model pairs and resolve through `ctx.llm` exactly like any other selection: the agent loop validates the returned config with `prepareCall()` before dispatch. The separately published `./invariant` companion is intentionally empty — the router's durable vocabulary is `model/routing-decision`, owned here and recorded by the loop's `request/header` machinery alongside it.

## Offline routing analysis

`analyzeTaskStructure()` produces the separate `workload-v2` schema from prompt text and runtime counts known before routing. It measures constraints, requested output structure, transformation distance, source/output cardinality, task-category one-hot scores, and context facts without invoking a model. `deriveBayesianHistoricalFeatures()` smooths completed earlier outcomes against caller-supplied priors; the current task never enters its own history.

The exported training and prediction helpers remain offline and non-authoritative. They cannot override explicit selection, durable authority, context admission, provider availability, or the fixed heuristic router. No shadow session event exists until a runtime producer owns prediction timing and persistence.

## Model Experience

### Model-request routing

#### What the model sees

Only the request header's `provider`, `model`, and `reasoningEffort` change between tiers. The conversation surface is identical on both routes, and no routing metadata enters model-visible content.

#### Token effect

Fast-tier turns bill fast-tier prices; escalated turns bill heavy-tier prices. Routing itself consumes no tokens. The calibration contract exists for exactly this reason: a keyword pile or padded length cannot silently amplify cost ~3× by forcing the heavy tier.

#### KV Cache effect

Switching tiers between turns changes the serving model, so provider prefix caching cannot carry hits across a tier boundary; consecutive turns on one tier keep their prefix. A mid-turn escalation pays one prefix rebuild for the remainder of the turn — a documented, one-time cost of adapting to discovered complexity.

## Known Limitations and Deferred Work

- **English + Simplified Chinese vocabulary** — other languages escalate through explicit-reasoning, code-block, and length signals plus deployment `extraMarkers`, not built-in vocabulary.
- **Discovered-escalation triggers are volume heuristics** — tool-call count and result characters are proxies for difficulty, not semantics; calibration against verified outcomes is the deferred follow-up this event vocabulary enables.
- **Fixed authoritative policy** — points, caps, and threshold are package constants except `escalationThreshold`; the exported learned-model helpers support offline and shadow evaluation but do not control the plugin's route.
- **Opt-in composition** — the router is not part of the default bundle; deployments add the plugin line explicitly.
- **Runtime-state and outcome signals not yet consumed** — verification failures, repair rounds, and reasoning-context pressure are the audit's proposed stronger escalation signals, deferred to the empirical-optimization release.
