# DeepSeek Harness FULL Upgrade v0.14.0

## Release objective

v0.14.0 is a Runtime Performance & Resource Governor release. v0.13 made autonomous completion strongly evidence-driven and independently calibrated per acceptance pack; v0.14 addresses the next operational risk: a correct runtime can still become impractical if reasoning history saturates context, recursive delegation amplifies resource use, persistent PTYs settle unreliably, or event/IPC fan-out consumes too much wall time.

The release therefore adds first-party measurement and fail-closed control of those costs without replacing the existing event-sourced execution, crash-recovery, outcome-verification, or calibrated promotion layers.

## Core additions

### Root-scoped subagent resource governor

`RootResourceGovernor` enforces process-local ceilings for a root execution tree:

- maximum concurrent one-shot children;
- maximum descendants started;
- maximum subagent starts per minute;
- maximum model calls;
- maximum reasoning tokens;
- maximum durable event bytes;
- maximum aggregate turn wall time.

Subagent admission is transactional. A start acquires admission before provider creation, commits after publication, rolls back on failed creation, and releases concurrency capacity when the one-shot child settles. A limit breach raises `ResourceBudgetExceededError` with the exact dimension, limit, and observed value.

The first-party `@deepseek-ai/dsh-runtime-resource-governor` plugin connects this state machine to the native subagent and Session services. It emits ignorable `subagent/resource` diagnostics and fails closed for later child admissions once model/reasoning/event/wall budgets cross their configured ceiling.

These counters are explicitly **process-local**. The package does not claim a distributed quota across several Harness processes; deployments requiring global quotas must reconstruct usage or use a shared quota service.

### Bounded FIFO backpressure

`BoundedBackpressureGate` provides a real admission primitive for overloaded one-shot subagent starts:

- bounded active capacity;
- bounded FIFO wait queue;
- optional queue timeout;
- AbortSignal-aware cancellation;
- no silent dropping of already-admitted work;
- explicit queue-full / queue-timeout rejection.

When enabled through the resource-governor plugin, queue waits and drops emit `runtime/backpressure` events. A cancelled queued admission is removed without leaking active capacity.

### Native reasoning-context measurement

The replay-aware token meter now tracks reasoning separately from ordinary model-visible content:

- `reasoningSurfaceTokens`;
- `estimatedRequestTokens`;
- `reasoningContextRatio`.

Reasoning accounting follows the same replay and replacement semantics as the real model surface, so compaction/replacement that removes reasoning also removes its token contribution. The metric is therefore based on the request surface the model would actually replay rather than a synthetic counter.

### Runtime performance telemetry

New package `@deepseek-ai/dsh-runtime-performance-telemetry` emits ignorable diagnostics from native lifecycle events:

- `context/composition` at each real `model/request`;
- `runtime/performance-sample` at completed turn boundaries.

Turn accounting separates:

- total turn wall time;
- model-stream wait time;
- external tool execution time;
- residual orchestration time;
- orchestration-overhead ratio.

Parallel tool intervals are unioned rather than summed, preventing concurrent calls from artificially inflating external-tool time. Telemetry is appended from a microtask because Session event listeners are intentionally non-reentrant, and telemetry failure is fail-open so diagnostics cannot break execution correctness.

### Persistent PTY settlement telemetry

Both persistent Bash and PowerShell tools now emit the common `terminal/settlement` vocabulary:

- marker success;
- prompt fallback;
- silence fallback vocabulary for compatible backends/future integrations;
- timeout;
- shell exit;
- reset.

This makes PTY reliability measurable across platforms instead of relying on anecdotal reports about prompt-marker or interactive-shell fragility.

### Performance/resource projection

`@deepseek-ai/dsh-agent-kernel-hardening` moves to 0.9.0 and projects the new event vocabulary into metrics including:

- average / p95 / maximum reasoning-context ratio;
- measured model/tool/orchestration wall time;
- orchestration-overhead ratio;
- event encode/decode/persist/projection/telemetry fields when supplied;
- PTY settlement and fallback counts;
- backpressure wait/rejection/drop counts;
- subagent budget admission/rejection/release counts.

### Required runtime-performance gates

v0.14 adds a dedicated `RUNTIME_PERFORMANCE_GATES` set for benchmark runs that claim performance qualification:

- orchestration-overhead ratio <= 15%;
- p95 reasoning-context ratio <= 50%;
- terminal fallback rate <= 5%;
- backpressure drops == 0.

These are qualification defaults, not a claim that every workload must use exactly these production thresholds. Existing compatibility quality gates remain non-breaking; the performance gate set is applied when performance qualification is explicitly required.

### Distribution integration

The two v0.14 runtime packages are:

- referenced by `tsconfig.host.json`;
- represented in the frozen pnpm lockfile;
- shipped as dependencies of `@deepseek-ai/dsh-base`;
- intentionally **not enabled by default** in the base Cordis patch.

`config/runtime/v0.14.example.patch.yml` provides an opt-in starting configuration with conservative root budgets and bounded one-shot subagent queuing. This avoids silently changing existing users' runtime limits or imposing telemetry overhead while ensuring official/base distributions include the new packages.

## Qualification

Targeted executable validation on the final v0.14 source tree:

- agent-kernel hardening: 28/28 PASS;
- outcome-verification engine: 45/45 PASS;
- Python reference kernel: 12/12 PASS;
- v0.6 failure injection: 12/12 PASS;
- v0.7 policy binding + Code Mode: 10/10 PASS;
- v0.7 process-kill lifecycle: 8/8 PASS;
- v0.8 checkpoint/recovery: 15/15 PASS;
- v0.8 checkpoint SIGKILL: 16/16 PASS;
- v0.9 outcome integration: 11/11 PASS;
- v0.10 verifier corpus: 12/12 PASS;
- v0.11 calibration: 150/150 PASS;
- v0.12 adversarial calibration: 1,600/1,600 PASS;
- v0.12 executable coding fixtures: 40/40 PASS;
- v0.13 six-pack calibration: 2,100/2,100 PASS;
- v0.13 executable mutation fixtures: 160/160 PASS;
- v0.14 runtime performance/resource qualification: 14/14 PASS.

Total targeted executable checks: **4,233/4,233 PASS**.

Additional release checks:

- v0.5 through v0.14 source integration guards: PASS;
- hardening packed clean-consumer import: PASS;
- outcome-verification packed clean-consumer import: PASS;
- modified/new TypeScript syntax transpilation: 17/17 PASS;
- Python compileall: PASS;
- pnpm lockfile YAML parse and new importer checks: PASS.

The v0.14 standalone qualification includes both a healthy workload that passes the required performance gates and a deliberately overloaded workload that fails all four, plus root-budget and bounded-backpressure behavior.

## Qualification boundary

A full dependency-installed upstream pnpm monorepo CI pass is **not** claimed from this clean extracted archive. Targeted `tsc --noEmit` probes for dependency-backed native packages stop before meaningful workspace semantic checking with `TS2688: Cannot find type definition file for 'node'` because the archive environment does not contain the installed workspace dependency graph / `@types/node`.

The hardening and outcome-verification packages have their own executable builds and packed-consumer checks and pass them. The release deliberately distinguishes those targeted guarantees from an unexecuted full upstream workspace CI claim.

## What v0.14 changes operationally

v0.13 answers: *can the system prove the outcome and is the verifier calibrated?*

v0.14 adds: *can the same execution stay within measurable resource and latency bounds while doing so?*

The architecture now has explicit control surfaces for correctness, recovery, verification, verifier calibration, and runtime resource amplification rather than treating performance failures as an after-the-fact tuning problem.
