# DeepSeek Harness Full Corrective Upgrade v0.4.0

This release corrects the objective defects found in the v0.3.0 agent-kernel hardening layer and moves the highest-value observability/recovery semantics into the canonical TypeScript Harness runtime.

## Corrected release blockers

- Fixed `@deepseek-ai/dsh-agent-kernel-hardening` public packaging. The package now builds `lib/index.js`, publishes that declared entrypoint, and has a packed clean-consumer import test.
- Removed misleading shadow telemetry assumptions. Hardening consumes canonical session events directly or adapts the existing `session-telemetry` ledger stream; it does not create a second capture pipeline.
- Corrected tool failure accounting to use canonical `ToolResultMessage` `isError`, not optional internal error metadata.
- Corrected cache/prefix stability to use actual `model/request` attempts instead of sparse `request/header` event count.
- Split successful completion from `max-tokens`, blocked, aborted, error, and interrupted endings.
- Split successful compactions from failed compactions.
- Split physical tool execution latency, ordered commit latency, and head-of-line delay.

## Native lifecycle integration

The TypeScript runtime now emits ignorable, log-only lifecycle evidence:

- `model/request` immediately before an actual model request attempt;
- `tool/call.lifecycleVersion = 1` for calls using dispatch tracking;
- `tool/dispatch` immediately before the scheduler enters its around-dispatch/body stage;
- `tool/settled` when the physical dispatch stage resolves or rejects, independently of model-order result commit.

These records do not enter `deriveMessages()` and do not change model-visible history. They are marked ignorable so older readers may safely skip the new informational vocabulary.

## Crash recovery correction

Tail repair is backward compatible:

- new tracked call + no `tool/dispatch` + no result -> `TOOL_NOT_STARTED`;
- new tracked call + `tool/dispatch` + no result -> `TOOL_OUTCOME_UNKNOWN`;
- legacy unmatched `tool/call` without dispatch-tracking evidence -> conservatively `TOOL_OUTCOME_UNKNOWN`.

This avoids both dangerous blind retries and the opposite error of treating old logs as proof that execution never started.

## Recovery policy hardening

The hardening library now supports an actual async reconciliation hook for ambiguous side effects. A non-idempotent `outcome-unknown` call remains blocked unless external state can prove `completed`, `not-executed`, or still `unknown`.

## Experiment/qualification correction

- Dashboard ablation scoring is explicitly labeled heuristic.
- Added task-level paired variant summaries so architecture decisions can preserve paired wins/losses, success delta, cost per success, model/tool calls, tokens, and latency rather than hiding all behavior in one arbitrary score.
- Added the hardening semantic and packed-consumer tests to root `check:all`, `check:ci`, and `release:verify` chains.

## Architecture boundary

The canonical TypeScript Harness runtime remains production authority. `python/agent-kernel-ref` is retained only as an executable reference specification/test oracle. The existing native Code Mode remains authoritative and is not replaced by the Python prototype.

## Deliberately deferred behavioral changes

This corrective release does **not** claim the following are complete:

1. independent native goal-completion verifier enforcement;
2. operation-content-bound idempotency enforcement in every native tool;
3. hardened adversarial Code Mode isolation beyond the existing native runtime choices;
4. complete chaos/failure-injection qualification across every workspace package.

Those are behavioral upgrades and should be landed with dedicated end-to-end tests rather than hidden inside a corrective metrics release.

## Targeted validation performed for this archive

- Agent-kernel hardening semantic suite: 14/14 passed.
- Packed clean-consumer public import: passed.
- Python reference regression suite: 12/12 passed.
- Python reference `compileall`: passed.
- Generated persistence catalog/known-event vocabulary freshness check: passed.
- Native modified TypeScript source/test files: syntax-transpilation validation passed for 8 files.
- Full workspace dependency-backed CI was not executed in this build environment because the extracted repository does not contain the complete installed pnpm workspace dependency graph. The release therefore does not claim an upstream full-CI pass.
