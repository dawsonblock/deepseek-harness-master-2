# Agent Execution Kernel Reference Layer v0.3.0

> **Production authority:** the canonical TypeScript Harness runtime is authoritative. This Python package is a reference specification, executable test oracle, and prototype surface only. Do not deploy it as a second production agent runtime.


This additive experimental package distills several execution semantics that make DeepSeek Harness effective into a compact Python reference runtime. It does **not** replace the existing TypeScript Harness runtime and is intentionally isolated from the main workspace.

Implemented mechanisms:

- immutable SQLite/WAL event ledger
- replay-derived model-visible conversation surface
- replayable compaction via `surface/replace`
- canonical system/tool request headers for prefix-cache stability
- tool scheduler with explicit parallel-safe groups and exclusive barriers
- model-order tool-result commit
- durable `PLANNED -> DISPATCHED -> COMPLETED|FAILED` tool lifecycle
- crash recovery that distinguishes `NOT_STARTED` from `OUTCOME_UNKNOWN`
- idempotent completed-result reuse
- tool-output pruning and pressure-triggered structured compaction
- compaction boundary protection against orphan tool results
- compaction before/after token-pressure telemetry
- filesystem observation/version guards (`FS_NOT_OBSERVED`, `FS_STALE_VERSION` semantics)
- bounded retry with exponential backoff and jitter
- durable goal state rehydration and goal resume after restart
- goal rounds with a separate verifier interface
- replay-derived session telemetry and cache metrics
- isolated child-session subagents
- bounded Code Mode worker that invokes ordinary registered tools through the scheduler

## Test

From a clean extracted archive:

```bash
cd python/agent-kernel-ref
python -m pytest -q
```

Expected qualification result for v0.3.0:

```text
12 passed
```

Optional bytecode validation:

```bash
python -m compileall -q src
```

## Important security note

`CodeModeRunner` is a reference implementation. Its separate Python process, isolated interpreter mode, restricted builtins, temporary working directory, and POSIX resource limits are **not** a hardened adversarial sandbox. Use Firecracker, gVisor, WASM, E2B, or another hardened sandbox for hostile/untrusted code.

## Integration boundary

The existing Harness TypeScript runtime remains authoritative. To integrate these ideas into production Harness, port/adapt the mechanisms rather than routing the TypeScript runtime through this Python package. See `../../UPGRADE_AGENT_EXECUTION_KERNEL.md`.


## v0.3.0 repository integration

The full repository now also ships `@deepseek-ai/dsh-agent-kernel-hardening`, a native TypeScript read-only analyzer for canonical Harness session logs. The Python package remains the dependency-light executable reference kernel.

## v0.4.0 correction

The production TypeScript runtime now records native request and tool lifecycle evidence used by the hardening/telemetry layer. The Python package remains intentionally separate as a compact specification and failure-mode test oracle; production integration should target the TypeScript runtime, not route Harness execution through Python.
