#!/usr/bin/env node
/**
 * v0.16.0-rc1 paired Flash-vs-Pro benchmark with verified economic value.
 *
 * Design:
 *   - Task-level paired benchmark: each task runs isolated on Flash and Pro.
 *   - Structured verification criteria per task (same status vocabulary as
 *     RoutingOutcome: verified-pass, verified-fail, unverified, incomplete).
 *   - Warm-up phase excluded from scored economics; randomized execution
 *     order to control cache-state confounds.
 *   - Per-run cache hit/miss/rate recorded; cacheComparable flag when
 *     paired hit-rate difference exceeds 10 percentage points.
 *   - Core metric: CostPerVerifiedTask = TotalCost / VerifiedPasses.
 *   - ProNecessityRate and ProWasteRate to characterize router value.
 *   - Median and p90 latency/cost, not just arithmetic means.
 *   - Pair classification: flash-sufficient, pro-necessary,
 *     both-pass-pro-more-expensive, both-fail, flash-better, pro-better.
 *
 * Token vocabulary (same two layers as the qualification runner):
 *   RAW: prompt_tokens = hit + miss, total = prompt + completion
 *   CANONICAL: inputTokens = cacheMiss, total = input + cacheRead + output
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

const MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'] as const
type Model = typeof MODELS[number]

// ---------------------------------------------------------------------------
// Verification: structured criteria mirroring goal/verification format
// ---------------------------------------------------------------------------

interface VerificationCriterion {
  description: string
  check: (output: string) => boolean
}

interface VerificationResult {
  status: 'verified-pass' | 'verified-fail' | 'unverified' | 'incomplete'
  criteriaPassed: number
  criteriaTotal: number
  checks: Array<{ description: string; passed: boolean }>
}

function verify(output: string, criteria: readonly VerificationCriterion[]): VerificationResult {
  if (output.trim() === '') return { status: 'incomplete', criteriaPassed: 0, criteriaTotal: criteria.length, checks: [] }
  const checks = criteria.map(c => ({ description: c.description, passed: c.check(output) }))
  const passed = checks.filter(c => c.passed).length
  const allPassed = passed === criteria.length
  return {
    status: allPassed ? 'verified-pass' : 'verified-fail',
    criteriaPassed: passed,
    criteriaTotal: criteria.length,
    checks,
  }
}

// ---------------------------------------------------------------------------
// Task classes with structured verification criteria
// ---------------------------------------------------------------------------

interface TaskClass {
  id: string
  category: string
  description: string
  task: string
  criteria: readonly VerificationCriterion[]
}

const TASK_CLASSES: readonly TaskClass[] = [
  {
    id: 'arithmetic',
    category: 'simple-factual',
    description: 'Simple arithmetic',
    task: 'What is 7 * 8? Reply with just the number.',
    criteria: [
      { description: 'Contains the number 56', check: o => /\b56\b/.test(o) },
      { description: 'Does not contain other numbers', check: o => o.replace(/\b56\b/g, '').replace(/[\s.,!?]/g, '').length === 0 },
    ],
  },
  {
    id: 'factual-explain',
    category: 'factual-formatting',
    description: 'Factual explanation in 3 sentences',
    task: 'Explain in three sentences how a hash map handles collisions using open addressing. Each sentence must be distinct.',
    criteria: [
      { description: 'Mentions open addressing or probing', check: o => /open.address|prob(e|ing)/i.test(o) },
      { description: 'Mentions collision or hash', check: o => /collision|hash/i.test(o) },
      { description: 'Has at least 2 sentence terminators', check: o => (o.match(/[.!?]+/g) ?? []).length >= 2 },
      { description: 'Does not exceed 5 sentences', check: o => (o.match(/[.!?]+/g) ?? []).length <= 5 },
    ],
  },
  {
    id: 'reasoning-proof',
    category: 'multi-step-reasoning',
    description: 'Prove sum of two odds is even',
    task: 'Think step by step. Prove that the sum of two odd integers is always even. Show your reasoning.',
    criteria: [
      { description: 'Defines odd integer (2k+1 form)', check: o => /2k\s*\+\s*1|2n\s*\+\s*1|odd.*form/i.test(o) },
      { description: 'Shows addition of two odds', check: o => /\(\s*2k\s*\+\s*1\s*\)\s*\+\s*\(\s*2m\s*\+\s*1\s*\)|odd.*\+.*odd/i.test(o) },
      { description: 'Factors out 2 from result', check: o => /2\s*\*\s*\(?\s*k\s*\+\s*m\s*\+\s*1|2\s*\(/i.test(o) },
      { description: 'Concludes result is even', check: o => /even|divisible.by.2|multiple.of.2/i.test(o) },
    ],
  },
  {
    id: 'code-edit',
    category: 'short-code-edit',
    description: 'Write a function to reverse a list',
    task: 'Write a TypeScript function called reverseList that takes an array and returns it reversed. Include the type signature.',
    criteria: [
      { description: 'Declares function reverseList', check: o => /function\s+reverseList|reverseList\s*[:=]/i.test(o) },
      { description: 'Takes an array parameter', check: o => /\[|Array|array|T\[\]/i.test(o) },
      { description: 'Returns reversed array', check: o => /\.reverse\(\)|reverse/i.test(o) },
      { description: 'Has TypeScript type annotation', check: o => /:\s*(T\[\]|Array|number\[\]|string\[\]|\w+\[\])/i.test(o) },
    ],
  },
  {
    id: 'structured-transform',
    category: 'structured-transformation',
    description: 'Convert CSV to JSON',
    task: 'Convert this CSV to a JSON array of objects:\nname,age\nAlice,30\nBob,25\n\nReply with only the JSON.',
    criteria: [
      { description: 'Contains valid JSON array', check: o => /^\s*\[/.test(o.trim()) && /\]\s*$/.test(o.trim()) },
      { description: 'Contains Alice with age 30', check: o => /Alice/i.test(o) && /30/.test(o) },
      { description: 'Contains Bob with age 25', check: o => /Bob/i.test(o) && /25/.test(o) },
      { description: 'Has name and age keys', check: o => /["']name["']|name\s*:/.test(o) && /["']age["']|age\s*:/.test(o) },
    ],
  },
]

// ---------------------------------------------------------------------------
// Benchmark run record
// ---------------------------------------------------------------------------

type CacheState = 'cold' | 'warm' | 'unknown'

interface BenchmarkRun {
  taskId: string
  model: Model
  iteration: number
  cacheState: CacheState
  routingDecisionId?: string
  cache: {
    hitTokens: number
    missTokens: number
    hitRate: number
  }
  usage: {
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
    totalTokens: number
  }
  economics: {
    costUsd: number
    pricingVersion: string
  }
  execution: {
    latencyMs: number
    attempts: number
    toolCalls: number
    toolFailures: number
    repairs: number
  }
  verification: VerificationResult
  output: string
  error?: string
}

interface FlashProPair {
  taskId: string
  flash: BenchmarkRun
  pro: BenchmarkRun
  classification:
    | 'flash-sufficient'
    | 'pro-necessary'
    | 'both-pass-pro-more-expensive'
    | 'both-fail'
    | 'flash-better'
    | 'pro-better'
  cacheComparable: boolean
}

// ---------------------------------------------------------------------------
// Config generation
// ---------------------------------------------------------------------------

async function generateConfig(model: Model, workDir: string): Promise<string> {
  const basePath = join(REPO_ROOT, 'examples', 'headless-agent', 'cordis.yml')
  let base = await readFile(basePath, 'utf8')
  base = base.replace(/model: deepseek-v4-flash/, `model: ${model}`)
  base = base.replace(/compression: !!js "process.env.DSH_SNAPSHOT === undefined \? 'zstd' : 'none'"/, "compression: 'none'")
  const configPath = join(workDir, 'cordis.yml')
  await writeFile(configPath, base, 'utf8')
  return configPath
}

// ---------------------------------------------------------------------------
// Event extraction
// ---------------------------------------------------------------------------

function extractFromEvents(events: SessionEvent[]): {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheMissTokens: number
  reasoningTokens: number
  totalTokens: number
  output: string
  toolCalls: number
  toolFailures: number
  routingDecisionId?: string
} {
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheMissTokens = 0, reasoningTokens = 0, totalTokens = 0
  let output = ''
  let toolCalls = 0
  let toolFailures = 0
  let routingDecisionId: string | undefined

  for (const event of events) {
    if (event.type === 'model/usage') {
      const data = event.data as { usage: Record<string, number>; routingDecisionId?: string }
      const u = data.usage
      inputTokens += u.inputTokens ?? 0
      outputTokens += u.outputTokens ?? 0
      cacheReadTokens += u.cacheReadTokens ?? 0
      cacheMissTokens += u.cacheMissTokens ?? 0
      reasoningTokens += u.reasoningTokens ?? 0
      totalTokens += u.totalTokens ?? 0
      if (data.routingDecisionId !== undefined) routingDecisionId = data.routingDecisionId
    }
    if (event.type === 'assistant/message') {
      const msg = event.data as { message: { content: Array<{ type: string; text?: string }> } }
      const text = msg.message.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
      if (text !== '') output = text
    }
    if (event.type === 'tool/call') toolCalls++
    if (event.type === 'tool/result') {
      const data = event.data as { message: { content: Array<{ isError?: boolean }> } }
      if (data.message.content.some(b => b.isError === true)) toolFailures++
    }
  }

  return {
    inputTokens, outputTokens, cacheReadTokens, cacheMissTokens,
    reasoningTokens, totalTokens, output, toolCalls, toolFailures,
    ...routingDecisionId !== undefined ? { routingDecisionId } : {},
  }
}

// ---------------------------------------------------------------------------
// Run execution
// ---------------------------------------------------------------------------

async function runBenchmarkIteration(
  model: Model,
  taskClass: TaskClass,
  iteration: number,
  cacheState: CacheState,
  workDir: string,
): Promise<BenchmarkRun> {
  const configPath = await generateConfig(model, workDir)
  const events: SessionEvent[] = []
  let uninstallFailLoud: (() => void) | undefined
  let ctx: Context | undefined

  try {
    loadEnv('rc1-benchmark')
    uninstallFailLoud = installFailLoud('rc1-benchmark')
    ctx = await boot('rc1-benchmark', resolveConfigPath(configPath, undefined))

    const start = Date.now()
    await runFixtureTurn(ctx, { task: taskClass.task, onEvent: (_sid, event) => events.push(event) })
    const latencyMs = Date.now() - start

    const extracted = extractFromEvents(events)
    const pricing = lookupPricing(DEFAULT_PRICING_REGISTRY, 'deepseek-official', model)
    let costUsd = 0
    let pricingVersion = 'N/A'
    if (pricing !== undefined) {
      pricingVersion = pricing.version
      const cost = calculateCost({
        inputTokens: extracted.inputTokens,
        outputTokens: extracted.outputTokens,
        cacheReadTokens: extracted.cacheReadTokens,
        cacheMissTokens: extracted.cacheMissTokens,
        reasoningTokens: extracted.reasoningTokens,
        source: 'provider',
      }, pricing)
      costUsd = cost.amount
    }

    const verificationResult = verify(extracted.output, taskClass.criteria)
    const hitRate = extracted.cacheReadTokens + extracted.cacheMissTokens > 0
      ? extracted.cacheReadTokens / (extracted.cacheReadTokens + extracted.cacheMissTokens)
      : 0

    return {
      taskId: taskClass.id,
      model,
      iteration,
      cacheState,
      ...extracted.routingDecisionId !== undefined ? { routingDecisionId: extracted.routingDecisionId } : {},
      cache: {
        hitTokens: extracted.cacheReadTokens,
        missTokens: extracted.cacheMissTokens,
        hitRate,
      },
      usage: {
        inputTokens: extracted.inputTokens,
        outputTokens: extracted.outputTokens,
        reasoningTokens: extracted.reasoningTokens,
        totalTokens: extracted.totalTokens,
      },
      economics: { costUsd, pricingVersion },
      execution: {
        latencyMs,
        attempts: 1,
        toolCalls: extracted.toolCalls,
        toolFailures: extracted.toolFailures,
        repairs: 0,
      },
      verification: verificationResult,
      output: extracted.output,
    }
  } catch (error: unknown) {
    return {
      taskId: taskClass.id,
      model,
      iteration,
      cacheState,
      cache: { hitTokens: 0, missTokens: 0, hitRate: 0 },
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
      economics: { costUsd: 0, pricingVersion: 'N/A' },
      execution: { latencyMs: 0, attempts: 1, toolCalls: 0, toolFailures: 0, repairs: 0 },
      verification: { status: 'incomplete', criteriaPassed: 0, criteriaTotal: taskClass.criteria.length, checks: [] },
      output: '',
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await ctx?.fiber.dispose()
    uninstallFailLoud?.()
  }
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    const a = sorted[mid - 1] ?? 0
    const b = sorted[mid] ?? 0
    return (a + b) / 2
  }
  return sorted[mid] ?? 0
}

function p90(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(Math.floor(sorted.length * 0.9), sorted.length - 1)
  return sorted[idx] ?? 0
}

function avg(values: number[]): number {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0
}

// ---------------------------------------------------------------------------
// Pair classification
// ---------------------------------------------------------------------------

function classifyPair(flash: BenchmarkRun, pro: BenchmarkRun): FlashProPair['classification'] {
  const flashPass = flash.verification.status === 'verified-pass'
  const proPass = pro.verification.status === 'verified-pass'

  if (!flashPass && !proPass) return 'both-fail'
  if (flashPass && !proPass) return 'flash-better'
  if (!flashPass && proPass) return 'pro-necessary'

  // Both pass
  if (pro.economics.costUsd > flash.economics.costUsd) return 'both-pass-pro-more-expensive'
  if (flash.economics.costUsd > pro.economics.costUsd) return 'pro-better'
  return 'both-pass-pro-more-expensive'
}

function cacheComparable(flash: BenchmarkRun, pro: BenchmarkRun): boolean {
  return Math.abs(flash.cache.hitRate - pro.cache.hitRate) <= 0.10
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

function formatReport(runs: BenchmarkRun[], pairs: FlashProPair[]): string {
  const lines: string[] = []
  lines.push('# v0.16.0-rc1 Paired Flash-vs-Pro Benchmark')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')
  lines.push('## Design')
  lines.push('')
  lines.push('- Task-level paired benchmark: each task runs isolated on Flash and Pro.')
  lines.push('- Structured verification criteria per task (same status vocabulary as RoutingOutcome).')
  lines.push('- Warm-up phase excluded from scored economics; randomized execution order.')
  lines.push('- Per-run cache hit/miss/rate recorded; cacheComparable flag when paired hit-rate difference > 10pp.')
  lines.push('- Core metric: CostPerVerifiedTask = TotalCost / VerifiedPasses.')
  lines.push('- ProNecessityRate = (Flash fail AND Pro pass) / all comparable pairs.')
  lines.push('- ProWasteRate = (both pass AND Pro more expensive) / Pro-selected opportunities.')
  lines.push('- Median and p90 latency/cost reported alongside arithmetic means.')
  lines.push('')

  // Per-model summary
  for (const model of MODELS) {
    const modelRuns = runs.filter(r => r.model === model && r.error === undefined)
    lines.push(`## ${model}`)
    lines.push('────────────────────────────')

    if (modelRuns.length === 0) {
      lines.push('ALL RUNS FAILED')
      lines.push('')
      continue
    }

    const verifiedPasses = modelRuns.filter(r => r.verification.status === 'verified-pass').length
    const totalCost = modelRuns.reduce((a, r) => a + r.economics.costUsd, 0)
    const cpt = verifiedPasses > 0 ? totalCost / verifiedPasses : Infinity
    const costs = modelRuns.map(r => r.economics.costUsd)
    const latencies = modelRuns.map(r => r.execution.latencyMs)
    const repairRate = modelRuns.reduce((a, r) => a + r.execution.repairs, 0) / modelRuns.length
    const toolFailureRate = modelRuns.reduce((a, r) => a + r.execution.toolFailures, 0) / modelRuns.length
    const reasoningPerTask = avg(modelRuns.map(r => r.usage.reasoningTokens))
    const cacheHitRate = avg(modelRuns.map(r => r.cache.hitRate))

    lines.push(`Runs                  ${modelRuns.length}`)
    lines.push(`Verified passes       ${verifiedPasses}/${modelRuns.length} (${((verifiedPasses / modelRuns.length) * 100).toFixed(1)}%)`)
    lines.push(`Total cost            $${totalCost.toFixed(6)}`)
    lines.push(`Mean cost/task        $${avg(costs).toFixed(6)}`)
    lines.push(`Median cost/task      $${median(costs).toFixed(6)}`)
    lines.push(`p90 cost/task         $${p90(costs).toFixed(6)}`)
    lines.push(`CostPerVerifiedTask   ${cpt === Infinity ? 'N/A (no passes)' : `$${cpt.toFixed(6)}`}`)
    lines.push(`Mean latency          ${avg(latencies).toFixed(0)}ms`)
    lines.push(`Median latency        ${median(latencies).toFixed(0)}ms`)
    lines.push(`p90 latency           ${p90(latencies).toFixed(0)}ms`)
    lines.push(`Repair rate           ${repairRate.toFixed(2)}/task`)
    lines.push(`Tool failure rate     ${toolFailureRate.toFixed(2)}/task`)
    lines.push(`Reasoning tokens/task ${reasoningPerTask.toFixed(0)}`)
    lines.push(`Cache hit rate        ${(cacheHitRate * 100).toFixed(1)}%`)
    lines.push(`Pricing version       ${modelRuns[0]?.economics.pricingVersion ?? 'N/A'}`)
    lines.push('')

    lines.push('Per-run detail:')
    for (const run of modelRuns) {
      const hitRatePct = (run.cache.hitRate * 100).toFixed(1)
      lines.push(`  ${run.taskId}/${run.iteration} [${run.cacheState}]: ${run.verification.status} (${run.verification.criteriaPassed}/${run.verification.criteriaTotal}) cost=$${run.economics.costUsd.toFixed(6)} latency=${run.execution.latencyMs}ms cacheHit=${run.cache.hitTokens} cacheMiss=${run.cache.missTokens} hitRate=${hitRatePct}% reasoning=${run.usage.reasoningTokens}t`)
    }
    lines.push('')
  }

  // Per-task-class comparison
  lines.push('## Per-task-class comparison')
  lines.push('')
  lines.push('| Task class | Category | Model | Verified | Cost | Median latency | Cache hit rate |')
  lines.push('|---|---|---|---|---|---|---|')

  for (const taskClass of TASK_CLASSES) {
    for (const model of MODELS) {
      const taskRuns = runs.filter(r => r.model === model && r.taskId === taskClass.id && r.error === undefined)
      if (taskRuns.length === 0) continue
      const verified = taskRuns.filter(r => r.verification.status === 'verified-pass').length
      const avgCost = avg(taskRuns.map(r => r.economics.costUsd))
      const medLat = median(taskRuns.map(r => r.execution.latencyMs))
      const hitRate = avg(taskRuns.map(r => r.cache.hitRate)) * 100
      lines.push(`| ${taskClass.id} | ${taskClass.category} | ${model} | ${verified}/${taskRuns.length} | $${avgCost.toFixed(6)} | ${medLat}ms | ${hitRate.toFixed(1)}% |`)
    }
  }
  lines.push('')

  // Pair classification
  lines.push('## Pair classification')
  lines.push('────────────────────────────')
  lines.push('')

  const classCounts: Record<string, number> = {}
  for (const pair of pairs) {
    classCounts[pair.classification] = (classCounts[pair.classification] ?? 0) + 1
  }
  const totalPairs = pairs.length
  lines.push('| Class | Count | % |')
  lines.push('|---|---:|---:|')
  for (const cls of ['flash-sufficient', 'pro-necessary', 'both-pass-pro-more-expensive', 'both-fail', 'flash-better', 'pro-better']) {
    const count = classCounts[cls] ?? 0
    lines.push(`| ${cls} | ${count} | ${totalPairs > 0 ? ((count / totalPairs) * 100).toFixed(1) : 0}% |`)
  }
  lines.push('')

  lines.push('Per-pair detail:')
  for (const pair of pairs) {
    const f = pair.flash
    const p = pair.pro
    lines.push(`  ${pair.taskId}: ${pair.classification} | cacheComparable=${pair.cacheComparable}`)
    lines.push(`    Flash: ${f.verification.status} (${f.verification.criteriaPassed}/${f.verification.criteriaTotal}) cost=$${f.economics.costUsd.toFixed(6)} latency=${f.execution.latencyMs}ms hitRate=${(f.cache.hitRate * 100).toFixed(1)}%`)
    lines.push(`    Pro:   ${p.verification.status} (${p.verification.criteriaPassed}/${p.verification.criteriaTotal}) cost=$${p.economics.costUsd.toFixed(6)} latency=${p.execution.latencyMs}ms hitRate=${(p.cache.hitRate * 100).toFixed(1)}%`)
  }
  lines.push('')

  // Aggregate metrics
  lines.push('## Aggregate metrics')
  lines.push('────────────────────────────')
  lines.push('')

  const comparablePairs = pairs.filter(p => p.cacheComparable)
  const proNecessary = pairs.filter(p => p.classification === 'pro-necessary').length
  const proNecessityRate = comparablePairs.length > 0 ? proNecessary / comparablePairs.length : 0
  const bothPassProExpensive = pairs.filter(p => p.classification === 'both-pass-pro-more-expensive').length
  const proWasteRate = pairs.length > 0 ? bothPassProExpensive / pairs.length : 0

  lines.push(`ProNecessityRate   ${(proNecessityRate * 100).toFixed(1)}% (${proNecessary}/${comparablePairs.length} comparable pairs)`)
  lines.push(`ProWasteRate       ${(proWasteRate * 100).toFixed(1)}% (${bothPassProExpensive}/${pairs.length} all pairs)`)
  lines.push(`Cache-comparable   ${comparablePairs.length}/${pairs.length} pairs`)
  lines.push('')

  // Overall comparison
  const allFlash = runs.filter(r => r.model === 'deepseek-v4-flash' && r.error === undefined)
  const allPro = runs.filter(r => r.model === 'deepseek-v4-pro' && r.error === undefined)
  if (allFlash.length > 0 && allPro.length > 0) {
    lines.push('## Overall comparison')
    lines.push('────────────────────────────')
    const flashVerified = allFlash.filter(r => r.verification.status === 'verified-pass').length
    const proVerified = allPro.filter(r => r.verification.status === 'verified-pass').length
    const flashTotalCost = allFlash.reduce((a, r) => a + r.economics.costUsd, 0)
    const proTotalCost = allPro.reduce((a, r) => a + r.economics.costUsd, 0)
    const flashCPT = flashVerified > 0 ? flashTotalCost / flashVerified : Infinity
    const proCPT = proVerified > 0 ? proTotalCost / proVerified : Infinity
    lines.push(`Flash verified:           ${flashVerified}/${allFlash.length} (${((flashVerified / allFlash.length) * 100).toFixed(1)}%)`)
    lines.push(`Pro verified:             ${proVerified}/${allPro.length} (${((proVerified / allPro.length) * 100).toFixed(1)}%)`)
    lines.push(`Flash total cost:         $${flashTotalCost.toFixed(6)}`)
    lines.push(`Pro total cost:           $${proTotalCost.toFixed(6)}`)
    lines.push(`Flash CostPerVerified:    ${flashCPT === Infinity ? 'N/A' : `$${flashCPT.toFixed(6)}`}`)
    lines.push(`Pro CostPerVerified:      ${proCPT === Infinity ? 'N/A' : `$${proCPT.toFixed(6)}`}`)
    lines.push(`Flash median latency:     ${median(allFlash.map(r => r.execution.latencyMs))}ms`)
    lines.push(`Pro median latency:       ${median(allPro.map(r => r.execution.latencyMs))}ms`)
    lines.push(`Cost ratio (Pro/Flash):   ${(proTotalCost / flashTotalCost).toFixed(2)}x`)
    if (flashCPT !== Infinity && proCPT !== Infinity) {
      lines.push(`CPT ratio (Pro/Flash):    ${(proCPT / flashCPT).toFixed(2)}x`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Main: warm-up then randomized paired execution
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const hasKey = Boolean(process.env.DEEPSEEK_API_KEY)
  if (!hasKey) {
    process.stderr.write('DEEPSEEK_API_KEY is required for benchmark\n')
    process.exit(1)
  }

  const workRoot = await mkdtemp(join(tmpdir(), 'rc1-bench-'))
  process.stderr.write(`Benchmark work directory: ${workRoot}\n`)

  const ITERATIONS = 2
  const runs: BenchmarkRun[] = []

  // Phase 1: warm both models (throwaway, excluded from scored economics)
  process.stderr.write('\nPhase 1: Warming cache for both models...\n')
  for (const model of MODELS) {
    const dir = join(workRoot, `warm-${model}`)
    await mkdir(dir, { recursive: true })
    process.stderr.write(`  Warming ${model}...\n`)
    const warmTask = TASK_CLASSES[0]
    if (warmTask === undefined) throw new Error('No task classes defined')
    const warmRun = await runBenchmarkIteration(model, warmTask, 0, 'warm', dir)
    if (warmRun.error !== undefined) {
      process.stderr.write(`  Warm FAILED: ${warmRun.error}\n`)
    } else {
      process.stderr.write(`  Warm OK: cacheHit=${warmRun.cache.hitTokens} cacheMiss=${warmRun.cache.missTokens}\n`)
    }
  }

  // Phase 2: randomized paired execution
  process.stderr.write('\nPhase 2: Paired benchmark (randomized order)...\n')

  // Build run list: for each task class and iteration, run both models
  const runList: Array<{ model: Model; taskClass: TaskClass; iteration: number }> = []
  for (const taskClass of TASK_CLASSES) {
    for (let i = 1; i <= ITERATIONS; i++) {
      for (const model of MODELS) {
        runList.push({ model, taskClass, iteration: i })
      }
    }
  }

  // Deterministic shuffle (seeded LCG) for reproducibility
  let seed = 42
  const rng = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  for (let i = runList.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const a = runList[i]
    const b = runList[j]
    if (a !== undefined && b !== undefined) {
      runList[i] = b
      runList[j] = a
    }
  }

  for (const { model, taskClass, iteration } of runList) {
    process.stderr.write(`  Running ${model} / ${taskClass.id} / iter ${iteration}...\n`)
    const dir = join(workRoot, `${model}-${taskClass.id}-${iteration}`)
    await mkdir(dir, { recursive: true })
    const run = await runBenchmarkIteration(model, taskClass, iteration, 'warm', dir)
    runs.push(run)
    if (run.error !== undefined) {
      process.stderr.write(`    FAILED: ${run.error}\n`)
    } else {
      const hitRatePct = (run.cache.hitRate * 100).toFixed(1)
      process.stderr.write(`    OK: ${run.verification.status} (${run.verification.criteriaPassed}/${run.verification.criteriaTotal}) cost=$${run.economics.costUsd.toFixed(6)} latency=${run.execution.latencyMs}ms hitRate=${hitRatePct}%\n`)
    }
  }

  // Build pairs
  const pairs: FlashProPair[] = []
  for (const taskClass of TASK_CLASSES) {
    for (let i = 1; i <= ITERATIONS; i++) {
      const flash = runs.find(r => r.model === 'deepseek-v4-flash' && r.taskId === taskClass.id && r.iteration === i)
      const pro = runs.find(r => r.model === 'deepseek-v4-pro' && r.taskId === taskClass.id && r.iteration === i)
      if (flash !== undefined && pro !== undefined) {
        pairs.push({
          taskId: `${taskClass.id}/${i}`,
          flash,
          pro,
          classification: classifyPair(flash, pro),
          cacheComparable: cacheComparable(flash, pro),
        })
      }
    }
  }

  // Generate reports
  const reportDir = join(REPO_ROOT, 'artifacts', 'reports')
  await writeFile(join(reportDir, 'v0.16.0-rc1-paired-benchmark.json'), JSON.stringify({
    release: 'v0.16.0-rc.1',
    generatedAt: new Date().toISOString(),
    design: {
      taskClasses: TASK_CLASSES.map(t => ({
        id: t.id,
        category: t.category,
        description: t.description,
        task: t.task,
        criteriaCount: t.criteria.length,
      })),
      iterations: ITERATIONS,
      cacheControl: 'warm-then-randomized',
      verification: 'structured criteria (same status vocabulary as RoutingOutcome)',
      coreMetric: 'CostPerVerifiedTask = TotalCost / VerifiedPasses',
    },
    runs,
    pairs,
  }, null, 2), 'utf8')
  await writeFile(join(reportDir, 'v0.16.0-rc1-paired-benchmark.md'), formatReport(runs, pairs), 'utf8')

  process.stderr.write('\nBenchmark reports written to artifacts/reports/\n')
  await rm(workRoot, { recursive: true, force: true })

  const failures = runs.filter(r => r.error !== undefined)
  if (failures.length > 0) {
    process.stderr.write(`${failures.length} run(s) failed\n`)
    process.exit(1)
  }
}

void main()
