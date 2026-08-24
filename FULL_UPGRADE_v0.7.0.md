# DeepSeek Harness Full Policy-Bound Verification & Code-Mode Telemetry Upgrade v0.7.0

v0.7.0 builds on the v0.6 verified-commit and crash-recovery work. It does not
add another agent layer. It strengthens completion-policy provenance, measures
Code Mode as a first-class execution mechanism, and adds actual process-kill
qualification of the durable lifecycle protocol.

## 1. Verification receipts are now policy-bound

`goal/verification` moves to payload version 2. Every receipt now records:

- exact goal id/revision;
- pass/fail and all independent checks;
- `basisSeq`: the durable session sequence immediately before verification;
- each check's semantic `role` (`acceptance` or `integrity`);
- an optional deployment-owned `verifierVersion`;
- `registryFingerprint`: SHA-256 over the exact sorted verifier name/role/version set.

A registered verifier can declare a stable version:

```ts
ctx.goals.registerAcceptanceVerifier({
  name: 'tests-pass',
  version: '3',
  verify: async ({ agent, goal }) => ({
    name: 'tests-pass',
    passed: true,
    reason: 'qualification suite passed',
    evidence: ['pytest:124/124'],
  }),
})
```

Autonomous completion is now authorized only when:

```text
fresh passing v2 verification
        +
exact goal revision
        +
latest durable event
        +
current verifier-registry fingerprint matches receipt
        -> completeVerified()
```

Adding/removing a verifier, changing acceptance/integrity role, or changing a
declared verifier version invalidates an old authorization. This closes a
policy drift gap left in v0.6. Historical v1 verification events remain log
history but cannot authorize a v0.7 verified commit.

## 2. Verifier-version discipline

Verifier versions are optional for compatibility, but an explicitly supplied
version must be non-empty. Deployments should bump the version whenever the
verifier's acceptance semantics change. The runtime-owned `runtime-integrity`
verifier declares version `1`.

## 3. Code Mode is now measurable

The hardening analyzer derives the following from the canonical native ledger:

- `codeRuns`;
- `codeSubdispatchesStarted`;
- `codeSubdispatchesSettled`;
- `codeSubdispatchErrors`;
- `codeSubdispatchErrorRate`;
- `averageCodeSubdispatchLatencyMs`;
- `p95CodeSubdispatchLatencyMs`;
- `averageCodeSubcallsPerRun`;
- `codeSubdispatchLogBytes`.

The last field is the serialized size of the durable nested-result copies that
do not re-enter model-visible history. It is not a token counter; it is a
useful lower-level signal for how much intermediate tool information Code Mode
processes outside the LLM conversation surface.

## 4. Real process-kill lifecycle qualification

`scripts/qualification-agent-kernel-v07-process-kill.mjs` launches a child
process, fsyncs lifecycle records to a JSONL log, then force-kills the process
at four boundaries:

1. after `tool/call`;
2. after `tool/dispatch`;
3. after `tool/settled` but before durable result commit;
4. after `tool/result`.

The recovered durable state must classify as:

```text
call only                     -> NOT_STARTED
call + dispatch               -> OUTCOME_UNKNOWN
call + dispatch + settled     -> OUTCOME_UNKNOWN
call + dispatch + result      -> COMPLETED
```

A settled event intentionally does not contain the canonical tool value, so a
crash after physical settlement but before `tool/result` still requires
idempotent retry or reconciliation rather than inventing a result.

## 5. Additional qualification

v0.7 adds:

- policy-binding qualification covering registry order-independence, version
  drift, old receipt rejection, and one-shot authorization invalidation;
- Code Mode sub-dispatch timing fixtures;
- source integration guard for receipt-v2 and telemetry wiring;
- native goal regression fixtures for registry/version drift.

These checks are added to root `check:all`, `check:ci`, and `release:verify`.

## 6. What remains deliberately unchanged

- The TypeScript Harness remains the sole production runtime.
- The Python kernel remains a reference/test oracle.
- Code Mode remains the existing native TypeScript implementation.
- Arbitrary shell/terminal execution is not mislabeled idempotent.
- A verifier's version is deployment-owned; changing verifier behavior without
  changing its declared version cannot be detected automatically.

## 7. Next high-value work

1. dependency-backed full monorepo CI;
2. objective-specific first-party acceptance verifier packages (tests,
   artifacts, benchmarks, external-state assertions);
3. domain reconcilers for more side-effecting first-party integrations;
4. production task experiments comparing verified/reconciled execution against
   baseline on success-per-cost and success-per-latency;
5. crash tests against the actual dependency-backed Session persistence
   implementations, in addition to the protocol-level process-kill harness.
