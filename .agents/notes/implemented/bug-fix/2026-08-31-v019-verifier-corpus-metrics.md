# Agent Note: Verifier immutability, corpus rot, and metrics breakdowns

Status: implemented

English | [中文](2026-08-31-v019-verifier-corpus-metrics.zh.md)

## Problem

Forensic inspection of the 6 model-side failures from the exploratory Batch A run revealed three distinct root causes:

1. **Verifier immutability false rejects (4 of 6 failures):** `hashVerifierControlledFiles` recorded `:absent` for test files that did not exist at baseline. Multi-file-feature tasks ask the model to create new test files (e.g. `tests/Stack.test.ts`), so the post-execution hash found the new file and differed from the baseline hash, triggering "verifier-controlled files were modified by the model" before the diagnostic verifier even ran. This rejected every multi-file-feature task regardless of model output quality.

2. **Snapshot contamination (1 failure):** Node.js compile cache files in `.tmp/node-compile-cache/` were included in the workspace hash and changed-files list, contaminating the slugify task's trajectory with hundreds of irrelevant cache files.

3. **Corpus rot (3 infra failures):** The ts-http repository's base commit pinned `typescript@5.0.0`, which no longer exists in the npm registry. `npm install` failed during setup, so no model was evaluated. The `batch-a-ts-http-deps-001` task asked the model to fix this, but the setup itself failed before the model could run.

## Decision

**Verifier immutability:** Test files discovered by walking test directories are only hashed when they exist at baseline. Config files (`package.json`, `tsconfig.json`, etc.) and test setup files (`tests/setup.ts`, `conftest.py`) still record `:absent` because a model creating those is suspicious. New test files created by the model are allowed; the diagnostic verifier still runs the actual tests, so a new test file that does not test the right thing will fail verification.

**Snapshot contamination:** Added `.tmp` to `SNAPSHOT_EXCLUDED_DIRS` and bumped the exclusion set version from `v1` to `v2`. The `getChangedFiles` fallback also excludes `.tmp`.

**Corpus rot:** Updated the ts-http base commit to use `typescript: "^5.4.0"` (valid) with `vitest` in `dependencies` (a real issue the model can fix without breaking `npm install`). Bumped the corpus version from `v019-synthetic-multirepo-v2` to `v019-synthetic-multirepo-v3` and the experiment ID from `v019-synthetic-multirepo-validation-v2` to `v019-synthetic-multirepo-validation-v3`.

**Metrics breakdowns:** Added `latencyByAttemptType` (one-shot Flash, Flash repair, Pro initial, Pro rescue, failed), `costByOutcome` (verified one-shot, verified rescued, ultimately failed), and `cacheSemantics` (total and per-task cache read/miss tokens) to `MetricsReport` for cross-run comparability.

## Verification

Typecheck passes. Evaluation tests (31) and repair-runtime tests (149) pass. The 22 evaluated Batch A trajectories now reconcile: 22 Flash + 6 Pro = 28 total attempts.

## Alternatives considered

- **Block all new test files** — rejected: multi-file-feature tasks explicitly require creating new test files. The diagnostic verifier is the correct gate for test quality, not file existence.
- **Remove the ts-http-deps task** — rejected: the user specified rerunning all 25 tasks rather than silently replacing three. The task is updated to fix dependency classification instead of version conflict.

## Consequences

The corpus identity change (v2 → v3) requires requalification and a full rerun. The snapshot exclusion change (v1 → v2) requires requalification of the composed runtime. Previous v2 trajectories remain valid as exploratory evidence but are not comparable to v3 results.
