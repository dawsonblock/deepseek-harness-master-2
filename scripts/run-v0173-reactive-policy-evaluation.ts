#!/usr/bin/env node
/** Reprices the frozen benchmark and evaluates verification-triggered Pro escalation. */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_PRICING_REGISTRY,
  calculateCost,
  lookupPricingAt,
} from '@deepseek-ai/dsh-token-meter'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const BENCHMARK_PATH = join(REPO_ROOT, 'artifacts', 'reports', 'v0.17.2-expanded-benchmark.json')
const FORENSIC_PATH = join(REPO_ROOT, 'artifacts', 'reports', 'v0.17.3-pro-necessity-forensics.json')
const JSON_PATH = join(REPO_ROOT, 'artifacts', 'reports', 'v0.17.3-reactive-policy-evaluation.json')
const REPORT_PATH = join(REPO_ROOT, 'artifacts', 'reports', 'v0.17.3-reactive-policy-evaluation.md')

interface Run {
  model: string
  iteration: number
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number; totalTokens: number }
  cache: { hitTokens: number; missTokens: number; hitRate: number }
  execution: { latencyMs: number; attempts: number; toolCalls: number; toolFailures: number; repairs: number }
  verification: { status: string; criteriaPassed: number; criteriaTotal: number }
}

interface Pair {
  taskId: string
  iteration: number
  flash: Run
  pro: Run
  classification: string
}

interface Benchmark {
  pairs: Pair[]
}

interface Forensics {
  records: Array<{
    taskId: string
    difference: { labelValidity: 'genuine' | 'ambiguous' | 'verifier-artifact' }
  }>
}

type PricingBand = 'peak' | 'off-peak'
type LabelMode = 'raw' | 'audited'

interface StageRun {
  model: 'Flash' | 'Pro'
  run: Run
}

interface TaskPolicyOutcome {
  taskId: string
  verified: boolean
  stages: StageRun[]
  escalated: boolean
}

interface PolicyMetrics {
  policy: string
  labelMode: LabelMode
  band: PricingBand
  tasks: number
  verifiedTasks: number
  verifiedRate: number
  totalCost: number
  costPerVerifiedTask: number
  medianLatencyMs: number
  p90LatencyMs: number
  modelCallsPerTask: number
  proCalls: number
  proUtilization: number
  escalations: number
  escalationRate: number
  successfulRescues: number
  rescueRate: number
}

const PRICING_INSTANTS: Record<PricingBand, Date> = {
  peak: new Date('2026-08-25T06:30:00Z'),
  'off-peak': new Date('2026-08-25T05:00:00Z'),
}

function verified(run: Run, taskId: string, labelMode: LabelMode, audit: Map<string, string>): boolean {
  if (run.verification.status === 'verified-pass') return true
  return labelMode === 'audited' && run.model === 'deepseek-v4-flash'
    && audit.get(`${taskId}/${run.iteration}`) === 'verifier-artifact'
}

function runCost(run: Run, band: PricingBand): number {
  const pricing = lookupPricingAt(
    DEFAULT_PRICING_REGISTRY,
    'deepseek-official',
    run.model,
    PRICING_INSTANTS[band],
  )
  if (pricing === undefined) throw new Error(`Missing ${band} pricing for ${run.model}`)
  return calculateCost({
    inputTokens: run.usage.inputTokens,
    outputTokens: run.usage.outputTokens,
    cacheReadTokens: run.cache.hitTokens,
    cacheMissTokens: run.cache.missTokens,
    reasoningTokens: run.usage.reasoningTokens,
    totalTokens: run.usage.totalTokens,
    source: 'provider',
  }, pricing).amount
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(Math.ceil(sorted.length * fraction) - 1, sorted.length - 1)] ?? 0
}

function metrics(
  policy: string,
  labelMode: LabelMode,
  band: PricingBand,
  outcomes: TaskPolicyOutcome[],
): PolicyMetrics {
  const verifiedTasks = outcomes.filter(outcome => outcome.verified).length
  const calls = outcomes.flatMap(outcome => outcome.stages)
  const proCalls = calls.filter(stage => stage.model === 'Pro').length
  const escalated = outcomes.filter(outcome => outcome.escalated)
  const successfulRescues = escalated.filter(outcome => outcome.verified).length
  const totalCost = calls.reduce((sum, stage) => sum + runCost(stage.run, band), 0)
  const latencies = outcomes.map(outcome =>
    outcome.stages.reduce((sum, stage) => sum + stage.run.execution.latencyMs, 0),
  )
  return {
    policy,
    labelMode,
    band,
    tasks: outcomes.length,
    verifiedTasks,
    verifiedRate: verifiedTasks / outcomes.length,
    totalCost,
    costPerVerifiedTask: verifiedTasks === 0 ? Infinity : totalCost / verifiedTasks,
    medianLatencyMs: percentile(latencies, 0.5),
    p90LatencyMs: percentile(latencies, 0.9),
    modelCallsPerTask: calls.length / outcomes.length,
    proCalls,
    proUtilization: proCalls / calls.length,
    escalations: escalated.length,
    escalationRate: escalated.length / outcomes.length,
    successfulRescues,
    rescueRate: escalated.length === 0 ? 0 : successfulRescues / escalated.length,
  }
}

function initialPairs(benchmark: Benchmark): Array<{ taskId: string; initial: Pair; retry: Pair }> {
  const byTask = new Map<string, Pair[]>()
  for (const pair of benchmark.pairs) {
    const taskId = pair.taskId.replace(/\/\d+$/, '')
    byTask.set(taskId, [...byTask.get(taskId) ?? [], pair])
  }
  return [...byTask.entries()].map(([taskId, pairs]) => {
    const initial = pairs.find(pair => pair.iteration === 1)
    const retry = pairs.find(pair => pair.iteration === 2)
    if (initial === undefined || retry === undefined) throw new Error(`Missing paired iterations for ${taskId}`)
    return { taskId, initial, retry }
  }).sort((left, right) => left.taskId.localeCompare(right.taskId))
}

function simulate(
  benchmark: Benchmark,
  audit: Map<string, string>,
  labelMode: LabelMode,
): Record<string, TaskPolicyOutcome[]> {
  const tasks = initialPairs(benchmark)
  return {
    'flash-only': tasks.map(({ taskId, initial }) => ({
      taskId,
      verified: verified(initial.flash, taskId, labelMode, audit),
      stages: [{ model: 'Flash', run: initial.flash }],
      escalated: false,
    })),
    'pro-only': tasks.map(({ taskId, initial }) => ({
      taskId,
      verified: verified(initial.pro, taskId, labelMode, audit),
      stages: [{ model: 'Pro', run: initial.pro }],
      escalated: false,
    })),
    'flash-then-pro': tasks.map(({ taskId, initial }) => {
      const flashPassed = verified(initial.flash, taskId, labelMode, audit)
      return {
        taskId,
        verified: flashPassed || verified(initial.pro, taskId, labelMode, audit),
        stages: flashPassed
          ? [{ model: 'Flash' as const, run: initial.flash }]
          : [{ model: 'Flash' as const, run: initial.flash }, { model: 'Pro' as const, run: initial.pro }],
        escalated: !flashPassed,
      }
    }),
    'flash-retry-pro-proxy': tasks.map(({ taskId, initial, retry }) => {
      const initialPassed = verified(initial.flash, taskId, labelMode, audit)
      const retryPassed = verified(retry.flash, taskId, labelMode, audit)
      if (initialPassed) {
        return {
          taskId,
          verified: true,
          stages: [{ model: 'Flash' as const, run: initial.flash }],
          escalated: false,
        }
      }
      if (retryPassed) {
        return {
          taskId,
          verified: true,
          stages: [
            { model: 'Flash' as const, run: initial.flash },
            { model: 'Flash' as const, run: retry.flash },
          ],
          escalated: false,
        }
      }
      return {
        taskId,
        verified: verified(retry.pro, taskId, labelMode, audit),
        stages: [
          { model: 'Flash' as const, run: initial.flash },
          { model: 'Flash' as const, run: retry.flash },
          { model: 'Pro' as const, run: retry.pro },
        ],
        escalated: true,
      }
    }),
  }
}

function row(result: PolicyMetrics): string {
  return `| ${result.policy} | ${(result.verifiedRate * 100).toFixed(1)}% | $${result.costPerVerifiedTask.toFixed(6)} | $${result.totalCost.toFixed(6)} | ${(result.escalationRate * 100).toFixed(1)}% | ${(result.proUtilization * 100).toFixed(1)}% | ${result.modelCallsPerTask.toFixed(2)} | ${result.medianLatencyMs.toFixed(0)}ms | ${result.p90LatencyMs.toFixed(0)}ms |`
}

async function main(): Promise<void> {
  const benchmark = JSON.parse(await readFile(BENCHMARK_PATH, 'utf8')) as Benchmark
  const forensics = JSON.parse(await readFile(FORENSIC_PATH, 'utf8')) as Forensics
  const audit = new Map(forensics.records.map(record => [record.taskId, record.difference.labelValidity]))
  const results: PolicyMetrics[] = []
  for (const labelMode of ['raw', 'audited'] as const) {
    const policies = simulate(benchmark, audit, labelMode)
    for (const band of ['off-peak', 'peak'] as const) {
      for (const [policy, outcomes] of Object.entries(policies)) {
        results.push(metrics(policy, labelMode, band, outcomes))
      }
    }
  }

  const auditedPeak = results.filter(result => result.labelMode === 'audited' && result.band === 'peak')
  const peakFlash = auditedPeak.find(result => result.policy === 'flash-only')
  const peakPro = auditedPeak.find(result => result.policy === 'pro-only')
  const peakRescue = auditedPeak.find(result => result.policy === 'flash-then-pro')
  if (peakFlash === undefined || peakPro === undefined || peakRescue === undefined) {
    throw new Error('Missing audited peak policy metrics')
  }
  const output = {
    release: 'v0.17.3',
    sourceDataset: 'paired-v4-100-v1',
    pricing: {
      effectiveFrom: '2026-08-16T16:00:00Z',
      peakUtcWindows: ['01:00-04:00', '06:00-10:00'],
      benchmarkCollectionBand: 'peak',
      ratesPerMillion: {
        flash: {
          'off-peak': { cacheHitInput: 0.007, cacheMissInput: 0.22, output: 0.66 },
          peak: { cacheHitInput: 0.014, cacheMissInput: 0.44, output: 1.32 },
        },
        pro: {
          'off-peak': { cacheHitInput: 0.022, cacheMissInput: 0.66, output: 1.98 },
          peak: { cacheHitInput: 0.044, cacheMissInput: 1.32, output: 3.96 },
        },
      },
    },
    policyDefinitions: {
      'flash-only': 'iteration-1 Flash only',
      'pro-only': 'iteration-1 Pro only',
      'flash-then-pro': 'iteration-1 Flash; iteration-1 Pro only after verified Flash failure',
      'flash-retry-pro-proxy': 'iteration-1 Flash; independent iteration-2 Flash proxy; iteration-2 Pro after two failures',
    },
    limitations: [
      'The second Flash run is an independent repeated prompt, not a repair conditioned on failure evidence.',
      'The benchmark stores final outputs and aggregate usage, not a real three-stage repair trajectory.',
      'Raw and forensic-audited verifier labels are reported separately.',
    ],
    results,
    peakAuditedComparison: {
      proToFlashCostPerVerifiedRatio: peakPro.costPerVerifiedTask / peakFlash.costPerVerifiedTask,
      rescueSavingsVsProOnly: 1 - peakRescue.costPerVerifiedTask / peakPro.costPerVerifiedTask,
      rescuePremiumVsFlashOnly: peakRescue.costPerVerifiedTask / peakFlash.costPerVerifiedTask - 1,
    },
  }
  await writeFile(JSON_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8')

  const lines = [
    '# v0.17.3 Reactive Escalation Economics',
    '',
    'Dataset: paired-v4-100-v1 (50 task classes; iteration 1 is the initial attempt)',
    '',
    '## Pricing correction',
    '',
    '- The frozen v0.17.2 reports use the superseded flat registry and remain unchanged as historical artifacts.',
    '- The 200 calls were collected during the 06:00-10:00 UTC peak window and are repriced at peak rates for the primary comparison.',
    '- Off-peak results use the same token records under the published off-peak schedule.',
    '',
    '## Peak policy comparison (forensic-audited labels)',
    '',
    '| Policy | Verified | Cost/verified | Total cost | Escalation | Pro util | Calls/task | Median latency | p90 latency |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...auditedPeak.map(row),
    '',
    '## Off-peak policy comparison (forensic-audited labels)',
    '',
    '| Policy | Verified | Cost/verified | Total cost | Escalation | Pro util | Calls/task | Median latency | p90 latency |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...results.filter(result => result.labelMode === 'audited' && result.band === 'off-peak').map(row),
    '',
    '## Interpretation',
    '',
    `At peak prices, Pro-only costs ${output.peakAuditedComparison.proToFlashCostPerVerifiedRatio.toFixed(2)} times Flash-only per verified task. Flash-then-Pro reduces cost per verified task by ${(output.peakAuditedComparison.rescueSavingsVsProOnly * 100).toFixed(1)}% relative to Pro-only while preserving its observed verified-success rate. It costs ${(output.peakAuditedComparison.rescuePremiumVsFlashOnly * 100).toFixed(1)}% more than Flash-only because failed Flash attempts are retained in task cost.`,
    '',
    'The independent-retry proxy is not evidence for a production repair policy. A real Flash repair receives failure evidence and must be measured as one joined trajectory before its economics can qualify.',
  ]
  await writeFile(REPORT_PATH, `${lines.join('\n')}\n`, 'utf8')
  process.stdout.write(`Wrote ${JSON_PATH} and ${REPORT_PATH}\n`)
}

void main()
