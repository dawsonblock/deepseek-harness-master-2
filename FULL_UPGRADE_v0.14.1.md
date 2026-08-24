# DeepSeek Harness FULL Upgrade v0.14.1

## Release objective

v0.14.1 is a correctness hardening release for the Runtime Performance & Resource Governor introduced in v0.14.0. It does not add another orchestration subsystem. It closes integration defects found by source-level extraction: duplicated Session event ownership, a stale generated event catalog, performance timing that began at event timestamps rather than the physical model/tool execution seams, PTY fallback metrics that mixed protocol fallback with timeout/exit/reset diagnostics, and a model-call budget that was charged after model dispatch rather than before it.

The established event-sourced recovery, Code Mode, goal verification, Outcome Verification, acceptance-pack calibration, and v0.13 enforcement policy remain intact.

## Core corrections

### Canonical v0.14 event ownership

The five v0.14 diagnostic events are now owned by the canonical `SessionEventMap` in the core Session package:

- `context/composition`
- `runtime/performance-sample`
- `runtime/backpressure`
- `subagent/resource`
- `terminal/settlement`

The Bash and PowerShell persistent-shell packages no longer independently declare `terminal/settlement`. The shared schema permits `tool: 'bash' | 'pwsh'`, eliminating duplicate event ownership and avoiding incompatible module augmentation.

The generated known-event set and persistence catalog were regenerated from the canonical declarations. The repository persistence-catalog generator now accepts the v0.14.1 tree.

### Monotonic physical execution timing

The v0.14.0 performance plugin inferred model and tool time from Session event timestamps. Session event listeners execute after an event timestamp is created, so persistence/projection/listener work could be incorrectly attributed to model or external-tool time and make Harness orchestration appear cheaper than it was.

v0.14.1 moves timing to the actual execution seams:

- `llm/stream` is wrapped with `performance.now()` around physical provider-stream iteration.
- `tools/execute` is wrapped with `performance.now()` around physical tool-body execution.
- turn wall time is measured with the monotonic clock.
- overlapping tool intervals are unioned before subtraction from turn wall time.

`runtime/performance-sample` supports version 2 with `timingSource: 'monotonic-execution-spans'` so consumers can distinguish corrected samples from older event-derived telemetry.

The intended calculation is now much closer to:

```text
orchestration = turn wall - physical model intervals - union(physical tool intervals)
```

rather than treating event publication time as physical execution start.

### Pre-model model-call admission

The resource governor now charges and authorizes a model call at the `agent/request` seam before request preparation/provider dispatch. If the root has already exhausted `maxModelCalls`, a further model request is rejected before provider execution.

A successful admission emits `subagent/resource` with `action: 'model-admit'`; rejected admission remains fail-closed.

Reasoning-token, event-byte, and completed-turn wall-time limits are still charged from observed runtime events. Crossing one of those limits cannot retroactively cancel the operation that generated the crossing usage; it blocks subsequent governed admissions. This is documented as a remaining boundary rather than represented as an instantaneous kill switch.

### PTY reliability metric split

The old `terminalFallbackRate` mixed several operationally different terminal outcomes. v0.14.1 separates them into:

- `terminalProtocolFallbackRate` — prompt + silence fallback only
- `terminalTimeoutRate`
- `terminalExitRate`
- `terminalResetRate`

`terminalFallbackRate` remains as a compatibility alias for protocol fallback, but the runtime-performance acceptance gate now uses `terminalProtocolFallbackRate`.

This prevents an intentional or independently diagnosed shell exit/timeout/reset from falsely appearing as protocol marker desynchronization.

### Source and qualification guards

v0.14.1 adds guards proving that:

- all five diagnostic events have canonical ownership;
- all five are present in the generated known-event catalog;
- persistent Bash and PowerShell no longer own duplicate Session event declarations;
- model and tool timing use monotonic execution spans;
- model-call admission occurs before provider dispatch;
- the hardening gate uses protocol fallback rather than the old mixed PTY metric.

The older v0.14 source guard was made forward-compatible with patch versions of the 0.9.x hardening package rather than requiring exactly 0.9.0.

## Package versions

- `@deepseek-ai/dsh-agent-kernel-hardening`: **0.9.1**
- runtime performance telemetry: **0.1.1**
- runtime resource governor: **0.1.1**
- Outcome Verification Engine: **0.5.0** (unchanged)

## Qualification

The following targeted executable suites were rerun against the v0.14.1 tree:

| Suite | Result |
|---|---:|
| Agent-kernel hardening | 29/29 PASS |
| Outcome Verification Engine | 45/45 PASS |
| Python reference kernel | 12/12 PASS |
| v0.6 failure injection | 12/12 PASS |
| v0.7 policy binding + Code Mode | 10/10 PASS |
| v0.7 process-kill lifecycle | 8/8 PASS |
| v0.8 checkpoint/recovery | 15/15 PASS |
| v0.8 checkpoint process-kill | 16/16 PASS |
| v0.9 outcome integration | 11/11 PASS |
| v0.10 verifier corpus | 12/12 PASS |
| v0.11 calibration | 150/150 PASS |
| v0.12 adversarial calibration | 1600/1600 PASS |
| v0.12 executable coding fixtures | 40/40 PASS |
| v0.13 six-pack calibration | 2100/2100 PASS |
| v0.13 executable mutation fixtures | 160/160 PASS |
| v0.14 runtime performance/resource | 14/14 PASS |
| v0.14.1 correctness qualification | 24/24 PASS |

**Total targeted executable checks: 4,258/4,258 PASS.**

Additional checks:

- v0.5 through v0.14.1 source integration guards: PASS
- persistence catalog / generated known-event synchronization: PASS
- modified/new TypeScript syntax transpilation: 8/8 PASS
- Python compileall: PASS
- hardening packed consumer import: PASS
- Outcome Verification packed consumer import: PASS
- v0.13 calibrated release-verification policy remains ENFORCE

## Remaining boundaries

v0.14.1 intentionally does not claim to solve every v0.14 follow-up item:

1. **Resource accounting is still process-local.** A process restart does not automatically reconstruct model/reasoning/event/wall usage into the governor. Durable `rootRunId` accounting and replay reconstruction remain follow-up work.
2. **Reasoning/event/wall limits are next-admission circuit breakers.** They do not interrupt the current operation after that operation crosses the limit.
3. **First-party backpressure is still concentrated on one-shot subagent admission.** ACP/WebSocket/event-export/telemetry pipelines do not yet all use the bounded gate.
4. **Full detailed event-path profiling is not yet emitted.** The schema can represent deeper encode/decode/persistence/projection telemetry, but the first-party producer focuses on turn/model/tool spans.
5. **Full dependency-installed upstream pnpm monorepo CI is not claimed** in the clean archive environment because the complete installed workspace dependency graph / `@types/node` is absent.

These are explicit next-version targets rather than hidden assumptions in the v0.14.1 claims.

## Operational effect

v0.14.1 keeps the v0.14 resource/performance layer opt-in for backward compatibility, but makes its diagnostics and enforcement semantics more trustworthy. The release should be viewed as a correction of the measurement and schema boundaries discovered during the v0.14 deep extraction, not as a benchmark-result expansion.
