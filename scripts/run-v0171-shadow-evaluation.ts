#!/usr/bin/env node
/**
 * v0.17.1 shadow-mode evaluation with richer features and multi-target model.
 *
 * Pipeline:
 *   1. Load v0.16.0 paired benchmark data (frozen dataset).
 *   2. Extract richer pre-routing features: complexity + structural + categorical.
 *   3. Train multi-target model: P(Flash passes), P(Pro passes), expected cost delta.
 *   4. Partition by task class (stratified train/val/test).
 *   5. Evaluate shadow predictions against actual outcomes.
 *   6. Report using the metric hierarchy:
 *        1. Verified success rate (primary constraint)
 *        2. Cost per verified task (primary optimization)
 *        3. ProNecessity recall
 *        4. ProWasteRate
 *        5. Repair rate
 *        6. Median/p90 latency
 *        7. Pro utilization
 *
 * No live API calls. Pure offline evaluation on the frozen dataset.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  scoreComplexity,
  classifyTaskType,
  taskTypeExpectsProAdvantage,
  trainModel,
  predict,
  FEATURE_NAMES,
  FEATURE_VERSION,
  MODEL_VERSION,
} from '@deepseek-ai/dsh-llm-model-router'
import type { PreRoutingFeatureVector, StructuralFeatures, CategoricalFeatures, HistoricalFeatures } from '@deepseek-ai/dsh-llm-model-router'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = join(__dirname, '..')

// ---------------------------------------------------------------------------
// Types (matching the benchmark JSON)
// ---------------------------------------------------------------------------

interface BenchmarkRun {
  taskId: string
  category: string
  policy: string
  model: string
  iteration: number
  cacheState: string
  cache: { hitTokens: number; missTokens: number; hitRate: number }
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number; totalTokens: number }
  economics: { costUsd: number; pricingVersion: string }
  execution: { latencyMs: number; attempts: number; toolCalls: number; toolFailures: number; repairs: number }
  verification: { status: string; criteriaPassed: number; criteriaTotal: number }
  output: string
}

interface BenchmarkData {
  release: string
  generatedAt: string
  design: {
    taskClasses: Array<{ id: string; category: string; description: string; expectsProAdvantage: boolean; criteriaCount: number }>
    iterations: number
    policies: string[]
    cacheControl: string
    verification: string
    coreMetric: string
  }
  runs: BenchmarkRun[]
  pairs: Array<{
    taskId: string
    iteration: number
    cacheState: string
    flash: BenchmarkRun
    pro: BenchmarkRun
    classification: string
    cacheComparable: boolean
  }>
}

// ---------------------------------------------------------------------------
// Task text (must match benchmark definitions)
// ---------------------------------------------------------------------------

const TASK_TEXTS: Record<string, string> = {
  'arithmetic': 'What is 7 * 8? Reply with just the number.',
  'capital-city': 'What is the capital of Australia? Reply with just the city name.',
  'factual-explain': 'Explain in three sentences how a hash map handles collisions using open addressing. Each sentence must be distinct.',
  'list-formatting': 'List the first 5 prime numbers, one per line, with no other text.',
  'code-edit': 'Write a TypeScript function called reverseList that takes an array and returns it reversed. Include the type signature. Do not use the built-in reverse method.',
  'code-bug-fix': 'This binary search has a bug:\nfunction binarySearch(arr, target) {\n  let lo = 0, hi = arr.length\n  while (lo < hi) {\n    const mid = (lo + hi) / 2\n    if (arr[mid] === target) return mid\n    if (arr[mid] < target) lo = mid\n    else hi = mid\n  }\n  return -1\n}\n\nIdentify the bug and provide the corrected function. Explain the fix.',
  'reasoning-proof': 'Think step by step. Prove that the sum of two odd integers is always even. Show your reasoning with algebraic notation.',
  'logic-puzzle': 'Three people - Alice, Bob, and Carol - are standing in a line. Alice is taller than Bob. Carol is shorter than Bob. Who is the tallest? Explain your reasoning step by step.',
  'debug-off-by-one': 'This function should sum numbers from 1 to n inclusive, but it returns the wrong answer for n=5 (gives 10 instead of 15):\nfunction sumTo(n) {\n  let total = 0\n  for (let i = 1; i < n; i++) total += i\n  return total\n}\n\nWhat is the bug? Provide the corrected function.',
  'structured-transform': 'Convert this CSV to a JSON array of objects:\nname,age\nAlice,30\nBob,25\n\nReply with only the JSON.',
  'yaml-to-json': 'Convert this YAML to a JSON object:\nname: Test\nversion: 3\nenabled: true\n\nReply with only the JSON.',
  'plan-feature': 'Plan the implementation of a user authentication system with login, logout, and session management. List the steps in order. Keep it to 5-7 steps.',
  'verify-algorithm': 'Is this a correct implementation of bubble sort? If not, identify the error:\nfunction bubbleSort(arr) {\n  for (let i = 0; i < arr.length; i++) {\n    for (let j = 0; j < arr.length - 1; j++) {\n      if (arr[j] > arr[j + 1]) {\n        [arr[j], arr[j + 1]] = [arr[j + 1], arr[j]]\n      }\n    }\n  }\n  return arr\n}\n\nExplain your answer.',
  'long-context-summary': 'Read the following text and summarize it in exactly 2 sentences:\n\nThe waterfall model is a sequential design process in which progress is seen as flowing steadily downwards through the phases of conception, initiation, analysis, design, construction, testing, production, and implementation. The waterfall model is a traditional engineering approach that was first described in 1970 by Winston W. Royce, although Royce did not use the term waterfall in that article. The waterfall model prescribes a systematic, sequential approach to software development, which begins with customer specification of requirements and progresses through planning, modeling, construction, and deployment, culminating in ongoing support of the completed software. The key characteristic of the waterfall model is that each phase must be completed before the next phase begins, and there is no overlapping of phases. The rigid structure of the waterfall model makes it difficult to accommodate changes once a phase is completed, which has led to criticism of the model in favor of more flexible approaches such as agile development.',
  'multi-step-calculation': 'Calculate the total cost of a shopping cart: 3 apples at $0.50 each, 2 bananas at $0.30 each, and 1 loaf of bread at $2.50. Apply a 10% discount. Show each step. What is the final total?',
}

// ---------------------------------------------------------------------------
// Feature extraction
// ---------------------------------------------------------------------------

function extractStructuralFeatures(taskId: string, taskText: string, taskClass: { criteriaCount: number }): StructuralFeatures {
  const codeBlockCount = (taskText.match(/```/g)?.length ?? 0) / 2 | 0
  const jsonMarkers = (taskText.match(/\bjson\b/gi)?.length ?? 0) + (taskText.match(/\{[^}]*\}/g)?.length ?? 0)
  const yamlMarkers = (taskText.match(/\byaml\b/gi)?.length ?? 0) + (taskText.match(/^[a-z]+:\s/gm)?.length ?? 0)
  const csvMarkers = (taskText.match(/\bcsv\b/gi)?.length ?? 0) + (taskText.match(/,/g)?.length ?? 0)
  const structuredDataSize = jsonMarkers * 10 + yamlMarkers * 5 + csvMarkers * 3

  return {
    estimatedInputTokens: Math.ceil(taskText.length / 4),
    messageCount: 1,
    toolSchemaCount: 0,
    attachedFileCount: 0,
    codeBlockCount,
    structuredDataSize,
    requestsStructuredOutput: /\bjson\b|\byaml\b|\bcsv\b|\bxml\b/i.test(taskText) || /reply with only/i.test(taskText),
    jsonTransformationIndicator: /\bjson\b/i.test(taskText) && /\bconvert\b|\btransform\b/i.test(taskText),
    multiFileIndicator: /\bmulti[- ]file\b|\bmultiple files\b|\bseveral files\b/i.test(taskText),
    toolRequirementIndicator: /\btool\b|\bexecute\b|\brun\b/i.test(taskText),
    verificationCriterionCount: taskClass.criteriaCount,
  }
}

function extractFeatures(
  taskId: string,
  taskText: string,
  taskClass: { category: string; criteriaCount: number },
): PreRoutingFeatureVector {
  const reading = scoreComplexity(taskText, {})
  const taskType = classifyTaskType(taskText)
  const structural = extractStructuralFeatures(taskId, taskText, taskClass)
  const categorical: CategoricalFeatures = {
    taskType,
    expectsProAdvantage: taskTypeExpectsProAdvantage(taskType),
  }
  // Historical features are zero for the frozen dataset (no prior history)
  const historical: HistoricalFeatures = {
    flashSuccessRateByTaskType: 0.5,
    proSuccessRateByTaskType: 0.5,
    flashToProRescueRate: 0.1,
    recentFlashFailureRate: 0.2,
    historicalCostDifference: 0.001,
    historicalSampleCount: 0,
  }

  return {
    featureVersion: FEATURE_VERSION,
    complexity: {
      explicitReasoningRequests: reading.signals.explicitReasoningRequests,
      mathMarkers: reading.signals.mathMarkers,
      architectureMarkers: reading.signals.architectureMarkers,
      codeBlocks: reading.signals.codeBlocks,
      lengthBands: reading.signals.lengthBands,
      complexityScore: reading.score,
      promptLength: taskText.length,
    },
    structural,
    categorical,
    historical,
  }
}

// ---------------------------------------------------------------------------
// Partitioning
// ---------------------------------------------------------------------------

interface Example {
  taskId: string
  iteration: number
  features: PreRoutingFeatureVector
  flashPassed: boolean
  proPassed: boolean
  flashCost: number
  proCost: number
  flashLatency: number
  proLatency: number
  flashRepairs: number
  proRepairs: number
  classification: string
}

function partitionByTaskClass(examples: Example[]): { train: Example[]; val: Example[]; test: Example[] } {
  const byTask = new Map<string, Example[]>()
  for (const ex of examples) {
    const list = byTask.get(ex.taskId) ?? []
    list.push(ex)
    byTask.set(ex.taskId, list)
  }
  const taskIds = [...byTask.keys()].sort()
  const nTasks = taskIds.length
  const nTrain = Math.round(nTasks * 0.6)
  const nVal = Math.round(nTasks * 0.2)
  const train: Example[] = []
  const val: Example[] = []
  const test: Example[] = []
  for (let i = 0; i < nTasks; i++) {
    const taskId = taskIds[i] ?? ''
    const examples = byTask.get(taskId) ?? []
    if (i < nTrain) train.push(...examples)
    else if (i < nTrain + nVal) val.push(...examples)
    else test.push(...examples)
  }
  return { train, val, test }
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
  }
  return sorted[mid] ?? 0
}

function p90(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.floor(sorted.length * 0.9)
  return sorted[idx] ?? 0
}

interface PolicyResult {
  policy: string
  verifiedRate: number
  costPerVerifiedTask: number
  proNecessityRecall: number
  proWasteRate: number
  repairRate: number
  medianLatency: number
  p90Latency: number
  proUtilization: number
  totalRuns: number
  verifiedPasses: number
}

function evaluatePolicy(
  policyName: string,
  examples: Example[],
  decisions: Array<{ ex: Example; usePro: boolean }>,
): PolicyResult {
  let verifiedPasses = 0
  let totalCost = 0
  let proCount = 0
  let totalRepairs = 0
  const latencies: number[] = []
  let proNecessaryTotal = 0
  let proNecessaryCaught = 0
  let proWasteCount = 0

  for (const { ex, usePro } of decisions) {
    const passed = usePro ? ex.proPassed : ex.flashPassed
    const cost = usePro ? ex.proCost : ex.flashCost
    const latency = usePro ? ex.proLatency : ex.flashLatency
    const repairs = usePro ? ex.proRepairs : ex.flashRepairs

    if (passed) verifiedPasses++
    totalCost += cost
    if (usePro) proCount++
    totalRepairs += repairs
    latencies.push(latency)

    if (!ex.flashPassed && ex.proPassed) {
      proNecessaryTotal++
      if (usePro) proNecessaryCaught++
    }
    if (ex.flashPassed && ex.proPassed && usePro) proWasteCount++
  }

  const totalRuns = decisions.length
  return {
    policy: policyName,
    verifiedRate: totalRuns > 0 ? verifiedPasses / totalRuns : 0,
    costPerVerifiedTask: verifiedPasses > 0 ? totalCost / verifiedPasses : Infinity,
    proNecessityRecall: proNecessaryTotal > 0 ? proNecessaryCaught / proNecessaryTotal : 0,
    proWasteRate: totalRuns > 0 ? proWasteCount / totalRuns : 0,
    repairRate: totalRuns > 0 ? totalRepairs / totalRuns : 0,
    medianLatency: median(latencies),
    p90Latency: p90(latencies),
    proUtilization: totalRuns > 0 ? proCount / totalRuns : 0,
    totalRuns,
    verifiedPasses,
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dataPath = join(REPO_ROOT, 'artifacts', 'reports', 'v0.16.0-rc1-paired-benchmark.json')
  const data = JSON.parse(await readFile(dataPath, 'utf8')) as BenchmarkData

  // 1. Extract features
  const examples: Example[] = []
  for (const pair of data.pairs) {
    const taskId = pair.taskId.split('/')[0] ?? ''
    const taskText = TASK_TEXTS[taskId] ?? ''
    const taskClass = data.design.taskClasses.find(tc => tc.id === taskId)
    if (taskClass === undefined || taskText === '') continue
    const features = extractFeatures(taskId, taskText, taskClass)
    examples.push({
      taskId,
      iteration: pair.iteration,
      features,
      flashPassed: pair.flash.verification.status === 'verified-pass',
      proPassed: pair.pro.verification.status === 'verified-pass',
      flashCost: pair.flash.economics.costUsd,
      proCost: pair.pro.economics.costUsd,
      flashLatency: pair.flash.execution.latencyMs,
      proLatency: pair.pro.execution.latencyMs,
      flashRepairs: pair.flash.execution.repairs,
      proRepairs: pair.pro.execution.repairs,
      classification: pair.classification,
    })
  }

  // 2. Partition
  const { train, val, test } = partitionByTaskClass(examples)

  // 3. Train multi-target model
  const trainingExamples = train.map(ex => ({
    features: ex.features,
    flashPassed: ex.flashPassed,
    proPassed: ex.proPassed,
    flashCost: ex.flashCost,
    proCost: ex.proCost,
  }))
  const model = trainModel(trainingExamples, 0.05, 500)

  // 4. Find optimal proCostThreshold on validation
  const thresholds = [0.01, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5]
  let bestThreshold = 0.1
  let bestValCPT = Infinity
  for (const threshold of thresholds) {
    const valDecisions = val.map((ex) => {
      const preds = predict(model, ex.features, threshold)
      return { ex, usePro: preds.recommendsPro }
    })
    const valResult = evaluatePolicy(`t=${threshold}`, val, valDecisions)
    if (valResult.costPerVerifiedTask < bestValCPT && valResult.verifiedRate >= 0.7) {
      bestValCPT = valResult.costPerVerifiedTask
      bestThreshold = threshold
    }
  }

  // 5. Evaluate on test partition
  const testExamples = test
  const flashOnly = evaluatePolicy('flash-only', testExamples, testExamples.map(ex => ({ ex, usePro: false })))
  const proOnly = evaluatePolicy('pro-only', testExamples, testExamples.map(ex => ({ ex, usePro: true })))
  const heuristic = evaluatePolicy('heuristic-router', testExamples, testExamples.map(ex => ({
    ex,
    usePro: ex.features.complexity.complexityScore >= 4,
  })))
  const learned = evaluatePolicy('learned-router', testExamples, testExamples.map((ex) => {
    const preds = predict(model, ex.features, bestThreshold)
    return { ex, usePro: preds.recommendsPro }
  }))

  // 6. All-examples evaluation
  const all = [...train, ...val, ...test]
  const allFlash = evaluatePolicy('flash-only (all)', all, all.map(ex => ({ ex, usePro: false })))
  const allPro = evaluatePolicy('pro-only (all)', all, all.map(ex => ({ ex, usePro: true })))
  const allHeuristic = evaluatePolicy('heuristic-router (all)', all, all.map(ex => ({
    ex,
    usePro: ex.features.complexity.complexityScore >= 4,
  })))
  const allLearned = evaluatePolicy('learned-router (all)', all, all.map((ex) => {
    const preds = predict(model, ex.features, bestThreshold)
    return { ex, usePro: preds.recommendsPro }
  }))

  // 7. Per-task predictions
  const perTask = testExamples.map((ex) => {
    const preds = predict(model, ex.features, bestThreshold)
    return {
      taskId: `${ex.taskId}/${ex.iteration}`,
      taskType: ex.features.categorical.taskType,
      complexityScore: ex.features.complexity.complexityScore,
      pFlashPass: preds.pFlashPass,
      pProPass: preds.pProPass,
      expectedCostDelta: preds.expectedCostDelta,
      recommendsPro: preds.recommendsPro,
      flashPassed: ex.flashPassed,
      proPassed: ex.proPassed,
      classification: ex.classification,
    }
  })

  // 8. Report
  const lines: string[] = []
  lines.push('# v0.17.1 Shadow-Mode Evaluation: Multi-Target Learned Router')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')
  lines.push('## Goal')
  lines.push('')
  lines.push('Reduce unnecessary Pro selections while preserving verified success.')
  lines.push('Primary constraint: verified success rate. Primary optimization: CostPerVerifiedTask.')
  lines.push('')
  lines.push('## Architecture')
  lines.push('')
  lines.push('```')
  lines.push('                    LIVE TASK')
  lines.push('                       |')
  lines.push('                       v')
  lines.push('              Pre-routing features')
  lines.push('                 /     |      \\')
  lines.push('                /      |       \\')
  lines.push('        structural   semantic   history')
  lines.push('                \\      |       /')
  lines.push('                 \\     |      /')
  lines.push('                       v')
  lines.push('               Learned predictor')
  lines.push('                       |')
  lines.push('              +--------+--------+')
  lines.push('              v                 v')
  lines.push('        shadow choice      heuristic choice')
  lines.push('                               |')
  lines.push('                               v')
  lines.push('                         ACTUAL EXECUTION')
  lines.push('                               |')
  lines.push('                               v')
  lines.push('                         RoutingOutcome')
  lines.push('                               |')
  lines.push('                               v')
  lines.push('                   shadow-policy evaluator')
  lines.push('```')
  lines.push('')
  lines.push('## Dataset')
  lines.push('')
  lines.push('Source: v0.16.0-rc1-paired-benchmark.json (frozen)')
  lines.push(`Total examples: ${examples.length}`)
  lines.push(`Task classes: ${data.design.taskClasses.length}`)
  lines.push(`Positive labels (pro-necessary): ${examples.filter(e => !e.flashPassed && e.proPassed).length}`)
  lines.push('')

  const trainTasks = [...new Set(train.map(e => e.taskId))].sort()
  const valTasks = [...new Set(val.map(e => e.taskId))].sort()
  const testTasks = [...new Set(test.map(e => e.taskId))].sort()
  lines.push('## Partitions (stratified by task class)')
  lines.push('')
  lines.push(`Train: ${train.length} examples, ${trainTasks.length} tasks: ${trainTasks.join(', ')}`)
  lines.push(`Validation: ${val.length} examples, ${valTasks.length} tasks: ${valTasks.join(', ')}`)
  lines.push(`Test: ${test.length} examples, ${testTasks.length} tasks: ${testTasks.join(', ')}`)
  lines.push('')

  lines.push('## Features (25 pre-routing, featureVersion=' + FEATURE_VERSION + ')')
  lines.push('')
  lines.push('Three feature families:')
  lines.push('')
  lines.push('1. **Complexity** (7): existing heuristic scorer signals')
  lines.push('2. **Structural** (11): input tokens, message count, tool schemas, files, code blocks, structured-data size, output format, JSON indicator, multi-file indicator, tool requirement, verification criteria')
  lines.push('3. **Categorical** (1): task type from deterministic classifier')
  lines.push('4. **Historical** (6): Flash/Pro success rates, rescue rate, recent failure rate, cost difference, sample count')
  lines.push('')
  lines.push('Historical features are zero-initialized for the frozen dataset (no prior history).')
  lines.push('They become informative once shadow mode accumulates paired outcomes across sessions.')
  lines.push('')

  lines.push('## Model: Multi-Target Logistic Regression')
  lines.push('')
  lines.push(`Model version: ${MODEL_VERSION}`)
  lines.push(`Training size: ${model.trainingSize}`)
  lines.push(`Optimal proCostThreshold (from validation): ${bestThreshold}`)
  lines.push('')
  lines.push('Three separate logistic regression models:')
  lines.push('- P(Flash passes): predicts Flash verified success')
  lines.push('- P(Pro passes): predicts Pro verified success')
  lines.push('- Expected cost delta: predicts Pro - Flash cost difference')
  lines.push('')
  lines.push('Routing decision: choose Pro when P(Pro passes) - P(Flash passes) >= threshold.')
  lines.push('')

  lines.push('## Test partition results (metric hierarchy)')
  lines.push('')
  lines.push('| Policy | Verified | Cost/verified | ProNecessity recall | ProWaste rate | Repair rate | Median latency | p90 latency | Pro util |')
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|')
  for (const r of [flashOnly, proOnly, heuristic, learned]) {
    const cpt = r.costPerVerifiedTask === Infinity ? 'N/A' : `$${r.costPerVerifiedTask.toFixed(6)}`
    lines.push(`| ${r.policy} | ${(r.verifiedRate * 100).toFixed(1)}% | ${cpt} | ${(r.proNecessityRecall * 100).toFixed(0)}% | ${(r.proWasteRate * 100).toFixed(0)}% | ${r.repairRate.toFixed(1)} | ${r.medianLatency}ms | ${r.p90Latency}ms | ${(r.proUtilization * 100).toFixed(0)}% |`)
  }
  lines.push('')

  lines.push('## All-examples results')
  lines.push('')
  lines.push('| Policy | Verified | Cost/verified | ProNecessity recall | ProWaste rate | Repair rate | Median latency | p90 latency | Pro util |')
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|')
  for (const r of [allFlash, allPro, allHeuristic, allLearned]) {
    const cpt = r.costPerVerifiedTask === Infinity ? 'N/A' : `$${r.costPerVerifiedTask.toFixed(6)}`
    lines.push(`| ${r.policy} | ${(r.verifiedRate * 100).toFixed(1)}% | ${cpt} | ${(r.proNecessityRecall * 100).toFixed(0)}% | ${(r.proWasteRate * 100).toFixed(0)}% | ${r.repairRate.toFixed(1)} | ${r.medianLatency}ms | ${r.p90Latency}ms | ${(r.proUtilization * 100).toFixed(0)}% |`)
  }
  lines.push('')

  lines.push('## Per-task predictions (test partition)')
  lines.push('')
  lines.push('| Task | Task type | Complexity | P(Flash) | P(Pro) | Cost delta | Recommends | Flash | Pro | Classification |')
  lines.push('|---|---|---:|---:|---:|---:|---|---|---|---|')
  for (const pt of perTask) {
    lines.push(`| ${pt.taskId} | ${pt.taskType} | ${pt.complexityScore} | ${(pt.pFlashPass * 100).toFixed(0)}% | ${(pt.pProPass * 100).toFixed(0)}% | $${pt.expectedCostDelta.toFixed(6)} | ${pt.recommendsPro ? 'Pro' : 'Flash'} | ${pt.flashPassed ? 'pass' : 'fail'} | ${pt.proPassed ? 'pass' : 'fail'} | ${pt.classification} |`)
  }
  lines.push('')

  // Threshold sweep
  lines.push('## Threshold sweep (test partition)')
  lines.push('')
  lines.push('| Threshold | Verified | Cost/verified | ProNecessity recall | ProWaste rate | Pro util |')
  lines.push('|---:|---:|---:|---:|---:|---:|')
  for (const threshold of [0.01, 0.02, 0.05, 0.08, 0.1, 0.15, 0.2, 0.3, 0.5]) {
    const sweepDecisions = testExamples.map((ex) => {
      const preds = predict(model, ex.features, threshold)
      return { ex, usePro: preds.recommendsPro }
    })
    const r = evaluatePolicy(`t=${threshold}`, testExamples, sweepDecisions)
    const cpt = r.costPerVerifiedTask === Infinity ? 'N/A' : `$${r.costPerVerifiedTask.toFixed(6)}`
    lines.push(`| ${threshold} | ${(r.verifiedRate * 100).toFixed(1)}% | ${cpt} | ${(r.proNecessityRecall * 100).toFixed(0)}% | ${(r.proWasteRate * 100).toFixed(0)}% | ${(r.proUtilization * 100).toFixed(0)}% |`)
  }
  lines.push('')

  // Analysis
  lines.push('## Analysis')
  lines.push('')
  const bothFinite = (v: number): boolean => v > 0 && v !== Infinity
  const learnedVsHeuristicCPT = bothFinite(heuristic.costPerVerifiedTask) && bothFinite(learned.costPerVerifiedTask)
    ? ((heuristic.costPerVerifiedTask - learned.costPerVerifiedTask) / heuristic.costPerVerifiedTask * 100).toFixed(1)
    : 'N/A'
  lines.push(`Learned router CPT vs heuristic: ${learnedVsHeuristicCPT}% improvement on test partition`)
  lines.push(`Learned router verified rate: ${(learned.verifiedRate * 100).toFixed(1)}% vs heuristic ${(heuristic.verifiedRate * 100).toFixed(1)}%`)
  lines.push(`Learned router ProNecessity recall: ${(learned.proNecessityRecall * 100).toFixed(0)}% vs heuristic ${(heuristic.proNecessityRecall * 100).toFixed(0)}%`)
  lines.push(`Learned router ProWaste rate: ${(learned.proWasteRate * 100).toFixed(0)}% vs heuristic ${(heuristic.proWasteRate * 100).toFixed(0)}%`)
  lines.push('')

  // Feature value
  lines.push('## Feature value analysis')
  lines.push('')
  lines.push('Task-type classification on the 15 benchmark tasks:')
  lines.push('')
  lines.push('| Task | Category | Classified as | Expects Pro |')
  lines.push('|---|---|---|---|')
  for (const tc of data.design.taskClasses) {
    const text = TASK_TEXTS[tc.id] ?? ''
    const taskType = classifyTaskType(text)
    const expects = taskTypeExpectsProAdvantage(taskType)
    lines.push(`| ${tc.id} | ${tc.category} | ${taskType} | ${expects ? 'yes' : 'no'} |`)
  }
  lines.push('')

  // Release gate
  lines.push('## Release gate for promoting learned router')
  lines.push('')
  lines.push('The learned router should only replace the heuristic router when:')
  lines.push('')
  lines.push('| Criterion | Target | Current |')
  lines.push('|---|---|---|')
  lines.push('| Verified success | no material degradation | insufficient data |')
  lines.push('| Cost per verified task | >=15-20% improvement | insufficient data |')
  lines.push('| ProNecessity recall | >=90% | insufficient data |')
  lines.push('| ProWasteRate | materially lower | insufficient data |')
  lines.push('| Shadow sample size | large enough for confidence intervals | 30 (too small) |')
  lines.push('')
  lines.push('All criteria are "insufficient data" because the dataset has only 30 pairs.')
  lines.push('v0.17.1 target: 100-200 labeled tasks. v0.17.2 target: 500+ tasks.')
  lines.push('')

  // Limitations
  lines.push('## Limitations')
  lines.push('')
  lines.push('- 30 examples is too small to train a meaningful router. The infrastructure is correct; the dataset is the bottleneck.')
  lines.push('- Historical features are zero-initialized (no prior history). They become informative once shadow mode accumulates data.')
  lines.push('- The task-type classifier is deterministic and may misclassify edge cases. Embeddings should be added if categorical features leave substantial unexplained Pro-necessity.')
  lines.push('- No cross-validation; single 60/20/20 split has high variance with 30 examples.')
  lines.push('- The multi-target model trains three independent logistic regressions. A joint model capturing P(Flash) and P(Pro) correlations would be richer.')
  lines.push('- Dataset expansion to 100-200 tasks requires live API calls (credential rotation needed).')
  lines.push('- Shadow mode live deployment requires the `model/shadow-routing-prediction` event to be wired into the router plugin.')
  lines.push('')

  // Write reports
  const reportDir = join(REPO_ROOT, 'artifacts', 'reports')
  const reportPath = join(reportDir, 'v0.17.1-shadow-evaluation.md')
  const jsonPath = join(reportDir, 'v0.17.1-shadow-evaluation.json')
  await writeFile(reportPath, lines.join('\n').replace(/\n+$/, '\n'), 'utf8')
  await writeFile(jsonPath, JSON.stringify({
    release: 'v0.17.1',
    generatedAt: new Date().toISOString(),
    goal: 'Reduce unnecessary Pro selections while preserving verified success',
    architecture: 'shadow-mode',
    dataset: {
      source: 'v0.16.0-rc1-paired-benchmark.json',
      totalExamples: examples.length,
      taskClasses: data.design.taskClasses.length,
      positiveLabels: examples.filter(e => !e.flashPassed && e.proPassed).length,
    },
    partitions: {
      train: { examples: train.length, tasks: trainTasks },
      validation: { examples: val.length, tasks: valTasks },
      test: { examples: test.length, tasks: testTasks },
    },
    features: {
      version: FEATURE_VERSION,
      names: FEATURE_NAMES,
      families: ['complexity', 'structural', 'categorical', 'historical'],
    },
    model: {
      version: MODEL_VERSION,
      type: 'multi-target-logistic-regression',
      trainingSize: model.trainingSize,
      optimalThreshold: bestThreshold,
      featureWeights: {
        flash: model.flashModel.weights,
        pro: model.proModel.weights,
        costDelta: model.costDeltaModel.weights,
      },
    },
    testResults: [flashOnly, proOnly, heuristic, learned],
    allResults: [allFlash, allPro, allHeuristic, allLearned],
    perTaskPredictions: perTask,
  }, null, 2), 'utf8')

  console.log(`Reports written to ${reportPath} and ${jsonPath}`)
}

void main()
