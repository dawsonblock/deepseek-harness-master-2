import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'

let checks = 0
const check = (condition, message) => { assert.ok(condition, message); checks += 1 }

const source = readFileSync('packages/runtime/performance-telemetry/src/index.ts', 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    verbatimModuleSyntax: true,
  },
  reportDiagnostics: true,
})
check(!(compiled.diagnostics ?? []).some(d => d.category === ts.DiagnosticCategory.Error), 'performance telemetry must transpile')
const dir = mkdtempSync(join(tmpdir(), 'dsh-v141-'))
try {
  const file = join(dir, 'performance.mjs')
  writeFileSync(file, compiled.outputText)
  const mod = await import(`file://${file}`)
  const sample = mod.deriveTurnPerformanceSample(1000, [
    { start: 100, end: 600 },
  ], [
    { start: 650, end: 850 },
    { start: 700, end: 900 },
  ])
  check(sample.turnWallMs === 1000, 'turn wall is preserved')
  check(sample.modelWaitMs === 500, 'model interval uses monotonic model span')
  check(sample.externalToolMs === 250, 'overlapping tool spans are unioned')
  check(sample.orchestrationMs === 250, 'orchestration is residual wall time')
  check(sample.orchestrationOverheadRatio === 0.25, 'orchestration ratio is derived from residual wall time')
  check(mod.unionDuration([{ start: 0, end: 10 }, { start: 5, end: 20 }, { start: 30, end: 40 }]) === 30, 'unionDuration does not double-count overlap')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

const sessionTypes = readFileSync('packages/core/session/src/types.ts', 'utf8')
const known = readFileSync('packages/core/session/src/known-event-types.ts', 'utf8')
for (const event of ['context/composition','runtime/performance-sample','runtime/backpressure','subagent/resource','terminal/settlement']) {
  check(sessionTypes.includes(`'${event}'`), `${event} has canonical schema`)
  check(known.includes(`'${event}'`), `${event} is known to persistence`)
}

const governor = readFileSync('packages/runtime/resource-governor/src/index.ts', 'utf8')
check(governor.indexOf("ctx.on('agent/request'") < governor.indexOf("ctx.on('session/event'"), 'pre-model admission is installed before passive session accounting')
check(governor.includes("action: 'model-admit'"), 'durable diagnostics identify admitted model attempts')

const hardening = await import('../packages/runtime/agent-kernel-hardening/lib/index.js')
const metrics = hardening.deriveAgentKernelMetrics([
  { seq: 0, time: 0, type: 'terminal/settlement', data: { mode: 'marker' } },
  { seq: 1, time: 1, type: 'terminal/settlement', data: { mode: 'prompt' } },
  { seq: 2, time: 2, type: 'terminal/settlement', data: { mode: 'timeout' } },
  { seq: 3, time: 3, type: 'terminal/settlement', data: { mode: 'exit' } },
  { seq: 4, time: 4, type: 'terminal/settlement', data: { mode: 'reset' } },
])
check(metrics.terminalProtocolFallbackRate === 0.2, 'only prompt/silence count as PTY protocol fallback')
check(metrics.terminalTimeoutRate === 0.2, 'timeouts are measured separately')
check(metrics.terminalExitRate === 0.2, 'exits are measured separately')
check(metrics.terminalResetRate === 0.2, 'resets are measured separately')

const g = new hardening.RootResourceGovernor({ maxModelCalls: 2 })
g.recordModelUsage('root', 1, 0)
g.recordModelUsage('root', 1, 0)
let blocked = false
try { g.recordModelUsage('root', 1, 0) } catch (error) { blocked = error instanceof hardening.ResourceBudgetExceededError }
check(blocked, 'third model admission is blocked at a two-call ceiling')

console.log(`v0.14.1 runtime qualification: ${checks}/${checks} PASS`)
