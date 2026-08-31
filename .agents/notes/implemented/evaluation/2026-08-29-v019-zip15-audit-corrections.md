Status: implemented

# v019 ZIP15 audit corrections

## Decision

Apply the ZIP15 audit corrections before any paid Batch A run. The audit identified a broken corpus generator, stale commit identities, volatile manifest identity, missing per-request accounting, incorrect provider-failure metrics, and several qualification gaps.

## Changes

### Corpus regeneration (25/25 FROZEN)

Fixed `scripts/v019-batch-a-repos.sh` heredoc syntax regression. Added prototype-pollution test to `tests/HashMap.test.ts` and a repeated-variable test to `tests/template.test.ts` so the refactor tasks fail at base and pass at fix. Regenerated all seven repositories and updated every base/reference commit in `scripts/v019-batch-a-corpus.ts`. Full 25/25 qualification passes.

### Stable manifest identity

Removed `qualificationArtifactHash` from `computeExperimentManifestHash` inputs in `scripts/v019-experiment-identity.ts`. Added `corpusManifestHash` to the experiment manifest type and hashing inputs. The artifact hash is preserved in the manifest for audit but no longer affects experiment identity or checkpoint resume.

### One-to-one request accounting

Added `model/request-outcome` to `SessionEventMap` in `packages/core/session/src/types.ts`. The agent loop emits exactly one outcome per `model/request` at every exit path: success, error, aborted, max-tokens. Reconciliation in `scripts/v019-trajectory-collector.ts` now joins by `(turn, step, attempt)` instead of `routingDecisionId`, and accepts either `model/usage` or `model/request-outcome` with a failure as valid evidence. `computeAttemptAccounting` in `packages/core/repair-runtime/src/index.ts` also accepts a failure outcome.

### Provider failure rate and taxonomy

`providerFailureRate` in `scripts/v019-metrics.ts` is now per-request: `model/request-outcome` events with `outcome === 'error' | 'aborted'` divided by total outcomes, not task-level abort flags. Added `F19-control-plane-error` to the failure taxonomy. `F14-provider-failure` is reserved for genuine provider/transport failures (`model-unavailable`). `authority-undecidable`, `repair-handler-error`, and unclassified control-plane failures map to `F19`.

### Clean source enforcement

`buildExperimentManifest` throws when `benchmarkEligible && sourceTreeDirty` in `scripts/v019-experiment-identity.ts`. B0 runs (`benchmarkEligible: false`) may proceed with a dirty tree. Tests use `skipCleanSourceCheck: true` to avoid depending on the working-tree state.

### Task-private session persistence

`runTaskTrajectory` in `scripts/v019-trajectory-collector.ts` generates `sessionsDir` from `manifest.taskId` + `randomUUID()` instead of `Date.now()`. `generateRepoConfig` now requires a `sessionRoot` parameter and verifies the base config replacement succeeded.

### Selected sandbox backend

`scripts/v019-composed-runtime-qualification.ts` captures `selectedBackend()` from `LocalSandboxProvider` after the C3 Bash isolation probe, not from `which` guesses. The qualification record uses the actual probed runner and enforcement.

### Checkpoint startedAt

`scripts/run-v019-evaluation.ts` and `scripts/run-v019-batch-a-evaluation.ts` use a fresh run-start timestamp when a checkpoint is rejected due to manifest mismatch, instead of inheriting the invalid checkpoint's `startedAt`.

### Corpus qualification output capture

`scripts/v019-corpus-qualification.ts` preserves truncated stdout/stderr in the qualification details for both base-failure and fix-pass verification steps.

## Verification

- Typecheck passes (`tsc -b tsconfig.host.json`).
- Shell syntax passes (`bash -n scripts/v019-batch-a-repos.sh`).
- 53 test files, 877 tests pass across agent-loop, repair-runtime, session, and v019 scripts.
- 25/25 corpus tasks FROZEN via `v019-qualify-batch-a.ts`.
- Persistence catalog regenerated.
- Source manifest regenerated (8230 entries).
