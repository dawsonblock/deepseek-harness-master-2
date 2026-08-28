# v0.18 Qualification Report (v2)

Qualification ID: v018-qualification-v2
Source commit: 4e3b2dfea83d40e0202c74623dee68be4d0f523a
Manifest hash: 2bc1850e12e1469a71b02344a5c1ad43ba6bef8bb4059c520e671dfb64347f0a
Generated: 2026-08-27

## Qualification identity

| Field | Value |
|------|-------|
| Qualification ID | v018-qualification-v2 |
| Source commit | 4e3b2dfea83d40e0202c74623dee68be4d0f523a |
| RepairController version | 0.18.0 |
| RepairRuntime version | 0.18.0 |
| Event schema version | 0 |
| Pricing version | 2026-08-25 |
| Sandbox policy version | v1 |
| Sandbox qualification ID | v018-sandbox-v1 |
| Fixture version | v1 |
| Holdout version | v1 |

## Model routes

| Alias | Provider | Model |
|-------|----------|-------|
| flash | deepseek | deepseek-v4-flash |
| pro | deepseek | deepseek-v4-pro |

## Default repair limits

| Limit | Value |
|-------|-------|
| maxFlashAttempts | 3 |
| maxProAttempts | 2 |
| maxTotalAttempts | 5 |
| maxTaskCostUsd | (undefined) |
| maxElapsedMs | (undefined) |
| maxOutputTokens | (undefined) |

## Frozen fixtures

| Fixture ID | Task hash | Workspace hash | Diagnostic hash | Holdout hash |
|------------|-----------|----------------|-----------------|--------------|
| implement-debounce | (recorded in manifest) | (recorded in manifest) | (recorded in manifest) | (recorded in manifest) |
| implement-throttle | (recorded in manifest) | (recorded in manifest) | (recorded in manifest) | (recorded in manifest) |
| implement-memoize | (recorded in manifest) | (recorded in manifest) | (recorded in manifest) | (recorded in manifest) |
| fix-broken-sort | (recorded in manifest) | (recorded in manifest) | (recorded in manifest) | (recorded in manifest) |
| implement-promise-pool | (recorded in manifest) | (recorded in manifest) | (recorded in manifest) | (recorded in manifest) |

## Sandbox qualification

| Platform | Backend | Supported | Qualification | Isolation model | Tests passed |
|----------|---------|-----------|---------------|-----------------|--------------|
| darwin | seatbelt | yes | pass | protected-path-denylist | 9/9 |
| linux | bwrap | yes | not-run | mount-namespace-allowlist | 0/9 |
| linux | landlock | yes | not-run | allow-list-grants | 0/9 |
| win32 | restricted-token-acl | no | not-run | acl-restricted-token | 0/9 |

Darwin/Seatbelt qualified with all 9 adversarial read-isolation tests:
direct-absolute-protected-read, benchmark-source-read, workspace-read,
workspace-write, relative-traversal, symlink-to-file, symlink-to-dir,
child-bash-read, child-node-read.

Linux and Windows backends are implemented but not qualified in this
release environment. They report `not-run` rather than implying success.

## Prerequisite gate

| Prerequisite | Status |
|--------------|--------|
| repository-clean | PASS |
| typecheck | PASS |
| repair-tests | PASS |

## Provider preflight

| Check | Status |
|-------|--------|
| DEEPSEEK_API_KEY | not set |
| Flash smoke | skipped (no key) |
| Pro smoke | skipped (no key) |

Live qualification requires DEEPSEEK_API_KEY. The runner aborts before
provider calls if prerequisites fail or the key is missing.

## Integrated qualification gates (fake-provider)

All gates run through the v018 repair loop, which consumes the production
RepairController.decideRepair.

### P2.5: Integrated holdout semantics

| Scenario | Result |
|----------|--------|
| diagnostic PASS → holdout FAIL → terminal | PASS |
| holdout FAIL → zero repair/decision | PASS |
| holdout FAIL → zero model/escalation | PASS |
| holdout FAIL → outcome is qualification-failed | PASS |

### P2.6: Crash boundary equivalence

| Scenario | Result |
|----------|--------|
| Flash repair: uninterrupted vs re-run | PASS (identical) |
| Pro escalation: uninterrupted vs re-run | PASS (identical) |
| Sequential attempt numbers | PASS |
| Unique routing decision IDs | PASS |

### P2.7: Canonical accounting end-to-end

| Scenario | Result |
|----------|--------|
| TaskCost = Σ Price(usage_i) | PASS |
| totalOutputTokens = Σ outputTokens | PASS |
| totalLatencyMs = Σ latencyMs | PASS |
| Cache fields preserved per attempt | PASS |
| Attempt invariant: total = flash + pro | PASS |
| aggregateUsage produces correct totals | PASS |

### P2.8: Every terminal outcome

| Outcome | Scenario | Result |
|---------|----------|--------|
| verified | Flash #1 → diagnostic pass → holdout pass | PASS |
| qualification-failed | diagnostic pass → holdout fail | PASS |
| attempts-exhausted | Flash ×3 fail, Pro ×2 fail → stop | PASS |
| cost-limit | budget exceeded → stop | PASS |
| time-limit | elapsed time exceeded → stop | PASS |
| output-token-limit | output tokens exceeded → stop | PASS |
| terminal-no-additional-calls | no 6th call after stop | PASS |
| production-decide | runner uses production decideRepair | PASS |

## Anti-cheating protections

| Protection | Status |
|------------|--------|
| Holdout leakage detection | implemented |
| Holdout string extraction and detection | implemented |
| Secret sanitization (API key redaction) | implemented |
| Absolute workspace path removal | implemented |
| Immutable model-visible evidence projections | implemented |
| Workspace provenance hashing | implemented |
| Pre-execution verifier snapshot | implemented |
| Post-execution verifier tamper detection | implemented |
| Test discovery disabled detection | implemented |
| Required source excluded detection | implemented |
| Verification command weakened detection | implemented |

## Test summary

| Suite | Tests | Status |
|-------|-------|--------|
| RepairController decide | 39 | PASS |
| RepairController state-machine | 24 | PASS |
| RepairController event-ordering | 16 | PASS |
| RepairRuntime integration | 21 | PASS |
| RepairRuntime P0 inspection | 4 | PASS |
| RepairRuntime P1 accounting | 9 | PASS |
| RepairRuntime P1 authority | 11 | PASS |
| RepairRuntime P1 budget-gates | 6 | PASS |
| RepairRuntime P1 holdout | 7 | PASS |
| RepairRuntime P1 idempotency | 12 | PASS |
| RepairRuntime P1 invariants | 10 | PASS |
| RepairRuntime P1 outcome-semantics | 9 | PASS |
| RepairRuntime P1 output-token-budget | 7 | PASS |
| RepairRuntime P1 provenance | 6 | PASS |
| RepairRuntime P1 rollback | 10 | PASS |
| RepairRuntime P1 sanitization | 23 | PASS |
| RepairRuntime replay | 10 | PASS |
| v018 fake-provider qualification | 8 | PASS |
| v018 verification-security | 43 | PASS |
| v018 qualification-manifest | 21 | PASS |
| v018 P2 integrated qualification | 22 | PASS |
| **Total** | **318** | **PASS** |

## Live fixture qualification

| Fixture | Status |
|---------|--------|
| implement-debounce | blocked (needs DEEPSEEK_API_KEY) |
| implement-throttle | blocked (needs DEEPSEEK_API_KEY) |
| implement-memoize | blocked (needs DEEPSEEK_API_KEY) |
| fix-broken-sort | blocked (needs DEEPSEEK_API_KEY) |
| implement-promise-pool | blocked (needs DEEPSEEK_API_KEY) |

Live fixture qualification requires DEEPSEEK_API_KEY. The five frozen
fixtures are defined, hashed, and bound to the manifest. The runner will
execute them when the key is available.

## Control-plane gate vs model capability

Control-plane gates (repo clean, typecheck, repair tests, sandbox
qualification, manifest verification) are separated from model-capability
results (live fixture pass/fail). A control-plane gate failure aborts
before provider calls. A model-capability failure is recorded per fixture
without aborting the run.

## Terminal outcomes

The v018 repair loop produces the following terminal outcomes, each
verified by P2.8:

- `verified`: diagnostic pass + holdout pass
- `qualification-failed`: diagnostic pass + holdout fail
- `attempts-exhausted`: Flash ×3 + Pro ×2 all fail
- `cost-limit`: maxTaskCostUsd exceeded
- `time-limit`: maxElapsedMs exceeded
- `output-token-limit`: maxOutputTokens exceeded

## Release readiness

| Gate | Status |
|------|--------|
| P2.1 Qualification identity frozen | PASS |
| P2.2 Sandbox qualification per platform | PASS (darwin qualified, others not-run) |
| P2.3 Anti-cheating hardening | PASS |
| P2.4 Fixtures frozen + manifest | PASS |
| P2.5 Holdout semantics | PASS |
| P2.6 Crash boundary equivalence | PASS |
| P2.7 Canonical accounting | PASS |
| P2.8 Terminal outcomes | PASS |
| P2.9 Event catalog regenerated | PASS |
| P2.10 Prerequisite gate | PASS |
| P2.11 Provider preflight | blocked (no API key) |
| P2.12 Five frozen fixtures | blocked (no API key) |
| P2.13 Control-plane vs model capability | PASS (separation verified) |
| P2.14 Manual trajectory audit | pending live fixtures |
| P2.15 Qualification report | this document |
| P2.16 Agent Note promotion | pending |
| P2.17 Exact-export manifest + ZIP | pending |
| P2.18 Freeze v0.18.0 | pending |

The controller and runtime are frozen. No changes unless qualification
exposes a correctness defect. Live fixture qualification (P2.12-P2.14)
requires DEEPSEEK_API_KEY and will be completed when the key is available.
