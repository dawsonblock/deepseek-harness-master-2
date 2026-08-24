import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')

const [
  hardeningPkg,
  hardeningTypes,
  hardeningMetrics,
  hardeningAcceptance,
  hardeningGovernor,
  hardeningBackpressure,
  subagent,
  subagentTypes,
  tokenTypes,
  tokenEstimate,
  tokenFold,
  tokenMeter,
  perfTelemetry,
  resourcePlugin,
  bashPersistent,
  pwshPersistent,
  rootPkg,
  hostTsconfig,
  baseBundle,
  lockfile,
  runtimeExample,
] = await Promise.all([
  read('packages/runtime/agent-kernel-hardening/package.json').then(JSON.parse),
  read('packages/runtime/agent-kernel-hardening/src/types.ts'),
  read('packages/runtime/agent-kernel-hardening/src/metrics.ts'),
  read('packages/runtime/agent-kernel-hardening/src/acceptance.ts'),
  read('packages/runtime/agent-kernel-hardening/src/resource-governor.ts'),
  read('packages/runtime/agent-kernel-hardening/src/backpressure.ts'),
  read('packages/subagent/subagent/src/index.ts'),
  read('packages/subagent/subagent/src/types.ts'),
  read('packages/llm/token-meter/src/types.ts'),
  read('packages/llm/token-meter/src/estimate.ts'),
  read('packages/llm/token-meter/src/surface-fold.ts'),
  read('packages/llm/token-meter/src/index.ts'),
  read('packages/runtime/performance-telemetry/src/index.ts'),
  read('packages/runtime/resource-governor/src/index.ts'),
  read('packages/shell/tool-bash-persistent/src/index.ts'),
  read('packages/shell/tool-pwsh-persistent/src/index.ts'),
  read('package.json').then(JSON.parse),
  read('tsconfig.host.json'),
  read('packages/bundle/base/package.json').then(JSON.parse),
  read('pnpm-lock.yaml'),
  read('config/runtime/v0.14.example.patch.yml'),
])

assert.match(hardeningPkg.version, /^0\.9\./, 'v0.14+ hardening package must remain in the compatible 0.9.x line')
assert.match(hardeningTypes, /RootResourceBudget/)
assert.match(hardeningTypes, /averageReasoningContextRatio/)
assert.match(hardeningTypes, /orchestrationOverheadRatio/)
assert.match(hardeningMetrics, /case 'context\/composition'/)
assert.match(hardeningMetrics, /case 'runtime\/performance-sample'/)
assert.match(hardeningMetrics, /case 'terminal\/settlement'/)
assert.match(hardeningMetrics, /case 'runtime\/backpressure'/)
assert.match(hardeningAcceptance, /RUNTIME_PERFORMANCE_GATES/)
assert.match(hardeningGovernor, /class RootResourceGovernor/)
assert.match(hardeningBackpressure, /class BoundedBackpressureGate/)

assert.match(subagentTypes, /SubagentAdmissionGuard/)
assert.match(subagent, /registerAdmissionGuard/)
assert.match(subagent, /acquireAdmissionGuards/)
assert.match(subagent, /releaseAdmissionLeases/)

assert.match(tokenTypes, /reasoningSurfaceTokens/)
assert.match(tokenTypes, /reasoningContextRatio/)
assert.match(tokenEstimate, /estimateReasoningContent/)
assert.match(tokenFold, /deltaReasoningTokens/)
assert.match(tokenMeter, /reasoningSurfaceTokens \+= surface\.deltaReasoningTokens/)

assert.match(perfTelemetry, /context\/composition/)
assert.match(perfTelemetry, /runtime\/performance-sample/)
assert.match(perfTelemetry, /unionDuration/)
assert.match(perfTelemetry, /queueMicrotask/)
assert.match(resourcePlugin, /runtime-resource-governor/)
assert.match(resourcePlugin, /recordModelUsage/)
assert.match(resourcePlugin, /recordEventBytes/)
assert.match(bashPersistent, /terminal\/settlement/)
assert.match(pwshPersistent, /terminal\/settlement/)

await stat(new URL('packages/runtime/performance-telemetry/tsconfig.json', root))
await stat(new URL('packages/runtime/resource-governor/tsconfig.json', root))
assert.match(hostTsconfig, /packages\/runtime\/performance-telemetry/)
assert.match(hostTsconfig, /packages\/runtime\/resource-governor/)


assert.equal(baseBundle.dependencies['@deepseek-ai/dsh-runtime-performance-telemetry'], 'workspace:^')
assert.equal(baseBundle.dependencies['@deepseek-ai/dsh-runtime-resource-governor'], 'workspace:^')
assert.match(lockfile, /packages\/runtime\/performance-telemetry/)
assert.match(lockfile, /packages\/runtime\/resource-governor/)
assert.match(lockfile, /link:\.\.\/\.\.\/runtime\/performance-telemetry/)
assert.match(lockfile, /link:\.\.\/\.\.\/runtime\/resource-governor/)
assert.match(runtimeExample, /runtime-performance-telemetry/)
assert.match(runtimeExample, /runtime-resource-governor/)

for (const script of ['verify:agent-kernel-v14', 'qualify:runtime-v14']) {
  assert.ok(rootPkg.scripts[script], `missing root script ${script}`)
}
console.log('v0.14 source integration guard: PASS')
