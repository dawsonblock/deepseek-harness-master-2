import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const goal = readFileSync('packages/goal/goal/src/index.ts', 'utf8')
const goalDomain = readFileSync('packages/goal/goal/src/domain.ts', 'utf8')
const toolGoal = readFileSync('packages/goal/tool-goal/src/index.ts', 'utf8')
const tools = readFileSync('packages/core/tools/src/index.ts', 'utf8')
const toolCalls = readFileSync('packages/core/agent-loop/src/tool-calls.ts', 'utf8')
const write = readFileSync('packages/fs/tool-fs/src/write.ts', 'utf8')

for (const token of [
  'registerAcceptanceVerifier',
  'registerIntegrityVerifier',
  'completeVerified',
  "role: 'integrity'",
  "registerVerifier(verifier, 'acceptance')",
]) assert.ok(goal.includes(token), `missing GoalService token: ${token}`)

assert.ok(goalDomain.includes("'GOAL_VERIFICATION_REQUIRED'"), 'missing verified-completion error code')
assert.ok(goal.includes("latest?.type !== 'goal/verification'"), 'completeVerified must require the latest event to be verification evidence')
assert.ok(goal.includes('latest.data.goal.revision !== ref.revision'), 'completeVerified must bind evidence to the exact revision')

const verificationAt = toolGoal.indexOf('await ctx.goals.verifyCompletion(execution.agent, ref)')
const verifiedCommitAt = toolGoal.indexOf('ctx.goals.completeVerified(execution.agent, ref)')
assert.ok(verificationAt >= 0 && verifiedCommitAt > verificationAt, 'autonomous completion must verify before verified commit')

const reconcileAt = tools.indexOf('reconcilePriorUnknownOutcome(exec)')
const dispatchAt = toolCalls.indexOf("'tool/dispatch'")
assert.ok(reconcileAt >= 0, 'missing reconciliation preflight')
assert.ok(dispatchAt >= 0, 'missing tool dispatch lifecycle evidence')
assert.ok(write.includes("mode: 'reconcile'"), 'filesystem write must remain reconcile-mode')

const readOnlyRecoveryFiles = [
  'packages/web/tool-web/src/fetch.ts',
  'packages/web/tool-web/src/search.ts',
  'packages/lsp/tool-lsp/src/index.ts',
  'packages/session-query/tool-session-query/src/index.ts',
]
for (const file of readOnlyRecoveryFiles) {
  const source = readFileSync(file, 'utf8')
  assert.ok(source.includes("recovery: { mode: 'idempotent' }"), `missing explicit idempotent recovery: ${file}`)
}

console.log('agent-kernel v0.6 source integration guard: PASS')
