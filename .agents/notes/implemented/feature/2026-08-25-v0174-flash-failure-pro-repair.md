# Agent Note: v0.17.4 Real Flash-Failure → Pro-Repair Experiment

Status: implemented

English | [中文](2026-08-25-v0174-flash-failure-pro-repair.zh.md)

## Problem

v0.17.3 demonstrated that verification-triggered Flash-to-Pro escalation reaches the same verified-success range as Pro-only at 55.3% lower cost per verified task. However, the v0.17.3 simulation used counterfactual paired runs: the Pro outcome was an independent attempt that never received Flash's failure evidence. The result estimates the economics of escalation but not the economics of evidence-conditioned repair. The independent retry proxy (98% verified) was correctly excluded from repair claims because a repeated prompt is not a repair trajectory.

The key unanswered question is whether Pro can take over a task Flash already failed, and whether giving Pro the failure evidence helps it succeed where a fresh Pro start would not.

## Decision

v0.17.4 builds and validates the real repair experiment infrastructure. It defines a canonical `FailurePackage`, deterministic failure fingerprinting, progress-aware same-failure escalation, bounded stage loops, and a runner that executes joined multi-stage trajectories where Pro receives the actual Flash failure evidence and chooses `REPAIR_EXISTING` or `ROLLBACK_AND_REDO` before mutating the workspace.

**v0.17.4 is a research experiment. It does not change runtime routing authority. The deterministic ordering remains unchanged: manual selection → durable authority → hard policy constraints → context/provider availability → authoritative heuristic router.**

The experiment compares five policies on the identical coding-task corpus:

```text
A. flash-only: Flash → verify → done
B. pro-only: Pro → verify → done
C. flash-fail-pro-fresh: Flash → verify → fail → Pro fresh start (no evidence)
D. flash-fail-pro-repair: Flash → verify → fail → FailurePackage → Pro repair with evidence
E. flash-repair-then-pro: Flash → verify → fail → Flash repair with evidence → Pro takeover if still failing
```

Policy D is the primary result. If D outperforms C, failure evidence helps Pro take over failed Flash tasks.

### FailurePackage

The canonical failure evidence structure is defined in `scripts/v0174-repair-core.ts`:

```ts
interface FailurePackage {
  taskId: string
  routingDecisionId: string
  originalGoal: string
  attempt: {
    model: string
    changedFiles: readonly string[]
    patchSummary?: string
  }
  verification: {
    failedCriteria: readonly string[]
    failingTests: readonly string[]
    typeErrors: readonly string[]
    buildErrors: readonly string[]
  }
  failureFingerprint: string
  progress: 'none' | 'partial' | 'regression'
  checkpoints: {
    taskStart: string
    afterFlash: string
  }
}
```

The structure preserves the original goal, identifies the Flash model and routing decision, records changed files and patch summary, captures objective verification failures (failed criteria, failing tests, type errors, build errors), carries a deterministic fingerprint, classifies progress relative to prior failures, and records task-start and after-Flash checkpoints.

### Deterministic failure fingerprinting

`computeFailureFingerprint()` normalizes failure evidence by stripping absolute file paths, line:col positions, timing, hex addresses, and incidental formatting, then hashes the sorted normalized content with SHA-256 truncated to 16 hex characters. Two attempts that fail for the same substantive reasons produce the same fingerprint regardless of incidental differences.

### Progress-aware same-failure escalation

`classifyProgress()` compares the current failure evidence to the prior failure evidence and returns `none` (first failure or same substantive failure), `partial` (fewer or different failures), or `regression` (more failures).

`decideEscalation()` applies the escalation rule: after two consecutive Flash failures share the same fingerprint, escalate to Pro immediately rather than wasting another Flash call. This implements progress-aware escalation rather than arbitrary retry counts.

### Bounded stage loops

`LoopBounds` limits total stages per task (default 4: Flash, Flash repair, Pro, stop). `detectLoopViolation()` verifies that no trajectory exceeds the bounds. The runner checks for violations after every task.

### Pro takeover decision

Pro receives the `FailurePackage` via `constructProRepairPrompt()` and must state `REPAIR_EXISTING` or `ROLLBACK_AND_REDO` on the first line before making any changes. `parseTakeoverDecision()` extracts the choice. For `REPAIR_EXISTING`, Pro works in the same workspace as Flash. For `ROLLBACK_AND_REDO`, Pro starts from a clean workspace.

### Objective verification

Coding-task fixtures use file-based tasks with objective verification: TypeScript typecheck (`tsc --noEmit`) and test execution (`vitest run`). Each fixture creates initial files (package.json, tsconfig.json, test file) and the agent writes the implementation file. Verification runs after each stage and collects failing tests, type errors, and build errors as structured evidence.

### Metrics

The experiment reports:

- **Verified success rate** — primary constraint.
- **Cost per verified task** — primary optimization target.
- **Pro Rescue Rate** = failed Flash tasks subsequently verified by Pro / tasks escalated to Pro.
- **Escalation Cost Efficiency** = total escalation cost / successful Pro rescues.
- **Auditable escalation rate** = escalations with a constructed FailurePackage / total escalations.
- **Same-failure detection rate** — tasks where repeated Flash failures shared the same fingerprint.
- **Loop violations** — must be 0.
- **REPAIR_EXISTING vs ROLLBACK_AND_REDO choice distribution.**
- **Median and p90 latency.**

### Keyless validation

`scripts/v0174-repair-core.spec.ts` validates 53 test cases covering fingerprint determinism, order independence, path normalization, progress classification, same-failure detection, escalation decisions, loop bound enforcement, FailurePackage construction, Pro repair prompt generation, takeover decision parsing, and policy metric computation. All tests pass without an API key.

### Live collection

The runner self-skips without `DEEPSEEK_API_KEY`. Live collection requires a rotated credential; the previously exposed key is compromised and must not be reused. The runner checkpoints after every task and resumes without repeating completed tasks.

## Alternatives considered

### Continue with counterfactual paired simulation

v0.17.3's paired simulation estimates escalation economics but cannot measure whether failure evidence helps Pro. A real repair trajectory is needed to isolate the value of the FailurePackage.

### Add a new runtime repair package

A dedicated Cordis plugin package for repair semantics would over-build for a research experiment with no current runtime consumer. The core types and logic live in `scripts/v0174-repair-core.ts` as pure functions. If v0.18 promotes the policy, the types can be promoted to a package at that point.

### Overload llm-retry with coding-task repair semantics

`llm-retry` handles provider-level HTTP failures with bounded retry policy. Coding-task repair is a different concern: it operates on workspace state and verification evidence, not request failures. Overloading `llm-retry` would conflate two distinct failure domains.

### Write explicit repairOf metadata on model/routing-decision events

`RepairAttribution` in `routing-outcome.ts` supports explicit `repairOf` metadata, but no producer writes it. Adding a producer would change the session event protocol for a research experiment. The experiment records repair attribution at the experiment level, keeping the runtime protocol unchanged. A real producer is deferred until v0.18 promotion.

### Use text-output tasks instead of file-based coding tasks

The v0.17.2 corpus uses text-output tasks verified by regex. The repair architecture (REPAIR_EXISTING, ROLLBACK_AND_REDO, Flash diff, changed files) requires file-based tasks with objective verification (typecheck, tests). New coding-task fixtures are designed specifically for repair experiments.

## Consequences

The repository now has validated infrastructure for real evidence-conditioned repair experiments. The canonical `FailurePackage`, deterministic fingerprinting, progress-aware escalation, and bounded loops are pure functions with keyless test coverage. The runner is ready for live collection with a rotated credential.

The experiment result will determine whether v0.18 promotes verification-triggered escalation to authoritative runtime behavior. The promotion gate requires: Flash→Pro repair within ~1-2 percentage points of Pro-only verified success or better, at least ~40% lower cost per verified task, Pro utilization below ~20-25%, high rescue efficiency, same-failure detection preventing useless retries, no infinite loops, every escalation having auditable failure evidence, and every final result receiving independent verification.

Learned-routing research remains demoted to offline instrumentation. The workload-v2 features and Bayesian history may eventually provide a Pro-first override for the tiny number of tasks where attempting Flash first is predictably wasteful, but that predictor is not needed for the reactive escalation policy.
