# @deepseek-ai/dsh-runtime-performance-telemetry

First-party runtime performance/context telemetry for the DeepSeek Harness.

The plugin emits two ignorable diagnostics:

- `context/composition` at real `model/request` boundaries, using the replay-aware
  token meter's current surface to report reasoning-context pressure;
- `runtime/performance-sample` after each completed turn.

## v0.14.1 timing correction

v0.14 inferred model/tool duration from durable Session event timestamps. That
was directionally useful but systematically counted synchronous Session
listeners between `model/request`/`tool/dispatch` and the actual execution seam
as model/tool time.

v0.14.1 wraps the actual `llm/stream` and `tools/execute` seams with
`performance.now()` and emits version-2 samples with
`timingSource: 'monotonic-execution-spans'`. Turn wall time uses the same
monotonic clock. Therefore persistence, projection, telemetry listeners,
request assembly and ordered finalization remain in residual orchestration time
instead of being hidden inside provider/tool latency.

Parallel tool intervals are unioned rather than summed, so fan-out does not
inflate external-tool wall time. The derived relation is:

`orchestration = turn wall - union(model spans) - union(tool spans)`

These events are diagnostics, not execution authority. They are appended from
a microtask after the observed Session event because Session append listeners
are intentionally non-reentrant.
