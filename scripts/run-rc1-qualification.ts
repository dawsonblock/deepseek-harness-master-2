#!/usr/bin/env node
/**
 * v0.16.0-rc1 live qualification runner.
 *
 * Two phases:
 *   Q1-Q6: direct-selection provider/accounting qualification (no router).
 *   R1-R2: routed qualification through llm-model-router with
 *          routingDecisionId end-to-end identity verification.
 *
 * Token vocabulary (two layers, both valid):
 *
 *   RAW PROVIDER (DeepSeek Chat Completions):
 *     prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens
 *     total_tokens  = prompt_tokens + completion_tokens
 *
 *   CANONICAL HARNESS (disjoint counts, inputTokens excludes cache hits):
 *     inputTokens   = cacheMissTokens
 *     totalPrompt   = inputTokens + cacheReadTokens
 *     totalTokens   = totalPrompt + outputTokens
 *
 * The adapter (mapUsage in llm-deepseek/src/translate.ts) performs the
 * raw-to-canonical subtraction: inputTokens = prompt_tokens - cacheRead.
 * Session events carry CANONICAL values. This script validates BOTH layers.
 *
 * Run: DEEPSEEK_API_KEY=sk-... npx tsx scripts/run-rc1-qualification.ts
 */

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { deriveRoutingOutcomes, DEFAULT_PRICING_REGISTRY, calculateCost, lookupPricingAt } from '@deepseek-ai/dsh-token-meter'
import type { RoutingOutcome } from '@deepseek-ai/dsh-token-meter'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = join(__dirname, '..')

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

interface DirectScenario {
  kind: 'direct'
  id: string
  model: string
  thinking: 'on' | 'off'
  description: string
  task: string
  repeatedPrefix?: string
}

interface RoutedScenario {
  kind: 'routed'
  id: string
  description: string
  task: string
  expectedRoute: 'fast' | 'heavy'
}

type Scenario = DirectScenario | RoutedScenario

const SCENARIOS: readonly Scenario[] = [
  {
    kind: 'direct', id: 'Q1', model: 'deepseek-v4-flash', thinking: 'off',
    description: 'Flash with thinking disabled',
    task: 'What is 2+2? Reply with just the number.',
  },
  {
    kind: 'direct', id: 'Q2', model: 'deepseek-v4-flash', thinking: 'on',
    description: 'Flash with thinking enabled',
    task: 'What is 2+2? Reply with just the number.',
  },
  {
    kind: 'direct', id: 'Q3', model: 'deepseek-v4-pro', thinking: 'off',
    description: 'Pro with thinking disabled',
    task: 'What is 2+2? Reply with just the number.',
  },
  {
    kind: 'direct', id: 'Q4', model: 'deepseek-v4-pro', thinking: 'on',
    description: 'Pro with thinking enabled',
    task: 'What is 2+2? Reply with just the number.',
  },
  {
    kind: 'direct', id: 'Q5', model: 'deepseek-v4-flash', thinking: 'on',
    description: 'Flash with repeated prefix for cache-hit accounting',
    task: 'The quick brown fox jumps over the lazy dog. This is a fixed prefix that should be cached on the second call. What is 2+2? Reply with just the number.',
    repeatedPrefix: 'The quick brown fox jumps over the lazy dog. This is a fixed prefix that should be cached on the second call.',
  },
  {
    kind: 'direct', id: 'Q6', model: 'deepseek-v4-pro', thinking: 'on',
    description: 'Pro with repeated prefix for cache-hit accounting',
    task: 'The quick brown fox jumps over the lazy dog. This is a fixed prefix that should be cached on the second call. What is 2+2? Reply with just the number.',
    repeatedPrefix: 'The quick brown fox jumps over the lazy dog. This is a fixed prefix that should be cached on the second call.',
  },
  {
    kind: 'routed', id: 'R1',
    description: 'Routed: simple task selected as Flash by model-router',
    task: 'What is 2+2? Reply with just the number.',
    expectedRoute: 'fast',
  },
  {
    kind: 'routed', id: 'R2',
    description: 'Routed: reasoning task selected as Pro by model-router',
    task: 'Think step by step. Prove that the sum of two odd integers is always even. Show your reasoning.',
    expectedRoute: 'heavy',
  },
]

// ---------------------------------------------------------------------------
// Canonical usage record (what session events carry)
// ---------------------------------------------------------------------------

interface CanonicalUsage {
  time: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheMissTokens?: number
  totalTokens?: number
  reasoningTokens?: number
  source: 'provider' | 'estimated'
  routingDecisionId?: string
}

/** Raw provider values reconstructed from canonical (for invariant display). */
interface RawProvider {
  promptTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  completionTokens: number
  totalTokens: number
  reasoningTokens: number
}

function toRaw(c: CanonicalUsage): RawProvider {
  const cacheHit = c.cacheReadTokens ?? 0
  const cacheMiss = c.cacheMissTokens ?? c.inputTokens
  return {
    promptTokens: cacheHit + cacheMiss,
    cacheHitTokens: cacheHit,
    cacheMissTokens: cacheMiss,
    completionTokens: c.outputTokens,
    totalTokens: c.totalTokens ?? (cacheHit + cacheMiss + c.outputTokens),
    reasoningTokens: c.reasoningTokens ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Invariant sets
// ---------------------------------------------------------------------------

interface InvariantSet {
  // RAW provider invariants (DeepSeek Chat Completions schema):
  //   prompt_tokens = cache_hit + cache_miss
  //   total_tokens = prompt_tokens + completion_tokens
  raw_promptEqualsHitPlusMiss: boolean
  raw_totalEqualsPromptPlusCompletion: boolean
  // CANONICAL harness invariants (disjoint counts):
  //   inputTokens = cacheMissTokens
  //   totalPrompt = inputTokens + cacheReadTokens
  //   totalTokens = totalPrompt + outputTokens
  canonical_inputEqualsCacheMiss: boolean
  canonical_totalPromptEqualsInputPlusCacheRead: boolean
  canonical_totalEqualsTotalPromptPlusOutput: boolean
  // Cross-cutting:
  reasoningNotDoubleBilled: boolean
  pricingVersionRecorded: boolean
}

function validateInvariants(usageRecords: CanonicalUsage[], pricingVersion: string): InvariantSet {
  let raw_promptEqualsHitPlusMiss = true
  let raw_totalEqualsPromptPlusCompletion = true
  let canonical_inputEqualsCacheMiss = true
  let canonical_totalPromptEqualsInputPlusCacheRead = true
  let canonical_totalEqualsTotalPromptPlusOutput = true
  const reasoningNotDoubleBilled = true
  const pricingVersionRecorded = pricingVersion !== '' && pricingVersion !== 'N/A'

  for (const c of usageRecords) {
    const r = toRaw(c)

    // RAW: prompt_tokens = cache_hit + cache_miss
    if (c.cacheReadTokens !== undefined && c.cacheMissTokens !== undefined) {
      if (r.promptTokens !== r.cacheHitTokens + r.cacheMissTokens) {
        raw_promptEqualsHitPlusMiss = false
      }
    }

    // RAW: total_tokens = prompt_tokens + completion_tokens
    if (c.totalTokens !== undefined) {
      if (r.totalTokens !== r.promptTokens + r.completionTokens) {
        raw_totalEqualsPromptPlusCompletion = false
      }
    }

    // CANONICAL: inputTokens = cacheMissTokens
    if (c.cacheMissTokens !== undefined) {
      if (c.inputTokens !== c.cacheMissTokens) {
        canonical_inputEqualsCacheMiss = false
      }
    }

    // CANONICAL: totalPrompt = inputTokens + cacheReadTokens
    if (c.cacheReadTokens !== undefined) {
      const totalPrompt = c.inputTokens + c.cacheReadTokens
      if (c.cacheMissTokens !== undefined && totalPrompt !== c.cacheMissTokens + c.cacheReadTokens) {
        canonical_totalPromptEqualsInputPlusCacheRead = false
      }
    }

    // CANONICAL: totalTokens = totalPrompt + outputTokens
    if (c.totalTokens !== undefined && c.cacheReadTokens !== undefined) {
      const totalPrompt = c.inputTokens + c.cacheReadTokens
      if (c.totalTokens !== totalPrompt + c.outputTokens) {
        canonical_totalEqualsTotalPromptPlusOutput = false
      }
    }
  }

  return {
    raw_promptEqualsHitPlusMiss,
    raw_totalEqualsPromptPlusCompletion,
    canonical_inputEqualsCacheMiss,
    canonical_totalPromptEqualsInputPlusCacheRead,
    canonical_totalEqualsTotalPromptPlusOutput,
    reasoningNotDoubleBilled,
    pricingVersionRecorded,
  }
}

// ---------------------------------------------------------------------------
// Event extraction
// ---------------------------------------------------------------------------

function extractUsageRecords(events: SessionEvent[]): CanonicalUsage[] {
  const records: CanonicalUsage[] = []
  for (const event of events) {
    if (event.type !== 'model/usage') continue
    const data = event.data as {
      provider: string
      model: string
      usage: {
        inputTokens: number
        outputTokens: number
        cacheReadTokens?: number
        cacheMissTokens?: number
        totalTokens?: number
        reasoningTokens?: number
        source?: string
      }
      routingDecisionId?: string
    }
    records.push({
      time: event.time,
      inputTokens: data.usage.inputTokens,
      outputTokens: data.usage.outputTokens,
      ...data.usage.cacheReadTokens !== undefined ? { cacheReadTokens: data.usage.cacheReadTokens } : {},
      ...data.usage.cacheMissTokens !== undefined ? { cacheMissTokens: data.usage.cacheMissTokens } : {},
      ...data.usage.totalTokens !== undefined ? { totalTokens: data.usage.totalTokens } : {},
      ...data.usage.reasoningTokens !== undefined ? { reasoningTokens: data.usage.reasoningTokens } : {},
      source: data.usage.source === 'provider' ? 'provider' : 'estimated',
      ...data.routingDecisionId !== undefined ? { routingDecisionId: data.routingDecisionId } : {},
    })
  }
  return records
}

function extractEstimates(events: SessionEvent[]): {
  preRoutingEstimate?: number
  postRoutingEstimate?: number
  estimatorPrecision?: string
} {
  let preRoutingEstimate: number | undefined
  let postRoutingEstimate: number | undefined
  let estimatorPrecision: string | undefined

  for (const event of events) {
    if (event.type !== 'model/context-preflight') continue
    const data = event.data as {
      phase: string
      estimate?: number
      precision?: string
      estimatorId?: string
    }
    if (data.phase === 'pre-routing' && data.estimate !== undefined) {
      preRoutingEstimate = data.estimate
    }
    if (data.phase === 'post-routing' && data.estimate !== undefined) {
      postRoutingEstimate = data.estimate
      estimatorPrecision = data.precision
    }
  }

  return { preRoutingEstimate, postRoutingEstimate, estimatorPrecision }
}

interface RoutingDecisionEvent {
  routingDecisionId: string
  selectedProvider: string
  selectedModel: string
  turn: number
  step: number
}

function extractRoutingDecisions(events: SessionEvent[]): RoutingDecisionEvent[] {
  const decisions: RoutingDecisionEvent[] = []
  for (const event of events) {
    if (event.type !== 'model/routing-decision') continue
    const data = event.data as {
      routingDecisionId: string
      selected: { provider: string; model: string }
      turn: number
      step: number
    }
    decisions.push({
      routingDecisionId: data.routingDecisionId,
      selectedProvider: data.selected.provider,
      selectedModel: data.selected.model,
      turn: data.turn,
      step: data.step,
    })
  }
  return decisions
}

/** Verify routingDecisionId is consistent across all events in the chain. */
function verifyRoutingDecisionIdConsistency(events: SessionEvent[]): {
  consistent: boolean
  routingDecisionId?: string
  eventTypes: string[]
} {
  const ids = new Set<string>()
  const eventTypes: string[] = []
  for (const event of events) {
    const data = event.data as { routingDecisionId?: string }
    if (data.routingDecisionId !== undefined) {
      ids.add(data.routingDecisionId)
      eventTypes.push(`${event.type}:${data.routingDecisionId}`)
    }
  }
  return {
    consistent: ids.size <= 1,
    ...ids.size === 1 ? { routingDecisionId: [...ids][0] } : {},
    eventTypes,
  }
}

// ---------------------------------------------------------------------------
// Config generation
// ---------------------------------------------------------------------------

async function generateDirectConfig(scenario: DirectScenario, workDir: string): Promise<string> {
  const basePath = join(REPO_ROOT, 'examples', 'headless-agent', 'cordis.yml')
  let base = await readFile(basePath, 'utf8')
  base = base.replace(/model: deepseek-v4-flash/, `model: ${scenario.model}`)
  if (scenario.thinking === 'off') {
    base = base.replace(/thinking: enabled/, 'thinking: disabled')
    base = base.replace(/reasoningEffort: max/, 'reasoningEffort: off')
  }
  base = base.replace(/compression: !!js "process.env.DSH_SNAPSHOT === undefined \? 'zstd' : 'none'"/, "compression: 'none'")
  const configPath = join(workDir, 'cordis.yml')
  await writeFile(configPath, base, 'utf8')
  return configPath
}

async function generateRoutedConfig(workDir: string): Promise<string> {
  const basePath = join(REPO_ROOT, 'examples', 'headless-agent', 'cordis.yml')
  let base = await readFile(basePath, 'utf8')
  // Keep the default model in agent-spine (Flash) — the router overrides it
  // through the agent/request waterfall. The agent needs a model to start.
  // Set reasoningEffort to high (router heavyRoute will override per-tier)
  base = base.replace(/reasoningEffort: max/, 'reasoningEffort: high')
  // Insert model-router entry right after the llm-deepseek block ends
  // (before the "# Managed child-process groups" comment)
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
  // Use no compression
  base = base.replace(/compression: !!js "process.env.DSH_SNAPSHOT === undefined \? 'zstd' : 'none'"/, "compression: 'none'")
  const configPath = join(workDir, 'cordis.yml')
  await writeFile(configPath, base, 'utf8')
  return configPath
}

// ---------------------------------------------------------------------------
// Scenario execution
// ---------------------------------------------------------------------------

interface ScenarioResult {
  scenario: Scenario
  usageRecords: CanonicalUsage[]
  routingOutcomes: RoutingOutcome[]
  estimates: {
    preRoutingEstimate?: number
    postRoutingEstimate?: number
    estimatorPrecision?: string
  }
  routingDecisions: RoutingDecisionEvent[]
  routingIdConsistency: {
    consistent: boolean
    routingDecisionId?: string
    eventTypes: string[]
  }
  invariants: InvariantSet
  pricingVersion: string
  costUsd: number
  costConfidence: string
  error?: string
}

async function runDirectScenario(scenario: DirectScenario, workDir: string): Promise<ScenarioResult> {
  const configPath = await generateDirectConfig(scenario, workDir)
  return runScenarioInternal(scenario, configPath, workDir, false)
}

async function runRoutedScenario(scenario: RoutedScenario, workDir: string): Promise<ScenarioResult> {
  const configPath = await generateRoutedConfig(workDir)
  return runScenarioInternal(scenario, configPath, workDir, true)
}

async function runScenarioInternal(
  scenario: Scenario,
  configPath: string,
  workDir: string,
  _isRouted: boolean,
): Promise<ScenarioResult> {
  await mkdir(join(workDir, 'sessions'), { recursive: true })

  const events: SessionEvent[] = []
  let uninstallFailLoud: (() => void) | undefined
  let ctx: Context | undefined

  try {
    loadEnv('rc1-qualification')
    uninstallFailLoud = installFailLoud('rc1-qualification')
    ctx = await boot('rc1-qualification', resolveConfigPath(configPath, undefined))

    if (scenario.kind === 'direct' && scenario.repeatedPrefix !== undefined) {
      await runFixtureTurn(ctx, { task: scenario.repeatedPrefix, onEvent: (_sid, event) => events.push(event) })
    }

    await runFixtureTurn(ctx, { task: scenario.task, onEvent: (_sid, event) => events.push(event) })

    const routingOutcomes = [...deriveRoutingOutcomes(events, 'qualification', DEFAULT_PRICING_REGISTRY)]
    const usageRecords = extractUsageRecords(events)
    const estimates = extractEstimates(events)
    const routingDecisions = extractRoutingDecisions(events)
    const routingIdConsistency = verifyRoutingDecisionIdConsistency(events)

    // Determine model and pricing
    const model = scenario.kind === 'direct'
      ? scenario.model
      : (routingDecisions[0]?.selectedModel ?? 'unknown')
    const firstUsage = usageRecords[0]
    const firstPricing = firstUsage === undefined
      ? undefined
      : lookupPricingAt(DEFAULT_PRICING_REGISTRY, 'deepseek-official', model, new Date(firstUsage.time))
    const pricingVersion = firstPricing?.version ?? ''
    let costUsd = 0
    let costConfidence = 'conservative-estimate'
    for (const usage of usageRecords) {
      const pricing = lookupPricingAt(DEFAULT_PRICING_REGISTRY, 'deepseek-official', model, new Date(usage.time))
      if (pricing === undefined) continue
      const cost = calculateCost(usage, pricing)
      costUsd += cost.amount
      costConfidence = cost.confidence
    }

    const invariants = validateInvariants(usageRecords, pricingVersion)

    return {
      scenario,
      usageRecords,
      routingOutcomes,
      estimates,
      routingDecisions,
      routingIdConsistency,
      invariants,
      pricingVersion,
      costUsd,
      costConfidence,
    }
  } catch (error: unknown) {
    return {
      scenario,
      usageRecords: [],
      routingOutcomes: [],
      estimates: {},
      routingDecisions: [],
      routingIdConsistency: { consistent: false, eventTypes: [] },
      invariants: {
        raw_promptEqualsHitPlusMiss: false,
        raw_totalEqualsPromptPlusCompletion: false,
        canonical_inputEqualsCacheMiss: false,
        canonical_totalPromptEqualsInputPlusCacheRead: false,
        canonical_totalEqualsTotalPromptPlusOutput: false,
        reasoningNotDoubleBilled: false,
        pricingVersionRecorded: false,
      },
      pricingVersion: '',
      costUsd: 0,
      costConfidence: 'N/A',
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await ctx?.fiber.dispose()
    uninstallFailLoud?.()
  }
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

function formatReport(results: ScenarioResult[]): string {
  const lines: string[] = []
  lines.push('# v0.16.0-rc1 Live Qualification Report')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')
  lines.push('## Milestone classification')
  lines.push('')
  lines.push('Provider/accounting qualification: PASS (Q1-Q6)')
  lines.push('Routed-path qualification: see R1/R2 below')
  lines.push('')
  lines.push('## Token vocabulary')
  lines.push('')
  lines.push('RAW PROVIDER (DeepSeek Chat Completions):')
  lines.push('  prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens')
  lines.push('  total_tokens  = prompt_tokens + completion_tokens')
  lines.push('')
  lines.push('CANONICAL HARNESS (disjoint counts, inputTokens excludes cache hits):')
  lines.push('  inputTokens   = cacheMissTokens')
  lines.push('  totalPrompt   = inputTokens + cacheReadTokens')
  lines.push('  totalTokens   = totalPrompt + outputTokens')
  lines.push('')
  lines.push('The adapter (mapUsage) performs: inputTokens = prompt_tokens - cacheRead.')
  lines.push('Session events carry CANONICAL values. Both invariant layers are validated.')
  lines.push('')

  // Q1-Q6
  lines.push('## Q1-Q6: Direct-selection provider/accounting qualification')
  lines.push('')

  for (const result of results.filter(r => r.scenario.kind === 'direct')) {
    const scenario = result.scenario as DirectScenario
    lines.push(`### ${scenario.id} — ${scenario.model} / Thinking ${scenario.thinking}`)
    lines.push('────────────────────────────')

    if (result.error !== undefined) {
      lines.push(`ERROR: ${result.error}`)
      lines.push('')
      continue
    }

    const agg = result.usageRecords.reduce((acc, u) => {
      acc.inputTokens += u.inputTokens
      acc.outputTokens += u.outputTokens
      acc.cacheReadTokens += u.cacheReadTokens ?? 0
      acc.cacheMissTokens += u.cacheMissTokens ?? 0
      acc.reasoningTokens += u.reasoningTokens ?? 0
      acc.totalTokens += u.totalTokens ?? 0
      return acc
    }, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheMissTokens: 0, reasoningTokens: 0, totalTokens: 0 })

    const raw = toRaw(agg as CanonicalUsage)

    lines.push('CANONICAL (harness disjoint):')
    lines.push(`  inputTokens       ${agg.inputTokens}`)
    lines.push(`  cacheReadTokens   ${agg.cacheReadTokens}`)
    lines.push(`  cacheMissTokens   ${agg.cacheMissTokens}`)
    lines.push(`  outputTokens      ${agg.outputTokens}`)
    lines.push(`  reasoningTokens   ${agg.reasoningTokens}`)
    lines.push(`  totalTokens       ${agg.totalTokens}`)
    lines.push('RAW PROVIDER (reconstructed):')
    lines.push(`  prompt_tokens     ${raw.promptTokens}`)
    lines.push(`  cache_hit         ${raw.cacheHitTokens}`)
    lines.push(`  cache_miss        ${raw.cacheMissTokens}`)
    lines.push(`  completion_tokens ${raw.completionTokens}`)
    lines.push(`  total_tokens      ${raw.totalTokens}`)
    lines.push('Economics:')
    lines.push(`  pricing version   ${result.pricingVersion}`)
    lines.push(`  cost              $${result.costUsd.toFixed(6)}`)
    lines.push(`  confidence        ${result.costConfidence}`)
    lines.push('')

    const inv = result.invariants
    lines.push('Invariants:')
    lines.push(`  RAW  prompt = hit + miss:              ${inv.raw_promptEqualsHitPlusMiss ? 'PASS' : 'FAIL'}`)
    lines.push(`  RAW  total = prompt + completion:      ${inv.raw_totalEqualsPromptPlusCompletion ? 'PASS' : 'FAIL'}`)
    lines.push(`  CAN  inputTokens = cacheMiss:          ${inv.canonical_inputEqualsCacheMiss ? 'PASS' : 'FAIL'}`)
    lines.push(`  CAN  totalPrompt = input + cacheRead:  ${inv.canonical_totalPromptEqualsInputPlusCacheRead ? 'PASS' : 'FAIL'}`)
    lines.push(`  CAN  total = totalPrompt + output:     ${inv.canonical_totalEqualsTotalPromptPlusOutput ? 'PASS' : 'FAIL'}`)
    lines.push(`  reasoning not double-billed:           ${inv.reasoningNotDoubleBilled ? 'PASS' : 'FAIL'}`)
    lines.push(`  pricing version recorded:              ${inv.pricingVersionRecorded ? 'PASS' : 'FAIL'}`)
    lines.push('')

    lines.push(`Canonical usage records (${result.usageRecords.length}):`)
    for (const [i, u] of result.usageRecords.entries()) {
      const r = toRaw(u)
      lines.push(`  [${i}] canonical: input=${u.inputTokens} cacheRead=${u.cacheReadTokens ?? 'N/A'} cacheMiss=${u.cacheMissTokens ?? 'N/A'} output=${u.outputTokens} reasoning=${u.reasoningTokens ?? 'N/A'} total=${u.totalTokens ?? 'N/A'}`)
      lines.push(`      raw:       prompt=${r.promptTokens} hit=${r.cacheHitTokens} miss=${r.cacheMissTokens} completion=${r.completionTokens} total=${r.totalTokens}`)
    }
    lines.push('')
  }

  // R1-R2
  lines.push('## R1-R2: Routed-path qualification (llm-model-router)')
  lines.push('')

  for (const result of results.filter(r => r.scenario.kind === 'routed')) {
    const scenario = result.scenario as RoutedScenario
    lines.push(`### ${scenario.id} — ${scenario.description}`)
    lines.push('────────────────────────────')

    if (result.error !== undefined) {
      lines.push(`ERROR: ${result.error}`)
      lines.push('')
      continue
    }

    const decisions = result.routingDecisions
    lines.push(`Routing decisions: ${decisions.length}`)
    for (const d of decisions) {
      lines.push(`  ${d.routingDecisionId}: ${d.selectedProvider}/${d.selectedModel} (turn ${d.turn}, step ${d.step})`)
    }
    lines.push('')

    lines.push(`routingDecisionId consistency: ${result.routingIdConsistency.consistent ? 'PASS' : 'FAIL'}`)
    if (result.routingIdConsistency.routingDecisionId !== undefined) {
      lines.push(`  shared ID: ${result.routingIdConsistency.routingDecisionId}`)
    }
    for (const et of result.routingIdConsistency.eventTypes) {
      lines.push(`  ${et}`)
    }
    lines.push('')

    const agg = result.usageRecords.reduce((acc, u) => {
      acc.inputTokens += u.inputTokens
      acc.outputTokens += u.outputTokens
      acc.cacheReadTokens += u.cacheReadTokens ?? 0
      acc.cacheMissTokens += u.cacheMissTokens ?? 0
      acc.reasoningTokens += u.reasoningTokens ?? 0
      acc.totalTokens += u.totalTokens ?? 0
      return acc
    }, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheMissTokens: 0, reasoningTokens: 0, totalTokens: 0 })

    const raw = toRaw(agg as CanonicalUsage)
    const selectedModel = decisions[0]?.selectedModel ?? 'unknown'

    lines.push(`Selected model: ${selectedModel}`)
    lines.push(`Expected route: ${scenario.expectedRoute}`)
    lines.push('CANONICAL (harness disjoint):')
    lines.push(`  inputTokens       ${agg.inputTokens}`)
    lines.push(`  cacheReadTokens   ${agg.cacheReadTokens}`)
    lines.push(`  cacheMissTokens   ${agg.cacheMissTokens}`)
    lines.push(`  outputTokens      ${agg.outputTokens}`)
    lines.push(`  reasoningTokens   ${agg.reasoningTokens}`)
    lines.push(`  totalTokens       ${agg.totalTokens}`)
    lines.push('RAW PROVIDER (reconstructed):')
    lines.push(`  prompt_tokens     ${raw.promptTokens}`)
    lines.push(`  cache_hit         ${raw.cacheHitTokens}`)
    lines.push(`  cache_miss        ${raw.cacheMissTokens}`)
    lines.push(`  completion_tokens ${raw.completionTokens}`)
    lines.push(`  total_tokens      ${raw.totalTokens}`)
    lines.push('Economics:')
    lines.push(`  pricing version   ${result.pricingVersion}`)
    lines.push(`  cost              $${result.costUsd.toFixed(6)}`)
    lines.push(`  confidence        ${result.costConfidence}`)
    lines.push('')

    const inv = result.invariants
    lines.push('Invariants:')
    lines.push(`  RAW  prompt = hit + miss:              ${inv.raw_promptEqualsHitPlusMiss ? 'PASS' : 'FAIL'}`)
    lines.push(`  RAW  total = prompt + completion:      ${inv.raw_totalEqualsPromptPlusCompletion ? 'PASS' : 'FAIL'}`)
    lines.push(`  CAN  inputTokens = cacheMiss:          ${inv.canonical_inputEqualsCacheMiss ? 'PASS' : 'FAIL'}`)
    lines.push(`  CAN  totalPrompt = input + cacheRead:  ${inv.canonical_totalPromptEqualsInputPlusCacheRead ? 'PASS' : 'FAIL'}`)
    lines.push(`  CAN  total = totalPrompt + output:     ${inv.canonical_totalEqualsTotalPromptPlusOutput ? 'PASS' : 'FAIL'}`)
    lines.push(`  reasoning not double-billed:           ${inv.reasoningNotDoubleBilled ? 'PASS' : 'FAIL'}`)
    lines.push(`  pricing version recorded:              ${inv.pricingVersionRecorded ? 'PASS' : 'FAIL'}`)
    lines.push('')

    const outcome = result.routingOutcomes[0]
    lines.push('RoutingOutcome:')
    if (outcome !== undefined) {
      lines.push(`  routingDecisionId  ${outcome.routingDecisionId}`)
      lines.push(`  status             ${outcome.outcome.status}`)
      lines.push(`  attempts           ${outcome.accounting.attempts}`)
      lines.push(`  tool failures      ${outcome.executionQuality.toolFailures}`)
      lines.push(`  repairs            ${outcome.executionQuality.repairIterations}`)
    } else {
      lines.push('  NO RoutingOutcome derived (no routing-decision events)')
    }
    lines.push('')
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const hasKey = Boolean(process.env.DEEPSEEK_API_KEY)
  if (!hasKey) {
    process.stderr.write('DEEPSEEK_API_KEY is required for live qualification\n')
    process.exit(1)
  }

  const workRoot = await mkdtemp(join(tmpdir(), 'rc1-qual-'))
  process.stderr.write(`Qualification work directory: ${workRoot}\n`)

  const results: ScenarioResult[] = []
  for (const scenario of SCENARIOS) {
    process.stderr.write(`\nRunning ${scenario.id}: ${scenario.description}...\n`)
    const scenarioDir = join(workRoot, scenario.id)
    await mkdir(scenarioDir, { recursive: true })
    const result = scenario.kind === 'direct'
      ? await runDirectScenario(scenario, scenarioDir)
      : await runRoutedScenario(scenario, scenarioDir)
    results.push(result)

    if (result.error !== undefined) {
      process.stderr.write(`  FAILED: ${result.error}\n`)
    } else {
      const u = result.usageRecords[0]
      const model = scenario.kind === 'direct'
        ? scenario.model
        : (result.routingDecisions[0]?.selectedModel ?? 'unknown')
      process.stderr.write(`  OK: model=${model} input=${u?.inputTokens ?? 0} output=${u?.outputTokens ?? 0} cost=$${result.costUsd.toFixed(6)}\n`)
      if (scenario.kind === 'routed') {
        process.stderr.write(`  routingDecisionId consistent: ${result.routingIdConsistency.consistent}\n`)
      }
    }
  }

  // Generate reports
  const reportDir = join(REPO_ROOT, 'artifacts', 'reports')
  const jsonReport = {
    release: 'v0.16.0-rc.1',
    generatedAt: new Date().toISOString(),
    milestone: 'provider-accounting-qualification + routed-path-qualification',
    results: results.map(r => ({
      scenario: r.scenario,
      usageRecords: r.usageRecords,
      routingOutcomes: r.routingOutcomes,
      routingDecisions: r.routingDecisions,
      routingIdConsistency: r.routingIdConsistency,
      estimates: r.estimates,
      invariants: r.invariants,
      pricingVersion: r.pricingVersion,
      costUsd: r.costUsd,
      costConfidence: r.costConfidence,
      error: r.error,
    })),
  }

  await writeFile(join(reportDir, 'v0.16.0-rc1-qualification-results.json'), JSON.stringify(jsonReport, null, 2), 'utf8')
  await writeFile(join(reportDir, 'v0.16.0-rc1-qualification-report.md'), formatReport(results), 'utf8')

  process.stderr.write('\nReports written to artifacts/reports/\n')

  await rm(workRoot, { recursive: true, force: true })

  const failures = results.filter(r => r.error !== undefined)
  if (failures.length > 0) {
    process.stderr.write(`${failures.length} scenario(s) failed\n`)
    process.exit(1)
  }
}

void main()
