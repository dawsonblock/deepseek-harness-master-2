#!/usr/bin/env node
/**
 * v0.16.0-rc1 expanded paired benchmark with three-policy comparison.
 *
 * Three policies per task:
 *   A: Flash-only (direct selection)
 *   B: Pro-only (direct selection)
 *   C: Current router (llm-model-router decides)
 *
 * Cold/warm separation:
 *   Cold: fresh context, no prior cache for this task prefix.
 *   Warm: after a warm-up request with the same system prefix.
 *
 * Metrics:
 *   - CostPerVerifiedTask = TotalCost / VerifiedPasses (per policy)
 *   - ProNecessityRate = (Flash fail AND Pro pass) / comparable pairs
 *   - ProWasteRate = (both pass AND Pro more expensive) / all pairs
 *   - FlashRescueCost = Cost(Flash failed) + Cost(Pro rescue) vs Cost(Pro initially)
 *   - Median, p90 latency/cost
 *   - Cache hit rate per run, cacheComparable flag per pair
 *
 * Token vocabulary:
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
import { calculateCost, lookupPricingAt, DEFAULT_PRICING_REGISTRY } from '@deepseek-ai/dsh-token-meter'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = join(__dirname, '..')

const MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'] as const
type Model = typeof MODELS[number]
type Policy = 'flash-only' | 'pro-only' | 'current-router'

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
  return {
    status: passed === criteria.length ? 'verified-pass' : 'verified-fail',
    criteriaPassed: passed,
    criteriaTotal: criteria.length,
    checks,
  }
}

// ---------------------------------------------------------------------------
// Task classes: 15 tasks across 8 categories
// ---------------------------------------------------------------------------

interface TaskClass {
  id: string
  category: string
  description: string
  task: string
  criteria: readonly VerificationCriterion[]
  /** Tasks where Pro is expected to outperform Flash. */
  expectsProAdvantage?: boolean
}

const TASK_CLASSES: readonly TaskClass[] = [
  // --- simple-factual ---
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
    id: 'capital-city',
    category: 'simple-factual',
    description: 'Capital city lookup',
    task: 'What is the capital of Australia? Reply with just the city name.',
    criteria: [
      { description: 'Contains Canberra', check: o => /canberra/i.test(o) },
      { description: 'Does not contain other city names', check: o => !/sydney|melbourne|perth|brisbane|adelaide/i.test(o) },
    ],
  },
  // --- factual-formatting ---
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
    id: 'list-formatting',
    category: 'factual-formatting',
    description: 'Formatted list output',
    task: 'List the first 5 prime numbers, one per line, with no other text.',
    criteria: [
      { description: 'Contains 2, 3, 5, 7, 11', check: o => /\b2\b/.test(o) && /\b3\b/.test(o) && /\b5\b/.test(o) && /\b7\b/.test(o) && /\b11\b/.test(o) },
      { description: 'Each on separate line or comma-separated', check: o => /\n|,/.test(o) },
      { description: 'Does not contain non-prime numbers', check: o => !/\b(1|4|6|8|9|10|12)\b/.test(o) },
    ],
  },
  // --- short-code-edit ---
  {
    id: 'code-edit',
    category: 'short-code-edit',
    description: 'Write a function to reverse a list',
    task: 'Write a TypeScript function called reverseList that takes an array and returns it reversed. Include the type signature. Do not use the built-in reverse method.',
    criteria: [
      { description: 'Declares function reverseList', check: o => /function\s+reverseList|reverseList\s*[:=]/i.test(o) },
      { description: 'Takes an array parameter', check: o => /\[|Array|array|T\[\]/i.test(o) },
      { description: 'Returns reversed array', check: o => /reverse|unshift|push|swap|backwards|back/i.test(o) },
      { description: 'Has TypeScript type annotation', check: o => /:\s*(T\[\]|Array|number\[\]|string\[\]|\w+\[\])/i.test(o) },
    ],
  },
  {
    id: 'code-bug-fix',
    category: 'short-code-edit',
    description: 'Fix a bug in a binary search',
    task: 'This binary search has a bug:\nfunction binarySearch(arr, target) {\n  let lo = 0, hi = arr.length\n  while (lo < hi) {\n    const mid = (lo + hi) / 2\n    if (arr[mid] === target) return mid\n    if (arr[mid] < target) lo = mid\n    else hi = mid\n  }\n  return -1\n}\n\nIdentify the bug and provide the corrected function. Explain the fix.',
    criteria: [
      { description: 'Identifies integer division bug (mid truncation)', check: o => /Math\.floor|truncat|integer.division|floor/i.test(o) },
      { description: 'Identifies lo = mid + 1 (not lo = mid)', check: o => /mid\s*\+\s*1|lo\s*=\s*mid\s*\+\s*1/i.test(o) },
      { description: 'Provides corrected function', check: o => /function\s+binarySearch/i.test(o) },
      { description: 'Corrected version uses Math.floor', check: o => /Math\.floor/i.test(o) },
    ],
    expectsProAdvantage: true,
  },
  // --- multi-step-reasoning ---
  {
    id: 'reasoning-proof',
    category: 'multi-step-reasoning',
    description: 'Prove sum of two odds is even',
    task: 'Think step by step. Prove that the sum of two odd integers is always even. Show your reasoning with algebraic notation.',
    criteria: [
      { description: 'Defines odd integer (2k+1 form)', check: o => /2k\s*\+\s*1|2n\s*\+\s*1|odd.*form/i.test(o) },
      { description: 'Shows addition of two odds', check: o => /\(\s*2k\s*\+\s*1\s*\)\s*\+\s*\(\s*2m\s*\+\s*1\s*\)|odd.*\+.*odd/i.test(o) },
      { description: 'Factors out 2 from result', check: o => /2\s*\*\s*\(?\s*k\s*\+\s*m\s*\+\s*1|2\s*\(/i.test(o) },
      { description: 'Concludes result is even', check: o => /even|divisible.by.2|multiple.of.2/i.test(o) },
    ],
    expectsProAdvantage: true,
  },
  {
    id: 'logic-puzzle',
    category: 'multi-step-reasoning',
    description: 'Logic puzzle: who is the tallest?',
    task: 'Three people - Alice, Bob, and Carol - are standing in a line. Alice is taller than Bob. Carol is shorter than Bob. Who is the tallest? Explain your reasoning step by step.',
    criteria: [
      { description: 'Correctly identifies Alice as tallest', check: o => /alice/i.test(o) && /tallest|taller/i.test(o) },
      { description: 'Shows reasoning chain (Alice > Bob > Carol)', check: o => /alice.*bob.*carol|alice.*>.*bob.*>.*carol/i.test(o) || (o.includes('Alice') && o.includes('Bob') && o.includes('Carol')) },
      { description: 'Does not incorrectly identify Bob or Carol', check: o => !/bob.is.the.tallest/i.test(o) && !/carol.is.the.tallest/i.test(o) },
    ],
    expectsProAdvantage: true,
  },
  // --- debugging ---
  {
    id: 'debug-off-by-one',
    category: 'debugging',
    description: 'Debug an off-by-one error',
    task: 'This function should sum numbers from 1 to n inclusive, but it returns the wrong answer for n=5 (gives 10 instead of 15):\nfunction sumTo(n) {\n  let total = 0\n  for (let i = 1; i < n; i++) total += i\n  return total\n}\n\nWhat is the bug? Provide the corrected function.',
    criteria: [
      { description: 'Identifies loop condition (i < n should be i <= n)', check: o => /i\s*<=\s*n|i\s*<\s*=\s*n|less.than.or.equal|inclusive/i.test(o) },
      { description: 'Provides corrected function', check: o => /function\s+sumTo/i.test(o) },
      { description: 'Corrected loop uses <=', check: o => /i\s*<=\s*n/i.test(o) },
      { description: 'Explains the off-by-one error', check: o => /off.by.one|off-by-one|exclusive|inclusive|misses.the.last/i.test(o) },
    ],
  },
  // --- structured-transformation ---
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
  {
    id: 'yaml-to-json',
    category: 'structured-transformation',
    description: 'Convert YAML to JSON',
    task: 'Convert this YAML to a JSON object:\nname: Test\nversion: 3\nenabled: true\n\nReply with only the JSON.',
    criteria: [
      { description: 'Contains valid JSON object', check: o => /^\s*\{/.test(o.trim()) && /\}\s*$/.test(o.trim()) },
      { description: 'Has name: Test', check: o => /["']name["']\s*:\s*["']Test["']/i.test(o) },
      { description: 'Has version: 3', check: o => /["']version["']\s*:\s*3/.test(o) },
      { description: 'Has enabled: true', check: o => /["']enabled["']\s*:\s*true/i.test(o) },
    ],
  },
  // --- planning ---
  {
    id: 'plan-feature',
    category: 'planning',
    description: 'Plan a feature implementation',
    task: 'Plan the implementation of a user authentication system with login, logout, and session management. List the steps in order. Keep it to 5-7 steps.',
    criteria: [
      { description: 'Mentions login', check: o => /login|sign.in|authenticate/i.test(o) },
      { description: 'Mentions logout', check: o => /logout|sign.out/i.test(o) },
      { description: 'Mentions session management', check: o => /session|token|cookie|jwt/i.test(o) },
      { description: 'Has 5-7 numbered or bulleted steps', check: (o) => { const steps = (o.match(/^\s*(\d+\.|[-*•])/gm) ?? []).length; return steps >= 5 && steps <= 8 } },
    ],
  },
  // --- verification-heavy ---
  {
    id: 'verify-algorithm',
    category: 'verification-heavy',
    description: 'Verify correctness of a sorting algorithm',
    task: 'Is this a correct implementation of bubble sort? If not, identify the error:\nfunction bubbleSort(arr) {\n  for (let i = 0; i < arr.length; i++) {\n    for (let j = 0; j < arr.length - 1; j++) {\n      if (arr[j] > arr[j + 1]) {\n        [arr[j], arr[j + 1]] = [arr[j + 1], arr[j]]\n      }\n    }\n  }\n  return arr\n}\n\nExplain your answer.',
    criteria: [
      { description: 'States it is correct', check: o => /correct|works|valid/i.test(o) },
      { description: 'Explains why (compares adjacent pairs)', check: o => /adjacent|compare|swap|pair/i.test(o) },
      { description: 'Mentions it could be optimized', check: o => /optim|efficient|n\^2|O\(|quadratic|improve/i.test(o) },
    ],
  },
  // --- long-context-analysis ---
  {
    id: 'long-context-summary',
    category: 'long-context-analysis',
    description: 'Summarize a long text passage',
    task: 'Read the following text and summarize it in exactly 2 sentences:\n\nThe waterfall model is a sequential design process in which progress is seen as flowing steadily downwards through the phases of conception, initiation, analysis, design, construction, testing, production, and implementation. The waterfall model is a traditional engineering approach that was first described in 1970 by Winston W. Royce, although Royce did not use the term waterfall in that article. The waterfall model prescribes a systematic, sequential approach to software development, which begins with customer specification of requirements and progresses through planning, modeling, construction, and deployment, culminating in ongoing support of the completed software. The key characteristic of the waterfall model is that each phase must be completed before the next phase begins, and there is no overlapping of phases. The rigid structure of the waterfall model makes it difficult to accommodate changes once a phase is completed, which has led to criticism of the model in favor of more flexible approaches such as agile development.',
    criteria: [
      { description: 'Mentions waterfall model', check: o => /waterfall/i.test(o) },
      { description: 'Mentions sequential or phases', check: o => /sequential|phase|linear|step/i.test(o) },
      { description: 'Has exactly 2 sentences', check: (o) => { const count = (o.match(/[.!?]+/g) ?? []).length; return count >= 2 && count <= 3 } },
      { description: 'Does not copy text verbatim', check: o => o.length < 500 },
    ],
  },
  // --- tool-heavy (simulated) ---
  {
    id: 'multi-step-calculation',
    category: 'tool-heavy',
    description: 'Multi-step calculation requiring intermediate results',
    task: 'Calculate the total cost of a shopping cart: 3 apples at $0.50 each, 2 bananas at $0.30 each, and 1 loaf of bread at $2.50. Apply a 10% discount. Show each step. What is the final total?',
    criteria: [
      { description: 'Calculates apple cost ($1.50)', check: o => /1\.50|1\.5\b/i.test(o) },
      { description: 'Calculates banana cost ($0.60)', check: o => /0\.60|0\.6\b/i.test(o) },
      { description: 'Calculates subtotal ($4.60)', check: o => /4\.60|4\.6\b/i.test(o) },
      { description: 'Applies 10% discount and gets $4.14', check: o => /4\.14/i.test(o) },
    ],
  },
]

// ---------------------------------------------------------------------------
// Benchmark run record
// ---------------------------------------------------------------------------

type CacheState = 'cold' | 'warm'

interface BenchmarkRun {
  taskId: string
  category: string
  policy: Policy
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
  iteration: number
  cacheState: CacheState
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

interface PolicySummary {
  policy: Policy
  runs: number
  verifiedPasses: number
  verifiedRate: number
  totalCost: number
  meanCostPerTask: number
  medianCostPerTask: number
  p90CostPerTask: number
  costPerVerifiedTask: number
  meanLatency: number
  medianLatency: number
  p90Latency: number
  repairRate: number
  toolFailureRate: number
  reasoningTokensPerTask: number
  cacheHitRate: number
  proUtilization: number
}

// ---------------------------------------------------------------------------
// Config generation
// ---------------------------------------------------------------------------

async function generateDirectConfig(model: Model, workDir: string): Promise<string> {
  const basePath = join(REPO_ROOT, 'examples', 'headless-agent', 'cordis.yml')
  let base = await readFile(basePath, 'utf8')
  base = base.replace(/model: deepseek-v4-flash/, `model: ${model}`)
  base = base.replace(/compression: !!js "process.env.DSH_SNAPSHOT === undefined \? 'zstd' : 'none'"/, "compression: 'none'")
  const configPath = join(workDir, 'cordis.yml')
  await writeFile(configPath, base, 'utf8')
  return configPath
}

async function generateRouterConfig(workDir: string): Promise<string> {
  const basePath = join(REPO_ROOT, 'examples', 'headless-agent', 'cordis.yml')
  let base = await readFile(basePath, 'utf8')
  base = base.replace(/reasoningEffort: max/, 'reasoningEffort: high')
  const routerEntry = `- id: llm-model-router
  name: '@deepseek-ai/dsh-llm-model-router'
  config:
    fastRoute:
      provider: deepseek-official
      model: deepseek-v4-flash
    heavyRoute:
      provider: deepseek-official
      model: deepseek-v4-pro
      reasoningEffort: high
    escalationThreshold: 4
    recordAllDecisions: true

`
  base = base.replace(/(# Managed child-process groups)/, `${routerEntry}$1`)
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
  selectedModel?: string
} {
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheMissTokens = 0, reasoningTokens = 0, totalTokens = 0
  let output = ''
  let toolCalls = 0
  let toolFailures = 0
  let routingDecisionId: string | undefined
  let selectedModel: string | undefined

  for (const event of events) {
    if (event.type === 'model/usage') {
      const data = event.data as unknown as { usage: Record<string, number>; routingDecisionId?: string }
      const u = data.usage
      inputTokens += u.inputTokens ?? 0
      outputTokens += u.outputTokens ?? 0
      cacheReadTokens += u.cacheReadTokens ?? 0
      cacheMissTokens += u.cacheMissTokens ?? 0
      reasoningTokens += u.reasoningTokens ?? 0
      totalTokens += u.totalTokens ?? 0
      if (data.routingDecisionId !== undefined) routingDecisionId = data.routingDecisionId
    }
    if (event.type === 'model/routing-decision') {
      const data = event.data as { selected: { model: string } }
      selectedModel = data.selected.model
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
    ...selectedModel !== undefined ? { selectedModel } : {},
  }
}

// ---------------------------------------------------------------------------
// Run execution
// ---------------------------------------------------------------------------

async function runBenchmarkIteration(
  taskClass: TaskClass,
  policy: Policy,
  iteration: number,
  cacheState: CacheState,
  workDir: string,
): Promise<BenchmarkRun> {
  const model: Model = policy === 'flash-only' ? 'deepseek-v4-flash' : policy === 'pro-only' ? 'deepseek-v4-pro' : 'deepseek-v4-flash'
  const configPath = policy === 'current-router'
    ? await generateRouterConfig(workDir)
    : await generateDirectConfig(model, workDir)

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
    // For router policy, determine actual model from events
    const actualModel: Model = policy === 'current-router'
      ? (extracted.selectedModel === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-v4-flash')
      : model

    const pricing = lookupPricingAt(DEFAULT_PRICING_REGISTRY, 'deepseek-official', actualModel, new Date(start))
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
    const total = extracted.cacheReadTokens + extracted.cacheMissTokens
    const hitRate = total > 0 ? extracted.cacheReadTokens / total : 0

    return {
      taskId: taskClass.id,
      category: taskClass.category,
      policy,
      model: actualModel,
      iteration,
      cacheState,
      ...extracted.routingDecisionId !== undefined ? { routingDecisionId: extracted.routingDecisionId } : {},
      cache: { hitTokens: extracted.cacheReadTokens, missTokens: extracted.cacheMissTokens, hitRate },
      usage: {
        inputTokens: extracted.inputTokens,
        outputTokens: extracted.outputTokens,
        reasoningTokens: extracted.reasoningTokens,
        totalTokens: extracted.totalTokens,
      },
      economics: { costUsd, pricingVersion },
      execution: { latencyMs, attempts: 1, toolCalls: extracted.toolCalls, toolFailures: extracted.toolFailures, repairs: 0 },
      verification: verificationResult,
      output: extracted.output,
    }
  } catch (error: unknown) {
    return {
      taskId: taskClass.id,
      category: taskClass.category,
      policy,
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
  if (pro.economics.costUsd > flash.economics.costUsd) return 'both-pass-pro-more-expensive'
  if (flash.economics.costUsd > pro.economics.costUsd) return 'pro-better'
  return 'both-pass-pro-more-expensive'
}

function cacheComparable(flash: BenchmarkRun, pro: BenchmarkRun): boolean {
  return Math.abs(flash.cache.hitRate - pro.cache.hitRate) <= 0.10
}

// ---------------------------------------------------------------------------
// Policy summary
// ---------------------------------------------------------------------------

function summarizePolicy(policy: Policy, runs: BenchmarkRun[]): PolicySummary {
  const valid = runs.filter(r => r.error === undefined)
  const verified = valid.filter(r => r.verification.status === 'verified-pass')
  const costs = valid.map(r => r.economics.costUsd)
  const latencies = valid.map(r => r.execution.latencyMs)
  const totalCost = costs.reduce((a, b) => a + b, 0)
  const proRuns = valid.filter(r => r.model === 'deepseek-v4-pro').length

  return {
    policy,
    runs: valid.length,
    verifiedPasses: verified.length,
    verifiedRate: valid.length > 0 ? verified.length / valid.length : 0,
    totalCost,
    meanCostPerTask: avg(costs),
    medianCostPerTask: median(costs),
    p90CostPerTask: p90(costs),
    costPerVerifiedTask: verified.length > 0 ? totalCost / verified.length : Infinity,
    meanLatency: avg(latencies),
    medianLatency: median(latencies),
    p90Latency: p90(latencies),
    repairRate: valid.length > 0 ? valid.reduce((a, r) => a + r.execution.repairs, 0) / valid.length : 0,
    toolFailureRate: valid.length > 0 ? valid.reduce((a, r) => a + r.execution.toolFailures, 0) / valid.length : 0,
    reasoningTokensPerTask: avg(valid.map(r => r.usage.reasoningTokens)),
    cacheHitRate: avg(valid.map(r => r.cache.hitRate)),
    proUtilization: valid.length > 0 ? proRuns / valid.length : 0,
  }
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

function formatReport(runs: BenchmarkRun[], pairs: FlashProPair[], policies: PolicySummary[]): string {
  const lines: string[] = []
  lines.push('# v0.16.0-rc1 Expanded Paired Benchmark')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')
  lines.push('## Design')
  lines.push('')
  lines.push('- 15 task classes across 8 categories (factual, code, reasoning, debugging, structured, planning, verification, long-context).')
  lines.push('- Three policies: Flash-only, Pro-only, current-router.')
  lines.push('- Cold/warm separation: cold runs use fresh contexts, warm runs after warm-up.')
  lines.push('- Structured verification criteria per task (same status vocabulary as RoutingOutcome).')
  lines.push('- Per-run cache hit/miss/rate; cacheComparable flag when >10pp difference.')
  lines.push('- Core metric: CostPerVerifiedTask = TotalCost / VerifiedPasses.')
  lines.push('- ProNecessityRate, ProWasteRate, FlashRescueCost.')
  lines.push('- Median and p90 latency/cost alongside arithmetic means.')
  lines.push('')

  // Three-policy comparison table
  lines.push('## Three-policy comparison')
  lines.push('────────────────────────────')
  lines.push('')
  lines.push('| Policy | Verified pass | Cost/task | Cost/verified | Median latency | Repairs/task | Pro util |')
  lines.push('|---|---:|---:|---:|---:|---:|---:|')
  for (const p of policies) {
    const cpt = p.costPerVerifiedTask === Infinity ? 'N/A' : `$${p.costPerVerifiedTask.toFixed(6)}`
    lines.push(`| ${p.policy} | ${(p.verifiedRate * 100).toFixed(1)}% | $${p.meanCostPerTask.toFixed(6)} | ${cpt} | ${p.medianLatency}ms | ${p.repairRate.toFixed(2)} | ${(p.proUtilization * 100).toFixed(0)}% |`)
  }
  lines.push('')

  // Detailed policy stats
  lines.push('## Detailed policy statistics')
  lines.push('────────────────────────────')
  lines.push('')
  for (const p of policies) {
    lines.push(`### ${p.policy}`)
    lines.push(`  Runs:                  ${p.runs}`)
    lines.push(`  Verified passes:       ${p.verifiedPasses}/${p.runs} (${(p.verifiedRate * 100).toFixed(1)}%)`)
    lines.push(`  Total cost:            $${p.totalCost.toFixed(6)}`)
    lines.push(`  Mean cost/task:        $${p.meanCostPerTask.toFixed(6)}`)
    lines.push(`  Median cost/task:      $${p.medianCostPerTask.toFixed(6)}`)
    lines.push(`  p90 cost/task:         $${p.p90CostPerTask.toFixed(6)}`)
    const cpt = p.costPerVerifiedTask === Infinity ? 'N/A (no passes)' : `$${p.costPerVerifiedTask.toFixed(6)}`
    lines.push(`  CostPerVerifiedTask:   ${cpt}`)
    lines.push(`  Mean latency:          ${p.meanLatency.toFixed(0)}ms`)
    lines.push(`  Median latency:        ${p.medianLatency}ms`)
    lines.push(`  p90 latency:           ${p.p90Latency}ms`)
    lines.push(`  Repair rate:           ${p.repairRate.toFixed(2)}/task`)
    lines.push(`  Tool failure rate:     ${p.toolFailureRate.toFixed(2)}/task`)
    lines.push(`  Reasoning tokens/task: ${p.reasoningTokensPerTask.toFixed(0)}`)
    lines.push(`  Cache hit rate:        ${(p.cacheHitRate * 100).toFixed(1)}%`)
    lines.push(`  Pro utilization:       ${(p.proUtilization * 100).toFixed(0)}%`)
    lines.push('')
  }

  // Per-task-class comparison
  lines.push('## Per-task-class comparison')
  lines.push('')
  lines.push('| Task | Category | Expects Pro | Flash verified | Pro verified | Router verified | Flash cost | Pro cost | Router cost |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const taskClass of TASK_CLASSES) {
    const flashRuns = runs.filter(r => r.taskId === taskClass.id && r.policy === 'flash-only' && r.error === undefined)
    const proRuns = runs.filter(r => r.taskId === taskClass.id && r.policy === 'pro-only' && r.error === undefined)
    const routerRuns = runs.filter(r => r.taskId === taskClass.id && r.policy === 'current-router' && r.error === undefined)
    const fV = flashRuns.filter(r => r.verification.status === 'verified-pass').length
    const pV = proRuns.filter(r => r.verification.status === 'verified-pass').length
    const rV = routerRuns.filter(r => r.verification.status === 'verified-pass').length
    const fC = avg(flashRuns.map(r => r.economics.costUsd))
    const pC = avg(proRuns.map(r => r.economics.costUsd))
    const rC = avg(routerRuns.map(r => r.economics.costUsd))
    lines.push(`| ${taskClass.id} | ${taskClass.category} | ${taskClass.expectsProAdvantage ? 'yes' : 'no'} | ${fV}/${flashRuns.length} | ${pV}/${proRuns.length} | ${rV}/${routerRuns.length} | $${fC.toFixed(6)} | $${pC.toFixed(6)} | $${rC.toFixed(6)} |`)
  }
  lines.push('')

  // Pair classification
  lines.push('## Pair classification (Flash vs Pro)')
  lines.push('────────────────────────────')
  lines.push('')
  const classCounts: Record<string, number> = {}
  for (const pair of pairs) classCounts[pair.classification] = (classCounts[pair.classification] ?? 0) + 1
  const totalPairs = pairs.length
  lines.push('| Class | Count | % |')
  lines.push('|---|---:|---:|')
  for (const cls of ['flash-sufficient', 'pro-necessary', 'both-pass-pro-more-expensive', 'both-fail', 'flash-better', 'pro-better']) {
    const count = classCounts[cls] ?? 0
    lines.push(`| ${cls} | ${count} | ${totalPairs > 0 ? ((count / totalPairs) * 100).toFixed(1) : 0}% |`)
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

  // FlashRescueCost
  lines.push('## FlashRescueCost analysis')
  lines.push('────────────────────────────')
  lines.push('')
  const rescuePairs = pairs.filter(p => p.classification === 'pro-necessary')
  if (rescuePairs.length > 0) {
    let totalRescueCost = 0
    let totalProOnlyCost = 0
    for (const pair of rescuePairs) {
      const rescueCost = pair.flash.economics.costUsd + pair.pro.economics.costUsd
      const proOnlyCost = pair.pro.economics.costUsd
      totalRescueCost += rescueCost
      totalProOnlyCost += proOnlyCost
      lines.push(`  ${pair.taskId}: Flash($${pair.flash.economics.costUsd.toFixed(6)}) + Pro rescue($${pair.pro.economics.costUsd.toFixed(6)}) = $${rescueCost.toFixed(6)} vs Pro initially($${proOnlyCost.toFixed(6)})`)
    }
    lines.push('')
    lines.push(`  Total rescue cost:   $${totalRescueCost.toFixed(6)}`)
    lines.push(`  Total Pro-only cost: $${totalProOnlyCost.toFixed(6)}`)
    lines.push(`  Rescue overhead:     $${(totalRescueCost - totalProOnlyCost).toFixed(6)} (${rescuePairs.length} tasks)`)
    lines.push(`  Avg rescue overhead per task: $${((totalRescueCost - totalProOnlyCost) / rescuePairs.length).toFixed(6)}`)
  } else {
    lines.push('  No pro-necessary pairs found.')
  }
  lines.push('')

  // Router decision analysis
  const routerRuns = runs.filter(r => r.policy === 'current-router' && r.error === undefined)
  if (routerRuns.length > 0) {
    lines.push('## Router decision analysis')
    lines.push('────────────────────────────')
    lines.push('')
    const routerFlash = routerRuns.filter(r => r.model === 'deepseek-v4-flash').length
    const routerPro = routerRuns.filter(r => r.model === 'deepseek-v4-pro').length
    lines.push(`Router selected Flash: ${routerFlash}/${routerRuns.length} (${((routerFlash / routerRuns.length) * 100).toFixed(1)}%)`)
    lines.push(`Router selected Pro:   ${routerPro}/${routerRuns.length} (${((routerPro / routerRuns.length) * 100).toFixed(1)}%)`)
    lines.push('')

    // Router vs expected
    lines.push('| Task | Expected Pro | Router selected | Router verified | Router cost |')
    lines.push('|---|---|---|---|---|')
    for (const taskClass of TASK_CLASSES) {
      const rr = routerRuns.filter(r => r.taskId === taskClass.id)
      if (rr.length === 0) continue
      const selected = rr[0]?.model ?? 'unknown'
      const verified = rr.filter(r => r.verification.status === 'verified-pass').length
      const cost = avg(rr.map(r => r.economics.costUsd))
      lines.push(`| ${taskClass.id} | ${taskClass.expectsProAdvantage ? 'yes' : 'no'} | ${selected} | ${verified}/${rr.length} | $${cost.toFixed(6)} |`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Main: three-policy execution with cold/warm separation
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const hasKey = Boolean(process.env.DEEPSEEK_API_KEY)
  if (!hasKey) {
    process.stderr.write('DEEPSEEK_API_KEY is required for benchmark\n')
    process.exit(1)
  }

  const workRoot = await mkdtemp(join(tmpdir(), 'rc1-bench-'))
  process.stderr.write(`Benchmark work directory: ${workRoot}\n`)

  const ITERATIONS = 2 // 1 cold + 1 warm
  const runs: BenchmarkRun[] = []
  const POLICIES: Policy[] = ['flash-only', 'pro-only', 'current-router']

  // Phase 1: warm-up (excluded from scored economics)
  process.stderr.write('\nPhase 1: Warming cache for both models...\n')
  for (const model of MODELS) {
    const dir = join(workRoot, `warm-${model}`)
    await mkdir(dir, { recursive: true })
    process.stderr.write(`  Warming ${model}...\n`)
    const warmTask = TASK_CLASSES[0]
    if (warmTask === undefined) throw new Error('No task classes')
    const warmRun = await runBenchmarkIteration(warmTask, 'flash-only', 0, 'warm', dir)
    if (warmRun.error !== undefined) process.stderr.write(`  Warm FAILED: ${warmRun.error}\n`)
    else process.stderr.write(`  Warm OK: cacheHit=${warmRun.cache.hitTokens} cacheMiss=${warmRun.cache.missTokens}\n`)
  }

  // Phase 2: cold runs (fresh context per task)
  process.stderr.write('\nPhase 2: Cold runs (all policies)...\n')
  for (const taskClass of TASK_CLASSES) {
    for (const policy of POLICIES) {
      process.stderr.write(`  Cold: ${policy} / ${taskClass.id}...\n`)
      const dir = join(workRoot, `cold-${policy}-${taskClass.id}`)
      await mkdir(dir, { recursive: true })
      const run = await runBenchmarkIteration(taskClass, policy, 1, 'cold', dir)
      runs.push(run)
      logRun(run)
    }
  }

  // Phase 3: warm runs (after cold, cache should be populated)
  process.stderr.write('\nPhase 3: Warm runs (all policies)...\n')
  for (const taskClass of TASK_CLASSES) {
    for (const policy of POLICIES) {
      process.stderr.write(`  Warm: ${policy} / ${taskClass.id}...\n`)
      const dir = join(workRoot, `warm-${policy}-${taskClass.id}`)
      await mkdir(dir, { recursive: true })
      const run = await runBenchmarkIteration(taskClass, policy, 2, 'warm', dir)
      runs.push(run)
      logRun(run)
    }
  }

  // Build pairs (Flash-only vs Pro-only, per task and iteration)
  const pairs: FlashProPair[] = []
  for (const taskClass of TASK_CLASSES) {
    for (let i = 1; i <= ITERATIONS; i++) {
      const flash = runs.find(r => r.policy === 'flash-only' && r.taskId === taskClass.id && r.iteration === i)
      const pro = runs.find(r => r.policy === 'pro-only' && r.taskId === taskClass.id && r.iteration === i)
      if (flash !== undefined && pro !== undefined) {
        pairs.push({
          taskId: `${taskClass.id}/${i}`,
          iteration: i,
          cacheState: flash.cacheState,
          flash,
          pro,
          classification: classifyPair(flash, pro),
          cacheComparable: cacheComparable(flash, pro),
        })
      }
    }
  }

  // Policy summaries
  const policies = POLICIES.map(p => summarizePolicy(p, runs.filter(r => r.policy === p)))

  // Generate reports
  const reportDir = join(REPO_ROOT, 'artifacts', 'reports')
  await writeFile(join(reportDir, 'v0.16.0-rc1-paired-benchmark.json'), JSON.stringify({
    release: 'v0.16.0-rc.1',
    generatedAt: new Date().toISOString(),
    design: {
      taskClasses: TASK_CLASSES.map(t => ({
        id: t.id, category: t.category, description: t.description,
        expectsProAdvantage: t.expectsProAdvantage ?? false,
        criteriaCount: t.criteria.length,
      })),
      iterations: ITERATIONS,
      policies: POLICIES,
      cacheControl: 'cold-then-warm-per-task',
      verification: 'structured criteria (same status vocabulary as RoutingOutcome)',
      coreMetric: 'CostPerVerifiedTask = TotalCost / VerifiedPasses',
    },
    runs,
    pairs,
    policies,
  }, null, 2), 'utf8')
  await writeFile(join(reportDir, 'v0.16.0-rc1-paired-benchmark.md'), formatReport(runs, pairs, policies), 'utf8')

  process.stderr.write('\nBenchmark reports written to artifacts/reports/\n')
  await rm(workRoot, { recursive: true, force: true })

  const failures = runs.filter(r => r.error !== undefined)
  if (failures.length > 0) process.stderr.write(`${failures.length} run(s) failed\n`)
}

function logRun(run: BenchmarkRun): void {
  if (run.error !== undefined) {
    process.stderr.write(`    FAILED: ${run.error}\n`)
  } else {
    const hitRatePct = (run.cache.hitRate * 100).toFixed(1)
    process.stderr.write(`    OK: ${run.verification.status} (${run.verification.criteriaPassed}/${run.verification.criteriaTotal}) model=${run.model} cost=$${run.economics.costUsd.toFixed(6)} latency=${run.execution.latencyMs}ms hitRate=${hitRatePct}%\n`)
  }
}

void main()
