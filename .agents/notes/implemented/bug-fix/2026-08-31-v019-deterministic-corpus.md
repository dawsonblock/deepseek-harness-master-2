# Agent Note: Deterministic corpus generation and frozen dependencies

Status: implemented

English | [中文](2026-08-31-v019-deterministic-corpus.zh.md)

## Problem

The synthetic corpus generator produced different Git commit hashes on each run because commit metadata (author, committer, timestamps) depended on machine Git configuration and wall-clock time. Dependency versions used floating ranges (`^5.4.0`, `^2.0.0`) with no lockfile, so the same commit could install different dependency graphs over time.

## Decision

**Git identity:** Fixed `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` to `DSH Benchmark` / `benchmark@local.invalid`. Set repo-local `git config user.name` and `user.email` so the generator has zero dependency on machine Git configuration.

**Git timestamps:** Each repo gets a deterministic epoch based on its ordinal (0–6) starting from `GIT_BASE_EPOCH=1735689600` (2025-01-01T00:00:00Z). Base commits use `base_ts = epoch + ordinal * 3600`. Fix commits use `fix_ts = base_ts + 60`.

**Dependency pinning:** All synthetic repos now use exact versions (`typescript: "5.4.5"`, `vitest: "2.1.9"`) instead of floating ranges. `npm install` runs during `init_repo` to generate `package-lock.json`, which is committed into the base commit. `make_fix_commit` regenerates the lockfile if `package.json` changed.

**Install command:** `detectInstallCommand` now returns `npm ci` when `package-lock.json` exists, instead of falling through to `npm install`.

**Lock hashing:** The generator produces a machine-readable JSON receipt with `baseCommit`, `referenceFixCommit`, and `lockHash` (SHA-256 of `package-lock.json`) for each repo. The `TaskManifest.repository` interface now includes `dependencyLockHash`, which is part of `taskManifestHash` and therefore `corpusManifestHash` and `experimentManifestHash`.

**Corpus version:** Bumped from v3 to v4 (`v019-synthetic-multirepo-v4`, `v019-synthetic-multirepo-validation-v4`).

**Determinism test:** `scripts/v019-corpus-determinism.spec.ts` runs the generator twice into isolated directories and asserts all commit hashes and lock hashes match byte-for-byte.

## Verification

Typecheck passes. Evaluation tests (31) and repair-runtime tests (149) pass. Corpus determinism test passes — two independent runs produce identical commit hashes and lock hashes for all 7 repos.

## Alternatives considered

- **Content-addressable commits only** — rejected: Git commit hashes include author/committer/timestamp metadata, so freezing that metadata is necessary for reproducibility.
- **Lockfile-only without pinning** — rejected: `npm install` with a lockfile but floating `package.json` ranges can still drift if the lockfile is regenerated. Pinning exact versions in `package.json` plus a committed lockfile is the standard frozen-deps approach.

## Consequences

The v4 corpus is not compatible with v3 trajectories. Previous v3 exploratory results remain valid as exploratory evidence but cannot be compared to v4 results. The `dependencyLockHash` field changes `taskManifestHash`, so all experiment identities derived from v4 tasks differ from v3.
