import { readFileSync } from 'node:fs'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const requireText = (source, needle, label) => {
  if (!source.includes(needle)) throw new Error(`v0.5 hardening invariant missing: ${label}`)
}


const knownEvents = read('packages/core/session/src/known-event-types.ts')
requireText(knownEvents, "'goal/verification'", 'goal verification is a known persistent event')
requireText(knownEvents, "'tool/reconciliation'", 'tool reconciliation is a known persistent event')
const persistenceCatalog = read('docs/persistence-catalog.md')
requireText(persistenceCatalog, '#### `goal/verification` — log-only', 'persistence catalog documents goal verification')
requireText(persistenceCatalog, '#### `tool/reconciliation` — log-only', 'persistence catalog documents tool reconciliation')

const tools = read('packages/core/tools/src/index.ts')
requireText(tools, "readonly mode: 'idempotent'", 'idempotent native recovery contract')
requireText(tools, "readonly mode: 'reconcile'", 'reconcile native recovery contract')
requireText(tools, 'reconcilePriorUnknownOutcome', 'pre-dispatch ambiguous-outcome reconciliation')
requireText(tools, 'TOOL_RECONCILIATION_REQUIRED', 'fail-closed ambiguous side-effect gate')
requireText(tools, 'defaultRecoveryOperationKey', 'content-bound canonical operation identity')

const sessionTypes = read('packages/core/session/src/types.ts')
requireText(sessionTypes, "recoveryMode?: 'idempotent' | 'reconcile'", 'durable per-call recovery mode')
requireText(sessionTypes, 'operationKey?: string', 'durable operation key')
requireText(sessionTypes, "'tool/reconciliation'", 'durable reconciliation evidence event')

const loop = read('packages/core/agent-loop/src/tool-calls.ts')
requireText(loop, 'recoveryMode', 'agent loop persists recovery mode')
requireText(loop, 'operationKey', 'agent loop persists operation key')

for (const path of [
  'packages/fs/tool-fs/src/read.ts',
  'packages/fs/tool-fs/src/read-image.ts',
  'packages/fs/tool-fs-search/src/grep.ts',
  'packages/fs/tool-fs-search/src/glob.ts',
]) {
  requireText(read(path), "mode: 'idempotent'", `${path} declares idempotency`)
}
const write = read('packages/fs/tool-fs/src/write.ts')
requireText(write, "mode: 'reconcile'", 'write declares reconciliation')
requireText(write, 'current !== input.content', 'write reconciles intended state before retry')
requireText(write, "state: 'completed'", 'write reconstructs proven prior completion')

const goal = read('packages/goal/goal/src/index.ts')
requireText(goal, "completionVerifiers.set('runtime-integrity'", 'independent runtime-integrity verifier')
requireText(goal, 'async verifyCompletion', 'goal verification API')
requireText(goal, "agent.session.append('goal/verification'", 'durable goal verification evidence')
requireText(goal, 'checks.every(check => check.passed)', 'all registered verification checks must pass')
requireText(goal, "registrations.some(registration => registration.role === 'acceptance')", 'autonomous completion requires an explicit objective acceptance verifier')

const goalTool = read('packages/goal/tool-goal/src/index.ts')
const verifyAt = goalTool.indexOf('await ctx.goals.verifyCompletion')
const completeAt = goalTool.indexOf('ctx.goals.completeVerified(execution.agent, ref)')
if (verifyAt < 0 || completeAt < 0 || verifyAt > completeAt) {
  throw new Error('v0.5 hardening invariant missing: autonomous verifier must run before goal completion')
}
requireText(goalTool, 'GOAL_TOOL_VERIFICATION_FAILED', 'autonomous completion fails closed on verifier rejection')

const metrics = read('packages/runtime/agent-kernel-hardening/src/metrics.ts')
requireText(metrics, "case 'tool/reconciliation'", 'telemetry counts reconciliation outcomes')
requireText(metrics, "case 'goal/verification'", 'telemetry counts goal verification outcomes')

console.log('v0.5 native enforcement source invariants: PASS')
