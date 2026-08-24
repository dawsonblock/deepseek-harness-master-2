# DeepSeek Harness Full Upgrade v0.3.0

This release keeps the upstream Harness runtime intact and adds two complementary hardening surfaces:

1. `python/agent-kernel-ref/` — dependency-light reference execution kernel from v0.2.0.
2. `packages/runtime/agent-kernel-hardening/` — native TypeScript replay diagnostics operating directly on Harness session events.

## Native TypeScript upgrade

The new workspace package derives quality and recovery facts from the canonical immutable session log instead of adding a competing runtime state store.

### Metrics

- turns started/completed/errored/interrupted;
- steps started/completed;
- tool calls/results/errors/unmatched calls;
- tool and step average/p95 latency;
- input/output/reasoning/cache read/cache write tokens;
- billed input and cache-hit ratio;
- request-header count/churn;
- compaction start/end counts.

### Recovery diagnostics

An unmatched persisted `tool/call` is classified conservatively as `outcome-unknown`. The analyzer only marks automatic retry safe when the caller declares the tool idempotent. Non-idempotent calls can be marked as requiring reconciliation if the deployment has a real external-state reconciler.

### Cache stability

Request headers receive stable structural fingerprints. Object key order does not create false churn. A stability ratio exposes how often model/provider/system/tool-prefix state actually changes across requests.

### Acceptance gates

Deterministic gates can fail qualification on concrete runtime evidence, including unmatched side effects, tool failures, turn errors, latency ceilings, and optional cache-hit targets.

### Ablation ranking

Variants can be compared using a transparent score over completion rate, cache reuse, tool error rate, unmatched-call rate, and latency. The weights are explicit and replaceable; this is not presented as a scientific benchmark by itself.

## Commands

```bash
npm run test:agent-kernel-hardening
python -m pytest -q python/agent-kernel-ref/tests
```

The TypeScript layer intentionally does not change `SessionEventMap` or `SESSION_FORMAT_VERSION`. It is a read-only diagnostic package, so existing durable sessions remain valid.
