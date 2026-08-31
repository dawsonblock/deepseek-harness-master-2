# Agent Note: Mid-turn routing escalation inflated Pro repair counters

Status: implemented

English | [中文](2026-08-31-v019-midturn-escalation-attribution.zh.md)

## Problem

The repair runtime attributed a verification-pass attempt to the model from the latest `model/routing-decision` event for the turn. When the router performed a mid-turn escalation from Flash to Pro (the discovered-complexity feature), the latest routing decision for the turn was Pro, so `handleVerificationPass` incremented `state.proAttempts` even though the attempt started with Flash and Flash did most of the work. This inflated `proAttempts` in the `repair/completed` event from 6 to 16 across the 22-task exploratory run, making `ProEscalationRate` read 72.7% instead of the correct 27.3%.

The trajectory collector separately extracted the attempt model from the first `model/routing-decision` for the turn (using `find`), so the `attempts` array correctly showed Flash. The contradiction between `proAttempts=1` and `attempts[0].model=flash` made the aggregate metrics internally inconsistent: 14 one-shot Flash + 16 Pro escalations + 1.27 mean attempts/task could not hold simultaneously.

A secondary field-name bug compounded the issue: the trajectory collector read `selection?.model` from the routing decision event, but the event schema uses `selected.model`. The fallback to `model/usage`'s model field masked this bug for the attempts array but not for the repair counters.

## Decision

The repair runtime now uses `firstRoutingDecisionId` (the first routing decision for the turn) instead of `latestRoutingDecisionId` when attributing a verification pass to a model. A mid-turn routing escalation is a routing feature, not a repair escalation; the attempt's model attribution reflects which model started the attempt, not which model finished it.

The trajectory collector now derives `flashAttempts` and `proAttempts` from the `attempts` array instead of trusting the `repair/completed` event's counters. This makes the trajectory self-consistent regardless of repair-runtime internal accounting. The field-name bug (`selection` vs `selected`) is also fixed.

## Verification

The 22 evaluated Batch A trajectories now reconcile: 22 Flash + 6 Pro = 28 total attempts, matching the 1.27 mean attempts/task. `ProEscalationRate` corrected from 72.7% to 27.3%, `ProRescueRate` from 68.8% to 33.3%. Repair-runtime package tests (149) and evaluation tests (31) pass.

## Alternatives considered

- **Count mid-turn escalations as Pro attempts** — rejected: a mid-turn routing escalation is the router adapting to discovered complexity within a single attempt, not a repair decision. Counting it as Pro would conflate routing policy with repair policy.
- **Derive counters only from `repair/decision` events, not from verification pass** — rejected: a one-shot success has no `repair/decision` event, so the counters would read zero for every one-shot task, losing the attempt-attribution signal.

## Consequences

`flashAttempts` and `proAttempts` in the trajectory now reflect the starting model of each attempt, not the repair runtime's internal counters. The `repair/completed` event's counters remain for the runtime's own use (repair controller decisions) but are no longer the source of truth for trajectory metrics. A turn that starts with Flash and escalates to Pro mid-turn is counted as one Flash attempt, not one Pro attempt.
