#!/usr/bin/env node
/**
 * v0.16.0-rc1 paired Flash-vs-Pro benchmark: runs the same task on both
 * models with thinking enabled, measures cost, latency, and token usage,
 * and emits a comparison report.
 *
 * Run: DEEPSEEK_API_KEY=sk-... npx tsx scripts/run-rc1-benchmark.ts
 */

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { calculateCost, lookupPricing, DEFAULT_PRICING_REGISTRY } from '@deepseek-ai/dsh-token-meter'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = join(__dirname, '..')

const BENCHMARK_TASK = 'Explain in three sentences how a hash map handles collisions using open addressing.'

interface BenchmarkRun {
  model: string
  iteration: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheMissTokens: number
  reasoningTokens: number
  totalTokens: number
  costUsd: number
  pricingVersion: string
  latencyMs: number
  output: string
  error?: string
}

async function generateConfig(model: string, workDir: string): Promise<string> {
  const basePath = join(REPO_ROOT, 'examples', 'headless-agent', 'cordis.yml')
  let base = await readFile(basePath, 'utf8')
  base = base.replace(/model: deepseek-v4-flash/, `model: ${model}`)
  base = base.replace(/compression: !!js "process.env.DSH_SNAPSHOT === undefined \? 'zstd' : 'none'"/, "compression: 'none'")
  const configPath = join(workDir, 'cordis.yml')
  await writeFile(configPath, base, 'utf8')
  return configPath
}

function extractUsage(events: SessionEvent[]): {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheMissTokens: number
  reasoningTokens: number
  totalTokens: number
  output: string
} {
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheMissTokens = 0, reasoningTokens = 0, totalTokens = 0
  let output = ''
  for (const event of events) {
    if (event.type === 'model/usage') {
      const data = event.data as { usage: Record<string, number> }
      const u = data.usage
      inputTokens += u.inputTokens ?? 0
      outputTokens += u.outputTokens ?? 0
      cacheReadTokens += u.cacheReadTokens ?? 0
      cacheMissTokens += u.cacheMissTokens ?? 0
      reasoningTokens += u.reasoningTokens ?? 0
      totalTokens += u.totalTokens ?? 0
    }
    if (event.type === 'assistant/message') {
      const msg = event.data as { message: { content: Array<{ type: string; text?: string }> } }
      const text = msg.message.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
      if (text !== '') output = text
    }
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheMissTokens, reasoningTokens, totalTokens, output }
}

async function runBenchmarkIteration(model: string, iteration: number, workDir: string): Promise<BenchmarkRun> {
  const configPath = await generateConfig(model, workDir)
  const events: SessionEvent[] = []
  let uninstallFailLoud: (() => void) | undefined
  let ctx: Context | undefined

  try {
    loadEnv('rc1-benchmark')
    uninstallFailLoud = installFailLoud('rc1-benchmark')
    ctx = await boot('rc1-benchmark', resolveConfigPath(configPath, undefined))

    const start = Date.now()
    await runFixtureTurn(ctx, { task: BENCHMARK_TASK, onEvent: (_sid, event) => events.push(event) })
    const latencyMs = Date.now() - start

    const usage = extractUsage(events)
    const pricing = lookupPricing(DEFAULT_PRICING_REGISTRY, 'deepseek-official', model)
    let costUsd = 0
    let pricingVersion = 'N/A'
    if (pricing !== undefined) {
      pricingVersion = pricing.version
      const cost = calculateCost({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheMissTokens: usage.cacheMissTokens,
        reasoningTokens: usage.reasoningTokens,
        source: 'provider',
      }, pricing)
      costUsd = cost.amount
    }

    return {
      model,
      iteration,
      ...usage,
      costUsd,
      pricingVersion,
      latencyMs,
      output: usage.output,
    }
  } catch (error: unknown) {
    return {
      model,
      iteration,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheMissTokens: 0,
      reasoningTokens: 0, totalTokens: 0, costUsd: 0, pricingVersion: 'N/A',
      latencyMs: 0, output: '',
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await ctx?.fiber.dispose()
    uninstallFailLoud?.()
  }
}

function formatReport(runs: BenchmarkRun[]): string {
  const lines: string[] = []
  lines.push('# v0.16.0-rc1 Paired Flash-vs-Pro Benchmark')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('Commit: 1e1edc1')
  lines.push(`Task: "${BENCHMARK_TASK}"`)
  lines.push('Iterations: 3 per model')
  lines.push('')

  for (const model of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
    const modelRuns = runs.filter(r => r.model === model)
    lines.push(`## ${model}`)
    lines.push('────────────────────────────')

    if (modelRuns.every(r => r.error !== undefined)) {
      lines.push(`ALL RUNS FAILED: ${modelRuns[0]?.error}`)
      lines.push('')
      continue
    }

    const validRuns = modelRuns.filter(r => r.error === undefined)
    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length
    const avgCost = avg(validRuns.map(r => r.costUsd))
    const avgLatency = avg(validRuns.map(r => r.latencyMs))
    const avgInput = avg(validRuns.map(r => r.inputTokens))
    const avgOutput = avg(validRuns.map(r => r.outputTokens))
    const avgReasoning = avg(validRuns.map(r => r.reasoningTokens))
    const avgCacheHit = avg(validRuns.map(r => r.cacheReadTokens))

    lines.push(`Runs               ${validRuns.length}`)
    lines.push(`Avg prompt         ${avgInput.toFixed(0)}`)
    lines.push(`Avg cache hit      ${avgCacheHit.toFixed(0)}`)
    lines.push(`Avg output         ${avgOutput.toFixed(0)}`)
    lines.push(`Avg reasoning      ${avgReasoning.toFixed(0)}`)
    lines.push(`Avg latency        ${avgLatency.toFixed(0)}ms`)
    lines.push(`Avg cost           $${avgCost.toFixed(6)}`)
    lines.push(`Pricing version    ${validRuns[0]?.pricingVersion ?? 'N/A'}`)
    lines.push('')

    for (const run of modelRuns) {
      lines.push(`  Iteration ${run.iteration}: ${run.error ?? `cost=$${run.costUsd.toFixed(6)} latency=${run.latencyMs}ms output=${run.outputTokens}t reasoning=${run.reasoningTokens}t`}`)
    }
    lines.push('')
  }

  // Comparison
  const flashRuns = runs.filter(r => r.model === 'deepseek-v4-flash' && r.error === undefined)
  const proRuns = runs.filter(r => r.model === 'deepseek-v4-pro' && r.error === undefined)
  if (flashRuns.length > 0 && proRuns.length > 0) {
    lines.push('## Comparison')
    lines.push('────────────────────────────')
    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length
    const flashCost = avg(flashRuns.map(r => r.costUsd))
    const proCost = avg(proRuns.map(r => r.costUsd))
    const flashLatency = avg(flashRuns.map(r => r.latencyMs))
    const proLatency = avg(proRuns.map(r => r.latencyMs))
    lines.push(`Cost ratio (Pro/Flash)     ${(proCost / flashCost).toFixed(2)}x`)
    lines.push(`Latency ratio (Pro/Flash)  ${(proLatency / flashLatency).toFixed(2)}x`)
    lines.push(`Flash avg cost             $${flashCost.toFixed(6)}`)
    lines.push(`Pro avg cost               $${proCost.toFixed(6)}`)
    lines.push(`Flash avg latency          ${flashLatency.toFixed(0)}ms`)
    lines.push(`Pro avg latency            ${proLatency.toFixed(0)}ms`)
    lines.push('')
  }

  return lines.join('\n')
}

async function main(): Promise<void> {
  const hasKey = Boolean(process.env.DEEPSEEK_API_KEY)
  if (!hasKey) {
    process.stderr.write('DEEPSEEK_API_KEY is required for benchmark\n')
    process.exit(1)
  }

  const workRoot = await mkdtemp(join(tmpdir(), 'rc1-bench-'))
  process.stderr.write(`Benchmark work directory: ${workRoot}\n`)

  const ITERATIONS = 3
  const runs: BenchmarkRun[] = []

  for (const model of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
    for (let i = 1; i <= ITERATIONS; i++) {
      process.stderr.write(`Running ${model} iteration ${i}/${ITERATIONS}...\n`)
      const dir = join(workRoot, `${model}-${i}`)
      await mkdir(dir, { recursive: true })
      const run = await runBenchmarkIteration(model, i, dir)
      runs.push(run)
      if (run.error !== undefined) {
        process.stderr.write(`  FAILED: ${run.error}\n`)
      } else {
        process.stderr.write(`  OK: cost=$${run.costUsd.toFixed(6)} latency=${run.latencyMs}ms output=${run.outputTokens}t\n`)
      }
    }
  }

  const reportDir = join(REPO_ROOT, 'artifacts', 'reports')
  await writeFile(join(reportDir, 'v0.16.0-rc1-benchmark-results.json'), JSON.stringify({
    release: 'v0.16.0-rc.1',
    generatedAt: new Date().toISOString(),
    task: BENCHMARK_TASK,
    iterations: ITERATIONS,
    runs,
  }, null, 2), 'utf8')
  await writeFile(join(reportDir, 'v0.16.0-rc1-benchmark-report.md'), formatReport(runs), 'utf8')

  process.stderr.write('\nBenchmark reports written to artifacts/reports/\n')
  await rm(workRoot, { recursive: true, force: true })

  const failures = runs.filter(r => r.error !== undefined)
  if (failures.length > 0) {
    process.stderr.write(`${failures.length} run(s) failed\n`)
    process.exit(1)
  }
}

void main()
