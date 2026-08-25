#!/usr/bin/env node
/**
 * v0.17.0 offline evaluation: learned Pro-necessity predictor vs heuristic router.
 *
 * Pipeline:
 *   1. Load v0.16.0 paired benchmark data (frozen dataset).
 *   2. Extract pre-routing features from each task using the existing complexity
 *      scorer (same features the heuristic router uses).
 *   3. Create learning labels from paired Flash/Pro outcomes:
 *        pro-necessary: Flash fails, Pro passes → label 1
 *        pro-waste: both pass, Pro more expensive → label 0
 *        both-fail: no benefit from either → label 0
 *        flash-better: Flash passes, Pro fails → label 0
 *   4. Partition by task class into train/validation/test (stratified).
 *   5. Train logistic regression on the training partition.
 *   6. Evaluate on the test partition:
 *        - CostPerVerifiedTask for learned router vs heuristic vs Flash-only vs Pro-only
 *        - ProNecessityRate, ProWasteRate
 *        - Verified success rate
 *   7. Report results.
 *
 * The learned router uses only features available before the routing decision,
 * preserving the invariant: featureSeq < routingDecisionSeq.
 *
 * No live API calls. This is a pure offline evaluation on the frozen dataset.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { scoreComplexity } from '@deepseek-ai/dsh-llm-model-router'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = join(__dirname, '..')

// ---------------------------------------------------------------------------
// Types
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

interface TaskFeatures {
  taskId: string
  category: string
  taskText: string
  features: {
    explicitReasoningRequests: number
    mathMarkers: number
    architectureMarkers: number
    codeBlocks: number
    lengthBands: number
    complexityScore: number
    promptLength: number
  }
}

interface LabeledExample {
  taskId: string
  category: string
  iteration: number
  features: TaskFeatures['features']
  label: number
  flashPass: boolean
  proPass: boolean
  flashCost: number
  proCost: number
  flashLatency: number
  proLatency: number
  classification: string
}

interface PolicyEvaluation {
  policy: string
  verifiedPasses: number
  totalRuns: number
  verifiedRate: number
  totalCost: number
  costPerVerifiedTask: number
  proUtilization: number
  meanLatency: number
  medianLatency: number
  proNecessityRecall: number
  proWasteRate: number
}

// ---------------------------------------------------------------------------
// Task text extraction (must match the benchmark's task definitions)
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

function extractFeatures(taskId: string, category: string): TaskFeatures {
  const taskText = TASK_TEXTS[taskId] ?? ''
  const reading = scoreComplexity(taskText, {})
  return {
    taskId,
    category,
    taskText,
    features: {
      explicitReasoningRequests: reading.signals.explicitReasoningRequests,
      mathMarkers: reading.signals.mathMarkers,
      architectureMarkers: reading.signals.architectureMarkers,
      codeBlocks: reading.signals.codeBlocks,
      lengthBands: reading.signals.lengthBands,
      complexityScore: reading.score,
      promptLength: taskText.length,
    },
  }
}

// ---------------------------------------------------------------------------
// Label generation from paired outcomes
// ---------------------------------------------------------------------------

function createLabel(pair: BenchmarkData['pairs'][number]): number {
  const flashPass = pair.flash.verification.status === 'verified-pass'
  const proPass = pair.pro.verification.status === 'verified-pass'
  // Label 1 only when Pro is necessary: Flash fails AND Pro passes
  if (!flashPass && proPass) return 1
  // All other cases: Pro is not necessary
  return 0
}

// ---------------------------------------------------------------------------
// Stratified train/validation/test partition by task class
// ---------------------------------------------------------------------------

interface Partitions {
  train: LabeledExample[]
  validation: LabeledExample[]
  test: LabeledExample[]
}

function partitionByTaskClass(examples: LabeledExample[]): Partitions {
  // Group by task ID
  const byTask = new Map<string, LabeledExample[]>()
  for (const ex of examples) {
    const list = byTask.get(ex.taskId) ?? []
    list.push(ex)
    byTask.set(ex.taskId, list)
  }

  const taskIds = [...byTask.keys()].sort()
  const train: LabeledExample[] = []
  const validation: LabeledExample[] = []
  const test: LabeledExample[] = []

  // Stratified split: 60% train, 20% validation, 20% test by task class
  // With 15 tasks: 9 train, 3 validation, 3 test
  const nTasks = taskIds.length
  const nTrain = Math.round(nTasks * 0.6)
  const nVal = Math.round(nTasks * 0.2)

  for (let i = 0; i < nTasks; i++) {
    const taskId = taskIds[i] ?? ''
    const examples = byTask.get(taskId) ?? []
    if (i < nTrain) train.push(...examples)
    else if (i < nTrain + nVal) validation.push(...examples)
    else test.push(...examples)
  }

  return { train, validation, test }
}

// ---------------------------------------------------------------------------
// Logistic regression (from scratch, no dependencies)
// ---------------------------------------------------------------------------

interface LogisticRegressionModel {
  weights: number[]
  bias: number
  featureNames: string[]
  learningRate: number
  iterations: number
  trainLoss: number[]
  valAccuracy: number
}

function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z))
  const expZ = Math.exp(z)
  return expZ / (1 + expZ)
}

function trainLogisticRegression(
  trainExamples: LabeledExample[],
  valExamples: LabeledExample[],
  featureNames: string[],
  learningRate: number,
  iterations: number,
): LogisticRegressionModel {
  const nFeatures = featureNames.length
  const weights = new Array(nFeatures).fill(0)
  let bias = 0
  const trainLoss: number[] = []

  // Standardize features
  const means = new Array(nFeatures).fill(0)
  const stds = new Array(nFeatures).fill(1)
  for (const ex of trainExamples) {
    for (let i = 0; i < nFeatures; i++) {
      means[i] += ex.features[featureNames[i] as keyof TaskFeatures['features']] ?? 0
    }
  }
  for (let i = 0; i < nFeatures; i++) means[i] /= trainExamples.length
  for (const ex of trainExamples) {
    for (let i = 0; i < nFeatures; i++) {
      const v = ex.features[featureNames[i] as keyof TaskFeatures['features']] ?? 0
      stds[i] += (v - means[i]) ** 2
    }
  }
  for (let i = 0; i < nFeatures; i++) stds[i] = Math.sqrt(stds[i] / trainExamples.length) || 1

  const standardize = (ex: LabeledExample): number[] => {
    return featureNames.map((name, i) => {
      const v = ex.features[name as keyof TaskFeatures['features']] ?? 0
      return (v - means[i]) / stds[i]
    })
  }

  for (let iter = 0; iter < iterations; iter++) {
    let epochLoss = 0
    const gradW = new Array(nFeatures).fill(0)
    let gradB = 0

    for (const ex of trainExamples) {
      const x = standardize(ex)
      const z = bias + weights.reduce((s, w, i) => s + w * (x[i] ?? 0), 0)
      const p = sigmoid(z)
      const y = ex.label
      const error = p - y
      for (let i = 0; i < nFeatures; i++) gradW[i] += error * (x[i] ?? 0)
      gradB += error
      epochLoss += -y * Math.log(p + 1e-10) - (1 - y) * Math.log(1 - p + 1e-10)
    }

    const n = trainExamples.length
    for (let i = 0; i < nFeatures; i++) weights[i] -= learningRate * (gradW[i] ?? 0) / n
    bias -= learningRate * gradB / n
    epochLoss /= n
    trainLoss.push(epochLoss)
  }

  // Validation accuracy
  let valCorrect = 0
  for (const ex of valExamples) {
    const x = standardize(ex)
    const z = bias + weights.reduce((s, w, i) => s + w * (x[i] ?? 0), 0)
    const p = sigmoid(z)
    const predicted = p >= 0.5 ? 1 : 0
    if (predicted === ex.label) valCorrect++
  }
  const valAccuracy = valExamples.length > 0 ? valCorrect / valExamples.length : 0

  return { weights, bias, featureNames, learningRate, iterations, trainLoss, valAccuracy }
}

function predictProNecessity(model: LogisticRegressionModel, features: TaskFeatures['features'], trainExamples: LabeledExample[]): number {
  const { featureNames, weights, bias } = model
  // Standardize using training statistics
  const means = new Array(featureNames.length).fill(0)
  const stds = new Array(featureNames.length).fill(1)
  for (const ex of trainExamples) {
    for (let i = 0; i < featureNames.length; i++) {
      means[i] += ex.features[featureNames[i] as keyof TaskFeatures['features']] ?? 0
    }
  }
  for (let i = 0; i < featureNames.length; i++) means[i] /= trainExamples.length
  for (const ex of trainExamples) {
    for (let i = 0; i < featureNames.length; i++) {
      const v = ex.features[featureNames[i] as keyof TaskFeatures['features']] ?? 0
      stds[i] += (v - means[i]) ** 2
    }
  }
  for (let i = 0; i < featureNames.length; i++) stds[i] = Math.sqrt(stds[i] / trainExamples.length) || 1

  const x = featureNames.map((name, i) => {
    const v = features[name as keyof TaskFeatures['features']] ?? 0
    return (v - means[i]) / stds[i]
  })
  const z = bias + weights.reduce((s, w, i) => s + w * (x[i] ?? 0), 0)
  return sigmoid(z)
}

// ---------------------------------------------------------------------------
// Policy evaluation on test partition
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

function evaluatePolicy(
  policyName: string,
  _testExamples: LabeledExample[],
  decisions: Array<{ example: LabeledExample; usePro: boolean }>,
): PolicyEvaluation {
  let verifiedPasses = 0
  let totalCost = 0
  let proCount = 0
  const latencies: number[] = []
  let proNecessaryCorrect = 0
  let proNecessaryTotal = 0
  let proWasteCount = 0

  for (const { example, usePro } of decisions) {
    const flashPass = example.flashPass
    const proPass = example.proPass
    const flashCost = example.flashCost
    const proCost = example.proCost
    const flashLatency = example.flashLatency
    const proLatency = example.proLatency

    const passed = usePro ? proPass : flashPass
    const cost = usePro ? proCost : flashCost
    const latency = usePro ? proLatency : flashLatency

    if (passed) verifiedPasses++
    totalCost += cost
    if (usePro) proCount++
    latencies.push(latency)

    // ProNecessity recall: how many pro-necessary cases did we catch?
    if (!flashPass && proPass) {
      proNecessaryTotal++
      if (usePro) proNecessaryCorrect++
    }
    // ProWaste: both pass but we used Pro
    if (flashPass && proPass && usePro) proWasteCount++
  }

  const totalRuns = decisions.length
  return {
    policy: policyName,
    verifiedPasses,
    totalRuns,
    verifiedRate: totalRuns > 0 ? verifiedPasses / totalRuns : 0,
    totalCost,
    costPerVerifiedTask: verifiedPasses > 0 ? totalCost / verifiedPasses : Infinity,
    proUtilization: totalRuns > 0 ? proCount / totalRuns : 0,
    meanLatency: latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
    medianLatency: median(latencies),
    proNecessityRecall: proNecessaryTotal > 0 ? proNecessaryCorrect / proNecessaryTotal : 0,
    proWasteRate: totalRuns > 0 ? proWasteCount / totalRuns : 0,
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const dataPath = join(REPO_ROOT, 'artifacts', 'reports', 'v0.16.0-rc1-paired-benchmark.json')
  const data = JSON.parse(await readFile(dataPath, 'utf8')) as BenchmarkData

  // 1. Extract features for each task
  const taskFeatures = new Map<string, TaskFeatures>()
  for (const taskClass of data.design.taskClasses) {
    taskFeatures.set(taskClass.id, extractFeatures(taskClass.id, taskClass.category))
  }

  // 2. Create labeled examples from pairs
  const examples: LabeledExample[] = []
  for (const pair of data.pairs) {
    const taskId = pair.taskId.split('/')[0] ?? ''
    const features = taskFeatures.get(taskId)
    if (features === undefined) continue
    const label = createLabel(pair)
    examples.push({
      taskId,
      category: features.category,
      iteration: pair.iteration,
      features: features.features,
      label,
      flashPass: pair.flash.verification.status === 'verified-pass',
      proPass: pair.pro.verification.status === 'verified-pass',
      flashCost: pair.flash.economics.costUsd,
      proCost: pair.pro.economics.costUsd,
      flashLatency: pair.flash.execution.latencyMs,
      proLatency: pair.pro.execution.latencyMs,
      classification: pair.classification,
    })
  }

  // 3. Partition by task class
  const partitions = partitionByTaskClass(examples)

  // 4. Train logistic regression
  const featureNames = [
    'explicitReasoningRequests',
    'mathMarkers',
    'architectureMarkers',
    'codeBlocks',
    'lengthBands',
    'complexityScore',
    'promptLength',
  ]

  const model = trainLogisticRegression(
    partitions.train,
    partitions.validation,
    featureNames,
    0.1,
    500,
  )

  // 5. Find optimal threshold on validation set
  const thresholds = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
  let bestThreshold = 0.5
  let bestValCPT = Infinity
  for (const threshold of thresholds) {
    const valDecisions = partitions.validation.map(ex => ({
      example: ex,
      usePro: predictProNecessity(model, ex.features, partitions.train) >= threshold,
    }))
    const valEval = evaluatePolicy(`learned-${threshold}`, partitions.validation, valDecisions)
    if (valEval.costPerVerifiedTask < bestValCPT && valEval.verifiedRate >= 0.7) {
      bestValCPT = valEval.costPerVerifiedTask
      bestThreshold = threshold
    }
  }

  // 6. Evaluate on test partition
  const testExamples = partitions.test

  // Policy A: Flash-only
  const flashOnlyDecisions = testExamples.map(ex => ({ example: ex, usePro: false }))
  const flashOnlyEval = evaluatePolicy('flash-only', testExamples, flashOnlyDecisions)

  // Policy B: Pro-only
  const proOnlyDecisions = testExamples.map(ex => ({ example: ex, usePro: true }))
  const proOnlyEval = evaluatePolicy('pro-only', testExamples, proOnlyDecisions)

  // Policy C: Heuristic router (complexity score >= threshold 4)
  const HEURISTIC_THRESHOLD = 4
  const heuristicDecisions = testExamples.map(ex => ({
    example: ex,
    usePro: ex.features.complexityScore >= HEURISTIC_THRESHOLD,
  }))
  const heuristicEval = evaluatePolicy('heuristic-router', testExamples, heuristicDecisions)

  // Policy D: Learned router (logistic regression with optimal threshold)
  const learnedDecisions = testExamples.map(ex => ({
    example: ex,
    usePro: predictProNecessity(model, ex.features, partitions.train) >= bestThreshold,
  }))
  const learnedEval = evaluatePolicy('learned-router', testExamples, learnedDecisions)

  // 7. Also evaluate on ALL examples (not just test) for comparison
  const allExamples = [...partitions.train, ...partitions.validation, ...partitions.test]
  const allFlashOnly = evaluatePolicy('flash-only (all)', allExamples, allExamples.map(ex => ({ example: ex, usePro: false })))
  const allProOnly = evaluatePolicy('pro-only (all)', allExamples, allExamples.map(ex => ({ example: ex, usePro: true })))
  const allHeuristic = evaluatePolicy('heuristic-router (all)', allExamples, allExamples.map(ex => ({
    example: ex,
    usePro: ex.features.complexityScore >= HEURISTIC_THRESHOLD,
  })))
  const allLearned = evaluatePolicy('learned-router (all)', allExamples, allExamples.map(ex => ({
    example: ex,
    usePro: predictProNecessity(model, ex.features, partitions.train) >= bestThreshold,
  })))

  // 8. Generate report
  const lines: string[] = []
  lines.push('# v0.17.0 Offline Evaluation: Learned Pro-Necessity Predictor')
  lines.push('')
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')
  lines.push('## Goal')
  lines.push('')
  lines.push('Reduce unnecessary Pro selections while preserving verified success.')
  lines.push('Core metric: CostPerVerifiedTask, subject to verified success not materially declining.')
  lines.push('')
  lines.push('## Dataset')
  lines.push('')
  lines.push('Source: v0.16.0-rc1-paired-benchmark.json (frozen)')
  lines.push(`Total examples: ${examples.length}`)
  lines.push(`Task classes: ${data.design.taskClasses.length}`)
  lines.push(`Positive labels (pro-necessary): ${examples.filter(e => e.label === 1).length}`)
  lines.push(`Negative labels (pro-not-necessary): ${examples.filter(e => e.label === 0).length}`)
  lines.push('')

  lines.push('## Partitions (stratified by task class)')
  lines.push('')
  const trainTasks = [...new Set(partitions.train.map(e => e.taskId))].sort()
  const valTasks = [...new Set(partitions.validation.map(e => e.taskId))].sort()
  const testTasks = [...new Set(partitions.test.map(e => e.taskId))].sort()
  lines.push(`Train: ${partitions.train.length} examples, ${trainTasks.length} tasks: ${trainTasks.join(', ')}`)
  lines.push(`Validation: ${partitions.validation.length} examples, ${valTasks.length} tasks: ${valTasks.join(', ')}`)
  lines.push(partExamples(testExamples, testTasks))
  lines.push('')

  lines.push('## Features (pre-routing, invariant: featureSeq < routingDecisionSeq)')
  lines.push('')
  lines.push('| Feature | Description |')
  lines.push('|---|---|')
  lines.push('| explicitReasoningRequests | Count of "think step by step", "reason deeply", etc. |')
  lines.push('| mathMarkers | Count of proof/theorem/derivation/equation markers |')
  lines.push('| architectureMarkers | Count of architecture/refactor/migration markers |')
  lines.push('| codeBlocks | Fenced code block count |')
  lines.push('| lengthBands | Prompt length in 800-char bands |')
  lines.push('| complexityScore | Capped weighted sum (heuristic router score) |')
  lines.push('| promptLength | Raw character count |')
  lines.push('')

  lines.push('## Model: Logistic Regression')
  lines.push('')
  lines.push(`Learning rate: ${model.learningRate}`)
  lines.push(`Iterations: ${model.iterations}`)
  lines.push(`Validation accuracy: ${(model.valAccuracy * 100).toFixed(1)}%`)
  lines.push(`Optimal threshold (from validation): ${bestThreshold}`)
  lines.push('')
  lines.push('| Feature | Weight |')
  lines.push('|---|---:|')
  for (let i = 0; i < model.featureNames.length; i++) {
    lines.push(`| ${model.featureNames[i] ?? ''} | ${(model.weights[i] ?? 0).toFixed(4)} |`)
  }
  lines.push(`| (bias) | ${model.bias.toFixed(4)} |`)
  lines.push('')

  lines.push('## Test partition results')
  lines.push('')
  lines.push('| Policy | Verified | Cost/verified | Pro util | ProNecessity recall | ProWaste rate | Median latency |')
  lines.push('|---|---:|---:|---:|---:|---:|---:|')
  for (const ev of [flashOnlyEval, proOnlyEval, heuristicEval, learnedEval]) {
    const cpt = ev.costPerVerifiedTask === Infinity ? 'N/A' : `$${ev.costPerVerifiedTask.toFixed(6)}`
    lines.push(`| ${ev.policy} | ${(ev.verifiedRate * 100).toFixed(1)}% | ${cpt} | ${(ev.proUtilization * 100).toFixed(0)}% | ${(ev.proNecessityRecall * 100).toFixed(0)}% | ${(ev.proWasteRate * 100).toFixed(0)}% | ${ev.medianLatency}ms |`)
  }
  lines.push('')

  lines.push('## All-examples results (train+val+test, for comparison with v0.16.0)')
  lines.push('')
  lines.push('| Policy | Verified | Cost/verified | Pro util | ProNecessity recall | ProWaste rate | Median latency |')
  lines.push('|---|---:|---:|---:|---:|---:|---:|')
  for (const ev of [allFlashOnly, allProOnly, allHeuristic, allLearned]) {
    const cpt = ev.costPerVerifiedTask === Infinity ? 'N/A' : `$${ev.costPerVerifiedTask.toFixed(6)}`
    lines.push(`| ${ev.policy} | ${(ev.verifiedRate * 100).toFixed(1)}% | ${cpt} | ${(ev.proUtilization * 100).toFixed(0)}% | ${(ev.proNecessityRecall * 100).toFixed(0)}% | ${(ev.proWasteRate * 100).toFixed(0)}% | ${ev.medianLatency}ms |`)
  }
  lines.push('')

  // Per-task predictions
  lines.push('## Per-task learned predictions (test partition)')
  lines.push('')
  lines.push('| Task | Category | Complexity score | P(Pro necessary) | Predicted | Actual label | Flash pass | Pro pass |')
  lines.push('|---|---|---:|---:|---|---|---|---|')
  for (const ex of testExamples) {
    const p = predictProNecessity(model, ex.features, partitions.train)
    const predicted = p >= bestThreshold ? 'Pro' : 'Flash'
    const actual = ex.label === 1 ? 'Pro' : 'Flash'
    lines.push(`| ${ex.taskId}/${ex.iteration} | ${ex.category} | ${ex.features.complexityScore} | ${(p * 100).toFixed(1)}% | ${predicted} | ${actual} | ${ex.flashPass ? 'pass' : 'fail'} | ${ex.proPass ? 'pass' : 'fail'} |`)
  }
  lines.push('')

  // Analysis
  lines.push('## Analysis')
  lines.push('')
  const learnedVsHeuristicCPT = heuristicEval.costPerVerifiedTask > 0 && learnedEval.costPerVerifiedTask > 0
    ? ((heuristicEval.costPerVerifiedTask - learnedEval.costPerVerifiedTask) / heuristicEval.costPerVerifiedTask * 100).toFixed(1)
    : 'N/A'
  lines.push(`Learned router CPT vs heuristic: ${learnedVsHeuristicCPT}% improvement on test partition`)
  lines.push(`Learned router verified rate: ${(learnedEval.verifiedRate * 100).toFixed(1)}% vs heuristic ${(heuristicEval.verifiedRate * 100).toFixed(1)}%`)
  lines.push(`Learned router ProNecessity recall: ${(learnedEval.proNecessityRecall * 100).toFixed(0)}% vs heuristic ${(heuristicEval.proNecessityRecall * 100).toFixed(0)}%`)
  lines.push(`Learned router ProWaste rate: ${(learnedEval.proWasteRate * 100).toFixed(0)}% vs heuristic ${(heuristicEval.proWasteRate * 100).toFixed(0)}%`)
  lines.push('')

  // Threshold sweep on test partition
  lines.push('## Threshold sweep (test partition)')
  lines.push('')
  lines.push('| Threshold | Verified | Cost/verified | Pro util | ProNecessity recall | ProWaste rate |')
  lines.push('|---:|---:|---:|---:|---:|---:|')
  for (const threshold of [0.01, 0.05, 0.08, 0.1, 0.15, 0.2, 0.3, 0.5]) {
    const sweepDecisions = testExamples.map(ex => ({
      example: ex,
      usePro: predictProNecessity(model, ex.features, partitions.train) >= threshold,
    }))
    const sweepEval = evaluatePolicy(`t=${threshold}`, testExamples, sweepDecisions)
    const cpt = sweepEval.costPerVerifiedTask === Infinity ? 'N/A' : `$${sweepEval.costPerVerifiedTask.toFixed(6)}`
    lines.push(`| ${threshold} | ${(sweepEval.verifiedRate * 100).toFixed(1)}% | ${cpt} | ${(sweepEval.proUtilization * 100).toFixed(0)}% | ${(sweepEval.proNecessityRecall * 100).toFixed(0)}% | ${(sweepEval.proWasteRate * 100).toFixed(0)}% |`)
  }
  lines.push('')

  // Delta-U analysis
  lines.push('## Delta-U utility analysis')
  lines.push('')
  lines.push('Utility = verifiedPass ? 1 : 0, adjusted for cost.')
  lines.push('Delta-U = U_Pro - U_Flash (positive means Pro provides more value).')
  lines.push('')
  lines.push('| Task | Flash pass | Pro pass | Flash cost | Pro cost | Delta-U (verified) | Delta-cost | Net benefit |')
  lines.push('|---|---|---|---:|---:|---|---:|---|')
  for (const ex of allExamples) {
    const uFlash = ex.flashPass ? 1 : 0
    const uPro = ex.proPass ? 1 : 0
    const deltaU = uPro - uFlash
    const deltaCost = ex.proCost - ex.flashCost
    const netBenefit = deltaU > 0 ? `+${deltaU} verified, +$${deltaCost.toFixed(6)} cost` : deltaU < 0 ? `${deltaU} verified, +$${deltaCost.toFixed(6)} cost` : `0 verified, +$${deltaCost.toFixed(6)} cost`
    lines.push(`| ${ex.taskId}/${ex.iteration} | ${ex.flashPass ? 'pass' : 'fail'} | ${ex.proPass ? 'pass' : 'fail'} | $${ex.flashCost.toFixed(6)} | $${ex.proCost.toFixed(6)} | ${deltaU > 0 ? '+' : ''}${deltaU} | $${deltaCost.toFixed(6)} | ${netBenefit} |`)
  }
  lines.push('')

  // Limitations
  lines.push('## Limitations')
  lines.push('')
  lines.push('- 30 examples total (15 task classes x 2 iterations) is a very small dataset.')
  lines.push('- Train/test split by task class means the test partition has only 3 task classes.')
  lines.push('- Logistic regression on 7 features may overfit or underfit with this sample size.')
  lines.push('- The learning label (pro-necessary = Flash fail AND Pro pass) is binary; a utility-based')
  lines.push('  delta-U label capturing cost/latency tradeoffs would be richer.')
  lines.push('- No cross-validation; a single train/val/test split has high variance with 30 examples.')
  lines.push('- The heuristic router also has mid-turn escalation and step-retention logic not modeled here.')
  lines.push('- This is offline evaluation only; no live runs. v0.17.1 should run shadow mode.')
  lines.push('')

  // Write reports
  const reportDir = join(REPO_ROOT, 'artifacts', 'reports')
  const reportPath = join(reportDir, 'v0.17.0-offline-evaluation.md')
  const jsonPath = join(reportDir, 'v0.17.0-offline-evaluation.json')
  await writeFile(reportPath, lines.join('\n').replace(/\n+$/, '\n'), 'utf8')
  await writeFile(jsonPath, JSON.stringify({
    release: 'v0.17.0',
    generatedAt: new Date().toISOString(),
    goal: 'Reduce unnecessary Pro selections while preserving verified success',
    dataset: {
      source: 'v0.16.0-rc1-paired-benchmark.json',
      totalExamples: examples.length,
      taskClasses: data.design.taskClasses.length,
      positiveLabels: examples.filter(e => e.label === 1).length,
      negativeLabels: examples.filter(e => e.label === 0).length,
    },
    partitions: {
      train: { examples: partitions.train.length, tasks: trainTasks },
      validation: { examples: partitions.validation.length, tasks: valTasks },
      test: { examples: partitions.test.length, tasks: testTasks },
    },
    features: featureNames,
    model: {
      type: 'logistic-regression',
      learningRate: model.learningRate,
      iterations: model.iterations,
      valAccuracy: model.valAccuracy,
      optimalThreshold: bestThreshold,
      weights: model.weights,
      bias: model.bias,
      trainLoss: model.trainLoss,
    },
    testResults: [flashOnlyEval, proOnlyEval, heuristicEval, learnedEval],
    allResults: [allFlashOnly, allProOnly, allHeuristic, allLearned],
    perTaskPredictions: testExamples.map(ex => ({
      taskId: `${ex.taskId}/${ex.iteration}`,
      category: ex.category,
      complexityScore: ex.features.complexityScore,
      proNecessityProbability: predictProNecessity(model, ex.features, partitions.train),
      predicted: predictProNecessity(model, ex.features, partitions.train) >= bestThreshold ? 'Pro' : 'Flash',
      actualLabel: ex.label,
      flashPass: ex.flashPass,
      proPass: ex.proPass,
    })),
  }, null, 2), 'utf8')

  console.log(`Reports written to ${reportPath} and ${jsonPath}`)
}

function partExamples(testExamples: LabeledExample[], testTasks: string[]): string {
  return `Test: ${testExamples.length} examples, ${testTasks.length} tasks: ${testTasks.join(', ')}`
}

void main()
