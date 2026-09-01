# Agent Note: Frozen VerifierSnapshot and holdout content binding

Status: implemented

English | [中文](2026-08-31-v019-verifier-snapshot-holdout.zh.md)

## Problem

The verifier-controlled file hash used dynamic discovery at both baseline and verification time. When a model created a new test file (as multi-file-feature tasks require), the second discovery included it, causing a hash mismatch and false rejection. Additionally, hidden holdout files were not content-bound into task identity — only the holdout command was known, not the holdout bytes.

## Decision

**VerifierSnapshot:** Replaced `hashVerifierControlledFiles` with `freezeVerifierSnapshot` and `verifyAgainstSnapshot`. The path set is discovered once at baseline, deduplicated, sorted, and frozen. Verification hashes exactly those paths — no dynamic rediscovery. A model creating a new test file that was not in the baseline path set does not cause a mismatch. A model modifying or deleting an existing controlled file does.

**mustRemainAbsent:** The `VerifierSnapshot` interface includes `mustRemainAbsent: readonly string[]` for paths that must never appear at verification time (e.g. hidden holdout paths inside the model workspace).

**Holdout content binding:** Added `VerifierArtifact` interface with `logicalName` and `sha256`. The `TaskManifest.verification` block now includes `holdoutArtifacts: readonly VerifierArtifact[]`. Each holdout file's SHA-256 is computed at corpus freeze time and included in `taskManifestHash`, therefore in `corpusManifestHash` and `experimentManifestHash`. The `verifyHoldoutIntegrity` function checks current holdout file bytes against the manifest hashes at evaluation startup.

**Hash ordering:** The controlled path set is deduplicated and sorted before hashing in both `freezeVerifierSnapshot` and `verifyAgainstSnapshot`, ensuring the same path order produces the same hash.

## Verification

Six regression tests in `scripts/v019-verifier-snapshot.spec.ts`:
- PASS: model creates new test file without modifying existing tests.
- DENY: model modifies an existing test file.
- DENY: model modifies package.json.
- DENY: model deletes an existing test file.
- PASS: snapshot is deterministic for identical workspaces.
- PASS: model creates files in src/ without touching verifier-controlled files.

All 186 evaluation and repair-runtime tests pass.

## Alternatives considered

- **Hash only existing files, skip absent ones entirely** — rejected: config files like `package-lock.json` must be detected if the model creates them, so absent config files are hashed as `:absent`.
- **Task-aware verifier policy with glob patterns** — deferred: the frozen path set already solves the multi-file bug. Task-aware policy (Phase 7) can be layered on top later.
