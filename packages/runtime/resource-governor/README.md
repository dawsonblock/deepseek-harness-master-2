# @deepseek-ai/dsh-runtime-resource-governor

Root-scoped resource budgets for the DeepSeek Harness.

The plugin registers a fail-closed `SubagentAdmissionGuard` and uses the pure
`RootResourceGovernor` from `dsh-agent-kernel-hardening`. It can cap one-shot
child concurrency, total descendant starts, subagent start rate, model calls,
reasoning tokens, event bytes, and aggregate completed-turn wall time.

## v0.14.1 model admission correction

Subagent limits remain enforced at native admission. In addition, model calls
are now charged at the `agent/request` waterfall **before** request preparation
and provider dispatch. A `maxModelCalls: 200` policy therefore blocks model
attempt 201 before it can reach the provider. The admission is intentionally
conservative: a later request-construction failure still consumes one model-call
admission rather than risking quota overshoot under concurrent subagents.

Reasoning-token, event-byte and completed-turn wall-time overruns are observed
from durable Session events and block the root's subsequent model requests and
subagent admissions. They cannot retroactively stop the model response/event
that first crossed the threshold.

The package remains process-local. A deployment needing crash-persistent or
multi-process quotas must reconstruct/seed usage from durable telemetry or use
a shared quota backend; v0.14.1 does not claim distributed quota consensus.

When `maxConcurrentOneShotChildren` and `maxQueuedSubagentStarts` are both set,
one-shot creation uses a bounded FIFO admission queue. Queue saturation or
timeout rejects before child creation; queued admissions observe the caller's
AbortSignal and release capacity on cancellation. Accepted work is never
silently dropped.
