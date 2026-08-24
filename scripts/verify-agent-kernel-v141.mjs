import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = path => readFileSync(path, 'utf8')
const sessionTypes = read('packages/core/session/src/types.ts')
const known = read('packages/core/session/src/known-event-types.ts')
const perf = read('packages/runtime/performance-telemetry/src/index.ts')
const governor = read('packages/runtime/resource-governor/src/index.ts')
const bash = read('packages/shell/tool-bash-persistent/src/index.ts')
const pwsh = read('packages/shell/tool-pwsh-persistent/src/index.ts')
const acceptance = read('packages/runtime/agent-kernel-hardening/src/acceptance.ts')

for (const event of [
  'context/composition',
  'runtime/performance-sample',
  'runtime/backpressure',
  'subagent/resource',
  'terminal/settlement',
]) {
  assert.match(sessionTypes, new RegExp(`'${event.replace('/', '\\/')}'`), `${event} must have one canonical SessionEventMap owner`)
  assert.match(known, new RegExp(`'${event.replace('/', '\\/')}'`), `${event} must be in KNOWN_SESSION_EVENT_TYPES`)
}
assert.doesNotMatch(bash, /interface SessionEventMap[\s\S]*terminal\/settlement/, 'bash must not independently own terminal/settlement')
assert.doesNotMatch(pwsh, /interface SessionEventMap[\s\S]*terminal\/settlement/, 'pwsh must not independently own terminal/settlement')
assert.match(sessionTypes, /tool: 'bash' \| 'pwsh'/, 'shared terminal schema must cover Bash and PowerShell')
assert.match(perf, /ctx\.on\('llm\/stream'/, 'performance telemetry must wrap the actual LLM stream seam')
assert.match(perf, /ctx\.on\('tools\/execute'/, 'performance telemetry must wrap the actual tool body seam')
assert.match(perf, /performance\.now\(\)/, 'performance timing must use a monotonic clock')
assert.match(perf, /timingSource: 'monotonic-execution-spans'/, 'performance samples must identify monotonic span attribution')
assert.match(governor, /ctx\.on\('agent\/request'/, 'resource governor must enforce before model request construction/dispatch')
assert.match(governor, /governor\.recordModelUsage\(rootId, 1, 0\)/, 'model calls must be charged at pre-model admission')
assert.doesNotMatch(governor, /event\.type === 'model\/request'\) governor\.recordModelUsage/, 'model calls must not be charged only after model/request')
assert.match(acceptance, /terminalProtocolFallbackRate/, 'runtime gate must use protocol fallback, not timeout/exit/reset aggregation')
console.log('v0.14.1 source integration guard: PASS')
