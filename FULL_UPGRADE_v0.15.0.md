# DeepSeek Harness FULL Upgrade v0.15.0

## Release objective

v0.15.0 is the tiered-routing feature release. It completes the remaining recommendation from the external code review pass that v0.14.2 began: the harness gains a first-class, complexity-tiered model routing layer over the two DeepSeek V4 general-availability routes, the official dated GA model aliases enter the default catalog, and the reverse-proxy SSE hardening first shipped as the v0.14.2 hotfix is folded into the release train. The event-sourced recovery kernel, resource governor, and v0.13/v0.14 enforcement policy remain intact.

## Core additions

### Tiered model router (`@deepseek-ai/dsh-llm-model-router`)

A new function plugin under `packages/llm/llm-model-router` routes each agent turn between two configured provider tiers through the agent loop's existing `agent/request` waterfall — the same seam `installModelSelection` uses, so no new request path, no new session-event vocabulary, and no provider-call overhead exist. A deployment names a fast route (for example `deepseek-v4-flash`) and a heavy route (for example `deepseek-v4-pro`); each turn's opening human messages are scored by a deterministic, replayable text policy, and the turn serves on the fast tier until the reading crosses the escalation threshold.

Deterministic complexity scoring (additive, per-family capped):

| Signal family | Points per match | Family cap |
|---|---:|---:|
| Explicit deep-reasoning request ("think step by step", "ultrathink", …) | 3 | 9 |
| Formal-reasoning marker (prove, theorem, derivation, …) | 2 | 8 |
| System-design marker (architecture, refactor, distributed, …) | 2 | 8 |
| Fenced code block | 1 | 3 |
| Length band (400 characters of prompt text) | 1 | 4 |

The default escalation threshold is 4. Scoring reads only human-authored message text: plugin-injected context (time snapshots, file-watch notices) and tool results are excluded, so nothing but the user's own words moves the routing needle.

Routing policy guarantees, each covered by dedicated tests:

- **Foreign routes pass through.** A proposal aimed at neither configured tier is returned untouched, so an explicit selection of any other model is authoritative.
- **Explicit heavy selections are never downgraded.** The router re-scores a heavy proposal only when its own previous decision put the session there; a deliberate Pro selection stays on Pro.
- **Router-made escalations re-score every turn.** After an escalated turn, the next simple turn returns to the fast tier.
- **A turn's route is fixed at its first step.** Tool loops stay on the model that started them; steering messages do not flip tiers mid-turn.
- **Subagents pass through by default.** `routeSubagents: true` opts child sessions into the policy; by default their model selection belongs to the delegation that created them.
- **Effort follows the tier, sampling survives it.** Each tier may carry its own `reasoningEffort`; a tier switch drops the previous model's effort (letting the new model's adapter defaults resolve) while `temperature`, `maxTokens`, and `stop` persist.

Every route change the router returns is recorded by the agent loop as a durable `request/header` change event and accompanied by one router diagnostic log line. The `./invariant` companion is intentionally empty: the router owns no session-event vocabulary, and its per-session routing memory is a `WeakMap` keyed by the live `Session` object.

### Dated V4 GA catalog aliases

The default DeepSeek catalog now also advertises `deepseek-v4-flash-0731` and `deepseek-v4-pro-0813` — the dated GA snapshots of the two general-availability routes — alongside `deepseek-v4-flash`, `deepseek-v4-pro`, and `deepseek-v4-flash-vision-exp`. All five entries carry the 1,000,000-token context window. The aliases exist for reproducible benchmark and evaluation runs; behavior is identical to the floating ids, and catalog entries remain advisory (unlisted ids still pass through).

### Reverse-proxy SSE hardening (folded from the v0.14.2 hotfix)

The `/api/events.mux` and `/api/events.host` SSE channels now answer with `cache-control: no-cache, no-transform` and `x-accel-buffering: no`, and the dev-mode HMR event channel matches. Behind Nginx-class reverse proxies that buffer upstream responses by default, model deltas previously coalesced until a proxy buffer filled, eliminating real-time streaming to the web client; the per-response header restores immediate flushing without a proxy-wide `proxy_buffering off`. A regression test pins the headers on both channels.

## Qualification

| Suite | Result |
|---|---:|
| llm-model-router (unit + loop integration + Loader composition) | 20/20 PASS |
| llm-deepseek (adapter, SSE, translate, catalog, Files API) | 339/339 PASS |
| host/apiproxy (carrier, schemas, exports) | 377/377 PASS |
| client/connection + client/hmr (bridge, trust fence, SSE headers) | 116/116 PASS |
| core/agent + agent-default-model + agent-loop (request seam regressions) | 434/434 PASS |
| llm-retry (neighbor waterfall policy) | 66/66 PASS |
| compaction family (tool-pairing balance regressions) | 194/194 PASS |
| **Total targeted executable checks** | **1546/1546 PASS** |

Additional checks:

- `check-workspace-constraints`: the new package manifest is clean (release-member shape, exports, files, peer/dev cordis ranges, root version match).
- `verify-translation-pairing` on the new README pair: consistent.
- Full-file manifest regenerated; every one of the 8,095 entries verifies against disk.

## Remaining boundaries

1. **Complexity scoring is text-only and English-vocabulary.** Attachment payloads, image content, and tool-output volume do not move the score; non-English prompts escalate only through length and code-block signals. A configurable vocabulary is deferred until routing telemetry justifies it.
2. **Routing memory is process-local.** After a restart the router treats the persisted heavy header as an explicit selection, so a pre-restart escalation holds the heavy tier until a router-made downgrade or an explicit change re-scores.
3. **Router weights are package constants.** Deployments tune only the threshold.
4. **Full dependency-installed upstream pnpm monorepo CI is not claimed** in the clean archive environment; targeted qualification is reported instead of a full semantic workspace build.

## Operational effect

Deployments serving mixed workloads get the review's tiered topology — a fast default tier for tool-shaped and conversational work, a heavy tier for proof-carrying and architecture-shaped turns — as one opt-in plugin line in `cordis.yml`, with durable routing records in the session log and zero new provider-side moving parts.
