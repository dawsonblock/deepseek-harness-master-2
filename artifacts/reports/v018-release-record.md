# DeepSeek Harness v0.18.0 Release Record

## Source

- Commit: `2c4c7b4`
- Tag: `v0.18.0`
- Qualification base: `v018-qualification-v2`
- Manifest hash: `a95c7634efd3ea47ba6e75ba1e6936d09b479ad60175bcf052bec3cec5daa900`

## Local validation

- 318 tests PASS
- typecheck PASS
- repository clean

## Live qualification

- 5/5 fixtures executed
- 3/5 unseen holdout pass (model capability)
- 13/13 control-plane gates PASS

## Control-plane invariants

| Invariant | Count |
|-----------|-------|
| Provider errors | 0 |
| Loop violations | 0 |
| Duplicate executions | 0 |
| Duplicate paid requests | 0 |
| Replay mismatches | 0 |
| Accounting violations | 0 |
| Authority violations | 0 |
| Rollback violations | 0 |
| Event-order violations | 0 |
| Holdout leakage | 0 |
| Sandbox violations | 0 |
| Unpriced usage | 0 |
| Missing trajectories | 0 |

## Model capability

| Fixture | Diagnostic | Holdout | Terminal outcome |
|---------|------------|---------|------------------|
| implement-debounce | PASS | PASS | verified-complete |
| implement-throttle | PASS | FAIL | qualification-failed |
| implement-memoize | PASS | PASS | verified-complete |
| fix-broken-sort | PASS | FAIL | qualification-failed |
| implement-promise-pool | PASS | PASS | verified-complete |

### Failed holdout semantics (frozen regression targets for v0.19)

**implement-throttle**
- diagnostic: PASS
- holdout: FAIL
- issues: zero-delay edge case, last-argument-in-window semantics

**fix-broken-sort**
- diagnostic: PASS
- holdout: FAIL
- issues: input mutation, duplicate handling

These holdout tests remain unseen qualification tests. Do not expose holdout details to future model repair runs.

## Spend

- Total cost: $0.031861
- Aggregate latency: 163.589s
- Total output tokens: 8987
- Total Flash attempts: 5
- Total Pro attempts: 0

## Qualification result

Runtime/control plane: QUALIFIED
Control-plane invariants: 13/13 PASS
Model capability: 3/5 unseen holdout passes

The v0.18 verified-escalation runtime is qualified for release. Model capability is reported separately. The two holdout failures are model capability shortfalls, not runtime defects.

## Release artifacts

- Tag: `v0.18.0` at `2c4c7b4`
- Evidence: `artifacts/reports/v018-live-qualification-evidence.json`
- Report: `artifacts/reports/v018-live-qualification-report.md`
- Manifest: `FULL_FILE_MANIFEST.sha256` (8266 entries)
- Release ZIP: `deepseek-harness-v0.18.0.zip`

## Manifest note

`FULL_FILE_MANIFEST.sha256` contains a self-entry that cannot be verified (fixed-point problem). The precise verification result is: 8265 ordinary files verified, manifest self-entry intentionally unverifiable. For v0.18.1+, the manifest should exclude its own path and publish a detached hash separately.
