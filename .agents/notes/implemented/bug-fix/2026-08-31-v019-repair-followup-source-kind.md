# Agent Note: Repair followup message source kind

Status: implemented

English | [中文](2026-08-31-v019-repair-followup-source-kind.zh.md)

## Problem

The repair runtime emitted its Flash-repair and Pro-escalation followup messages with `source: { kind: 'goal', goalId, revision, round: goal.roundsStarted + 1 }`. The goal fold (`applyGoalEvent` in `packages/goal/goal/src/fold.ts`) admits `user/message` events with `kind: 'goal'` only when `source.round === state.roundsStarted + 1`, then increments `roundsStarted`. Repair followups are not goal rounds — the goal-round driver owns round admission — so a second repair followup reused `round: 1` while `roundsStarted` had already advanced to 1, throwing `goal round at session event N is not the next admitted round of the active goal`. This blocked the S8 composed qualification scenario (two Flash failures → Pro escalation) and any real repair sequence with more than one followup.

## Decision

The repair runtime now sources its followup messages as `{ kind: 'plugin', plugin: 'repair-runtime' }` in `packages/core/repair-runtime/src/index.ts`. Repair followups are plugin-injected context, not goal rounds; the goal-round driver remains the sole consumer of `GoalMessageSource`.

## Verification

The composed runtime qualification S8 scenario passes (24/24 checks). The repair-runtime package tests (149 tests) and the P2.6 crash boundary equivalence tests (22 tests) pass. The full test suite shows no new failures.

## Alternatives considered

- **Increment `roundsStarted` per repair followup** — rejected: repair attempts are not goal rounds and must not consume the goal round budget. The goal-round driver owns round admission.
- **Disarm the goal to suppress the driver** — rejected: the conflict is the source kind, not the driver. Disarming would hide the invariant violation rather than fix it.

## Consequences

Repair followup messages no longer carry `GoalMessageSource`. Replay and trajectory reconstruction that filter on `kind: 'goal'` will not include repair followups, which is correct — repair followups are plugin context, not autonomous goal rounds.
