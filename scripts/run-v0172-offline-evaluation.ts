#!/usr/bin/env node
/**
 * Evaluates the multi-target shadow router on the 100-pair v0.17.2 dataset.
 * Task classes never cross partitions, and historical features use outcomes
 * recorded before the example being scored.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FEATURE_NAMES,
  FEATURE_VERSION,
  MODEL_VERSION,
  classifyTaskType,
  predict,
  scoreComplexity,
  taskTypeExpectsProAdvantage,
  trainModel,
} from '@deepseek-ai/dsh-llm-model-router'
import type {
  HistoricalFeatures,
  PreRoutingFeatureVector,
  StructuralFeatures,
  TaskType,
  TrainingExample,
  TrainedModel,
} from '@deepseek-ai/dsh-llm-model-router'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const DATA_PATH = join(REPO_ROOT, 'artifacts', 'reports', 'v0.17.2-expanded-benchmark.json')
const JSON_PATH = join(REPO_ROOT, 'artifacts', 'reports', 'v0.17.2-offline-evaluation.json')
const MARKDOWN_PATH = join(REPO_ROOT, 'artifacts', 'reports', 'v0.17.2-offline-evaluation.md')
const DATASET_ID = 'paired-v4-100-v1'

interface BenchmarkRun {
  taskId: string
  category: string
  model: string
  iteration: number
  cacheState: string
  cache: { hitTokens: number; missTokens: number; hitRate: number }
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number; totalTokens: number }
  economics: { costUsd: number; pricingVersion: string }
  execution: { latencyMs: number; attempts: number; toolCalls: number; toolFailures: number; repairs: number }
  verification: { status: string; criteriaPassed: number; criteriaTotal: number }
  output: string
  error?: string
}

interface BenchmarkPair {
  taskId: string
  iteration: number
  cacheState: string
  flash: BenchmarkRun
  pro: BenchmarkRun
  classification: string
  cacheComparable: boolean
}

interface TaskDesign {
  id: string
  category: string
  description: string
  task: string
  expectsProAdvantage: boolean
  criteriaCount: number
}

interface BenchmarkData {
  release: string
  generatedAt: string
  design: {
    taskClasses: TaskDesign[]
    iterations: number
    pairedExamples: number
  }
  pairs: BenchmarkPair[]
}

interface BaseExample {
  taskId: string
  category: string
  taskText: string
  iteration: number
  criteriaCount: number
  flashPassed: boolean
  proPassed: boolean
  flashCost: number
  proCost: number
  flashLatency: number
  proLatency: number
  flashRepairs: number
  proRepairs: number
  classification: string
  taskType: TaskType
}

interface Example extends BaseExample {
  features: PreRoutingFeatureVector
}

type PartitionName = 'train' | 'validation' | 'test'

interface Partition {
  name: PartitionName
  taskIds: string[]
  examples: Example[]
}

interface HistoryRecord {
  taskType: TaskType
  flashPassed: boolean
  proPassed: boolean
  flashCost: number
  proCost: number
}

interface PolicyResult {
  policy: string
  examples: number
  verifiedPasses: number
  verifiedRate: number
  verifiedRate95: [number, number]
  totalCost: number
  costPerVerifiedTask: number
  proNecessary: number
  proNecessaryCaught: number
  proNecessityRecall: number
  proNecessityRecall95: [number, number]
  proWasteCount: number
  proWasteRate: number
  repairRate: number
  medianLatency: number
  p90Latency: number
  proUtilization: number
}

interface PredictionRow {
  taskId: string
  category: string
  taskType: TaskType
  iteration: number
  pFlashPass: number
  pProPass: number
  expectedCostDelta: number
  verifiedImprovement: number
  shadowModel: 'Flash' | 'Pro'
  actualClass: string
}

function wilson(successes: number, total: number): [number, number] {
  if (total === 0) return [0, 0]
  const z = 1.96
  const proportion = successes / total
  const denominator = 1 + z ** 2 / total
  const center = (proportion + z ** 2 / (2 * total)) / denominator
  const margin = z * Math.sqrt((proportion * (1 - proportion) + z ** 2 / (4 * total)) / total) / denominator
  return [Math.max(0, center - margin), Math.min(1, center + margin)]
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0)
}

function p90(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(Math.ceil(sorted.length * 0.9) - 1, sorted.length - 1)] ?? 0
}

function structuralFeatures(text: string, criteriaCount: number): StructuralFeatures {
  const codeBlockCount = Math.floor((text.match(/```/g)?.length ?? 0) / 2)
  const structuredMatches = text.match(/\bJSON\b|\bYAML\b|\bCSV\b|\bXML\b|[{}[\],]|^[a-zA-Z_]+:/gm) ?? []
  const fileReferences = text.match(/(?:^|\s)[\w./-]+\.(?:ts|tsx|js|jsx|py|json|yaml|yml|md|txt)\b/g) ?? []
  return {
    estimatedInputTokens: Math.ceil(text.length / 4),
    messageCount: 1,
    toolSchemaCount: 0,
    attachedFileCount: fileReferences.length,
    codeBlockCount,
    structuredDataSize: structuredMatches.join('').length,
    requestsStructuredOutput: /reply with only|exactly|JSON|YAML|CSV|XML|Markdown table|numbered|bullet/i.test(text),
    jsonTransformationIndicator: /\b(?:convert|transform|return)\b[\s\S]*\bJSON\b/i.test(text),
    multiFileIndicator: fileReferences.length > 1 || /multiple files|multi-file/i.test(text),
    toolRequirementIndicator: /\b(?:use|run|execute)\s+(?:a\s+)?(?:tool|command|test)/i.test(text),
    verificationCriterionCount: criteriaCount,
  }
}

function historicalFeatures(history: HistoryRecord[], taskType: TaskType): HistoricalFeatures {
  const sameType = history.filter(record => record.taskType === taskType)
  const recent = history.slice(-20)
  const flashPasses = sameType.filter(record => record.flashPassed).length
  const proPasses = sameType.filter(record => record.proPassed).length
  const rescues = sameType.filter(record => !record.flashPassed && record.proPassed).length
  return {
    flashSuccessRateByTaskType: sameType.length === 0 ? 0.5 : flashPasses / sameType.length,
    proSuccessRateByTaskType: sameType.length === 0 ? 0.5 : proPasses / sameType.length,
    flashToProRescueRate: sameType.length === 0 ? 0 : rescues / sameType.length,
    recentFlashFailureRate: recent.length === 0
      ? 0
      : recent.filter(record => !record.flashPassed).length / recent.length,
    historicalCostDifference: sameType.length === 0
      ? 0
      : sameType.reduce((sum, record) => sum + record.proCost - record.flashCost, 0) / sameType.length,
    historicalSampleCount: sameType.length,
  }
}

function featureVector(example: BaseExample, history: HistoryRecord[]): PreRoutingFeatureVector {
  const reading = scoreComplexity(example.taskText, {})
  return {
    featureVersion: FEATURE_VERSION,
    complexity: {
      explicitReasoningRequests: reading.signals.explicitReasoningRequests,
      mathMarkers: reading.signals.mathMarkers,
      architectureMarkers: reading.signals.architectureMarkers,
      codeBlocks: reading.signals.codeBlocks,
      lengthBands: reading.signals.lengthBands,
      complexityScore: reading.score,
      promptLength: example.taskText.length,
    },
    structural: structuralFeatures(example.taskText, example.criteriaCount),
    categorical: {
      taskType: example.taskType,
      expectsProAdvantage: taskTypeExpectsProAdvantage(example.taskType),
    },
    historical: historicalFeatures(history, example.taskType),
  }
}

function historyRecord(example: BaseExample): HistoryRecord {
  return {
    taskType: example.taskType,
    flashPassed: example.flashPassed,
    proPassed: example.proPassed,
    flashCost: example.flashCost,
    proCost: example.proCost,
  }
}

function partitionTasks(base: BaseExample[]): Record<PartitionName, string[]> {
  const taskInfo = new Map<string, { category: string; positive: boolean }>()
  for (const example of base) {
    const current = taskInfo.get(example.taskId)
    taskInfo.set(example.taskId, {
      category: example.category,
      positive: (current?.positive ?? false) || (!example.flashPassed && example.proPassed),
    })
  }

  const result: Record<PartitionName, string[]> = { train: [], validation: [], test: [] }
  const categories = [...new Set([...taskInfo.values()].map(info => info.category))].sort()
  for (const category of categories) {
    const taskIds = [...taskInfo.entries()]
      .filter(([, info]) => info.category === category)
      .map(([taskId]) => taskId)
      .sort()
    const validationCount = Math.max(1, Math.floor(taskIds.length * 0.2))
    const testCount = Math.max(1, Math.floor(taskIds.length * 0.2))
    const trainCount = taskIds.length - validationCount - testCount
    result.train.push(...taskIds.slice(0, trainCount))
    result.validation.push(...taskIds.slice(trainCount, trainCount + validationCount))
    result.test.push(...taskIds.slice(trainCount + validationCount))
  }

  const hasPositive = (partition: PartitionName): boolean => result[partition].some(taskId => taskInfo.get(taskId)?.positive)
  for (const destination of ['validation', 'test'] as const) {
    if (hasPositive(destination)) continue
    const sourceTask = result.train.find(taskId => taskInfo.get(taskId)?.positive)
    if (sourceTask === undefined) continue
    const category = taskInfo.get(sourceTask)?.category
    const destinationTask = result[destination].find(taskId => taskInfo.get(taskId)?.category === category)
    if (destinationTask === undefined) continue
    result.train = result.train.filter(taskId => taskId !== sourceTask)
    result[destination] = result[destination].filter(taskId => taskId !== destinationTask)
    result.train.push(destinationTask)
    result[destination].push(sourceTask)
  }

  for (const partition of Object.values(result)) partition.sort()
  return result
}

function materializePartition(
  name: PartitionName,
  taskIds: string[],
  base: BaseExample[],
  priorHistory: HistoryRecord[],
): { partition: Partition; history: HistoryRecord[] } {
  const history = [...priorHistory]
  const examples: Example[] = []
  const selected = base
    .filter(example => taskIds.includes(example.taskId))
    .sort((left, right) => left.taskId.localeCompare(right.taskId) || left.iteration - right.iteration)
  for (const example of selected) {
    examples.push({ ...example, features: featureVector(example, history) })
    history.push(historyRecord(example))
  }
  return { partition: { name, taskIds, examples }, history }
}

function evaluate(
  policy: string,
  examples: Example[],
  choosePro: (example: Example) => boolean,
): PolicyResult {
  let verifiedPasses = 0
  let totalCost = 0
  let proNecessary = 0
  let proNecessaryCaught = 0
  let proWasteCount = 0
  let proCount = 0
  let repairs = 0
  const latencies: number[] = []

  for (const example of examples) {
    const usePro = choosePro(example)
    const passed = usePro ? example.proPassed : example.flashPassed
    if (passed) verifiedPasses++
    totalCost += usePro ? example.proCost : example.flashCost
    repairs += usePro ? example.proRepairs : example.flashRepairs
    latencies.push(usePro ? example.proLatency : example.flashLatency)
    if (usePro) proCount++
    if (!example.flashPassed && example.proPassed) {
      proNecessary++
      if (usePro) proNecessaryCaught++
    }
    if (usePro && example.flashPassed && example.proPassed) proWasteCount++
  }

  return {
    policy,
    examples: examples.length,
    verifiedPasses,
    verifiedRate: examples.length === 0 ? 0 : verifiedPasses / examples.length,
    verifiedRate95: wilson(verifiedPasses, examples.length),
    totalCost,
    costPerVerifiedTask: verifiedPasses === 0 ? Infinity : totalCost / verifiedPasses,
    proNecessary,
    proNecessaryCaught,
    proNecessityRecall: proNecessary === 0 ? 0 : proNecessaryCaught / proNecessary,
    proNecessityRecall95: wilson(proNecessaryCaught, proNecessary),
    proWasteCount,
    proWasteRate: examples.length === 0 ? 0 : proWasteCount / examples.length,
    repairRate: examples.length === 0 ? 0 : repairs / examples.length,
    medianLatency: median(latencies),
    p90Latency: p90(latencies),
    proUtilization: examples.length === 0 ? 0 : proCount / examples.length,
  }
}

function selectThreshold(model: TrainedModel, validation: Example[]): {
  threshold: number
  sweep: PolicyResult[]
  baseline: PolicyResult
  constraintsMet: boolean
} {
  const thresholds = [0, 0.01, 0.02, 0.05, 0.08, 0.1, 0.15, 0.2, 0.3, 0.5]
  const baseline = evaluate('heuristic-router', validation, example => example.features.complexity.complexityScore >= 4)
  const sweep = thresholds.map(threshold => evaluate(
    `learned-${threshold}`,
    validation,
    example => predict(model, example.features, threshold).recommendsPro,
  ))
  const eligible = sweep.filter(result =>
    result.verifiedRate >= baseline.verifiedRate
    && (result.proNecessary === 0 || result.proNecessityRecall >= 0.9),
  )
  const candidates = eligible.length > 0 ? eligible : sweep
  const selected = [...candidates].sort((left, right) =>
    right.proNecessityRecall - left.proNecessityRecall
    || right.verifiedRate - left.verifiedRate
    || left.costPerVerifiedTask - right.costPerVerifiedTask
    || left.proUtilization - right.proUtilization,
  )[0]
  return {
    threshold: Number(selected?.policy.replace('learned-', '') ?? 0.1),
    sweep,
    baseline,
    constraintsMet: eligible.length > 0,
  }
}

function resultRow(result: PolicyResult): string {
  const cost = result.costPerVerifiedTask === Infinity ? 'N/A' : `$${result.costPerVerifiedTask.toFixed(6)}`
  const verifiedInterval = `${(result.verifiedRate95[0] * 100).toFixed(1)}-${(result.verifiedRate95[1] * 100).toFixed(1)}%`
  const recallInterval = result.proNecessary === 0
    ? 'N/A'
    : `${(result.proNecessityRecall95[0] * 100).toFixed(1)}-${(result.proNecessityRecall95[1] * 100).toFixed(1)}%`
  return `| ${result.policy} | ${(result.verifiedRate * 100).toFixed(1)}% | ${verifiedInterval} | ${cost} | ${(result.proNecessityRecall * 100).toFixed(0)}% | ${recallInterval} | ${(result.proWasteRate * 100).toFixed(1)}% | ${(result.proUtilization * 100).toFixed(1)}% | ${result.medianLatency.toFixed(0)}ms | ${result.p90Latency.toFixed(0)}ms |`
}

async function main(): Promise<void> {
  const data = JSON.parse(await readFile(DATA_PATH, 'utf8')) as BenchmarkData
  const designs = new Map(data.design.taskClasses.map(task => [task.id, task]))
  const base: BaseExample[] = data.pairs.map((pair) => {
    const taskId = pair.taskId.replace(/\/\d+$/, '')
    const design = designs.get(taskId)
    if (design === undefined) throw new Error(`Missing task design for ${taskId}`)
    return {
      taskId,
      category: design.category,
      taskText: design.task,
      iteration: pair.iteration,
      criteriaCount: design.criteriaCount,
      flashPassed: pair.flash.verification.status === 'verified-pass',
      proPassed: pair.pro.verification.status === 'verified-pass',
      flashCost: pair.flash.economics.costUsd,
      proCost: pair.pro.economics.costUsd,
      flashLatency: pair.flash.execution.latencyMs,
      proLatency: pair.pro.execution.latencyMs,
      flashRepairs: pair.flash.execution.repairs,
      proRepairs: pair.pro.execution.repairs,
      classification: pair.classification,
      taskType: classifyTaskType(design.task),
    }
  })

  const taskPartitions = partitionTasks(base)
  const trainMaterialized = materializePartition('train', taskPartitions.train, base, [])
  const validationMaterialized = materializePartition(
    'validation',
    taskPartitions.validation,
    base,
    trainMaterialized.history,
  )
  const testMaterialized = materializePartition(
    'test',
    taskPartitions.test,
    base,
    validationMaterialized.history,
  )
  const train = trainMaterialized.partition
  const validation = validationMaterialized.partition
  const test = testMaterialized.partition

  const trainingExamples: TrainingExample[] = train.examples.map(example => ({
    features: example.features,
    flashPassed: example.flashPassed,
    proPassed: example.proPassed,
    flashCost: example.flashCost,
    proCost: example.proCost,
  }))
  const model = trainModel(trainingExamples, 0.03, 1_500)
  const selection = selectThreshold(model, validation.examples)

  const testResults = [
    evaluate('flash-only', test.examples, () => false),
    evaluate('pro-only', test.examples, () => true),
    evaluate('heuristic-router', test.examples, example => example.features.complexity.complexityScore >= 4),
    evaluate('learned-router', test.examples, example => predict(model, example.features, selection.threshold).recommendsPro),
  ]
  const allExamples = [...train.examples, ...validation.examples, ...test.examples]
  const diagnosticResults = [
    evaluate('flash-only', allExamples, () => false),
    evaluate('pro-only', allExamples, () => true),
    evaluate('heuristic-router', allExamples, example => example.features.complexity.complexityScore >= 4),
    evaluate('learned-router', allExamples, example => predict(model, example.features, selection.threshold).recommendsPro),
  ]
  const predictions: PredictionRow[] = test.examples.map((example) => {
    const prediction = predict(model, example.features, selection.threshold)
    return {
      taskId: example.taskId,
      category: example.category,
      taskType: example.taskType,
      iteration: example.iteration,
      pFlashPass: prediction.pFlashPass,
      pProPass: prediction.pProPass,
      expectedCostDelta: prediction.expectedCostDelta,
      verifiedImprovement: prediction.pProPass - prediction.pFlashPass,
      shadowModel: prediction.recommendsPro ? 'Pro' : 'Flash',
      actualClass: example.classification,
    }
  })

  const output = {
    release: 'v0.17.2',
    generatedAt: new Date().toISOString(),
    source: 'v0.17.2-expanded-benchmark.json',
    dataset: {
      id: DATASET_ID,
      examples: base.length,
      taskClasses: designs.size,
      proNecessary: base.filter(example => !example.flashPassed && example.proPassed).length,
      flashBetter: base.filter(example => example.flashPassed && !example.proPassed).length,
      bothFail: base.filter(example => !example.flashPassed && !example.proPassed).length,
    },
    partitions: {
      train: { tasks: train.taskIds, examples: train.examples.length },
      validation: { tasks: validation.taskIds, examples: validation.examples.length },
      test: { tasks: test.taskIds, examples: test.examples.length },
    },
    features: { version: FEATURE_VERSION, names: FEATURE_NAMES },
    model: {
      version: MODEL_VERSION,
      type: 'two-logistic-one-linear',
      trainingExamples: model.trainingSize,
      selectedThreshold: selection.threshold,
      validationConstraintsMet: selection.constraintsMet,
      standardization: { means: model.means, stds: model.stds },
      coefficients: {
        flashPass: model.flashModel,
        proPass: model.proModel,
        costDelta: model.costDeltaModel,
      },
    },
    validation: { baseline: selection.baseline, sweep: selection.sweep },
    testResults,
    diagnosticAllExampleResults: diagnosticResults,
    predictions,
  }
  await writeFile(JSON_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8')

  const lines: string[] = [
    '# v0.17.2 Expanded Offline Learned-Router Evaluation',
    '',
    `Generated: ${output.generatedAt}`,
    '',
    '## Dataset',
    '',
    `- 100 paired examples across 50 task classes; 200 live provider calls and ${data.pairs.filter(pair => pair.flash.error !== undefined || pair.pro.error !== undefined).length} provider errors.`,
    '- 6 Pro-necessary examples, 4 Flash-better examples, and 3 both-fail examples.',
    '- Hard cases are deliberately overrepresented; the sample is a benchmark, not a production prevalence estimate.',
    '',
    '## Leakage controls',
    '',
    '- Task classes never cross train, validation, and test partitions.',
    '- Partitions preserve category coverage and include Pro-necessary examples in validation and test.',
    '- Historical features for an example use completed earlier examples only.',
    '- Validation threshold selection never reads test outcomes.',
    '- All model inputs are available before routing.',
    '',
    '## Partitions',
    '',
    '| Partition | Tasks | Examples | Pro-necessary |',
    '|---|---:|---:|---:|',
  ]
  for (const partition of [train, validation, test]) {
    const positives = partition.examples.filter(example => !example.flashPassed && example.proPassed).length
    lines.push(`| ${partition.name} | ${partition.taskIds.length} | ${partition.examples.length} | ${positives} |`)
  }
  lines.push(
    '',
    '## Model',
    '',
    `- Model version ${MODEL_VERSION}: logistic P(Flash passes), logistic P(Pro passes), and linear expected cost delta.`,
    `- ${FEATURE_NAMES.length} pre-routing features across complexity, structural, categorical, and historical families.`,
    `- Validation-selected verified-improvement threshold: ${selection.threshold}.`,
    `- Validation success-and-recall constraints met: ${selection.constraintsMet ? 'yes' : 'no'}.`,
    '',
    '## Held-out test results',
    '',
    '| Policy | Verified | Verified 95% CI | Cost/verified | ProNecessity recall | Recall 95% CI | ProWaste | Pro util | Median latency | p90 latency |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  )
  for (const result of testResults) lines.push(resultRow(result))
  lines.push(
    '',
    '## Validation threshold sweep',
    '',
    '| Threshold | Verified | Cost/verified | ProNecessity recall | ProWaste | Pro util |',
    '|---:|---:|---:|---:|---:|---:|',
  )
  for (const result of selection.sweep) {
    const threshold = result.policy.replace('learned-', '')
    const cost = result.costPerVerifiedTask === Infinity ? 'N/A' : `$${result.costPerVerifiedTask.toFixed(6)}`
    lines.push(`| ${threshold} | ${(result.verifiedRate * 100).toFixed(1)}% | ${cost} | ${(result.proNecessityRecall * 100).toFixed(0)}% | ${(result.proWasteRate * 100).toFixed(1)}% | ${(result.proUtilization * 100).toFixed(1)}% |`)
  }
  lines.push(
    '',
    '## Test predictions',
    '',
    '| Task | Iteration | Category | Classified type | P(Flash) | P(Pro) | Delta pass | Expected cost delta | Shadow | Actual class |',
    '|---|---:|---|---|---:|---:|---:|---:|---|---|',
  )
  for (const prediction of predictions) {
    lines.push(`| ${prediction.taskId} | ${prediction.iteration} | ${prediction.category} | ${prediction.taskType} | ${(prediction.pFlashPass * 100).toFixed(1)}% | ${(prediction.pProPass * 100).toFixed(1)}% | ${(prediction.verifiedImprovement * 100).toFixed(1)}pp | $${prediction.expectedCostDelta.toFixed(6)} | ${prediction.shadowModel} | ${prediction.actualClass} |`)
  }
  lines.push(
    '',
    '## Promotion gate',
    '',
    '| Criterion | Target | Interpretation |',
    '|---|---|---|',
    '| Verified success | no material degradation | Compare held-out point estimate and interval |',
    '| Cost per verified task | 15-20% improvement | Compare against heuristic on held-out test |',
    '| ProNecessity recall | at least 90% | Test denominator remains small; interval is decisive |',
    '| ProWasteRate | materially lower | Compare against heuristic on held-out test |',
    '| Sample size | confidence intervals narrow enough | 20 held-out examples remain insufficient for promotion |',
    '',
    `The learned router remains shadow-only regardless of the point estimates because the held-out test set contains only ${test.examples.length} examples and ${test.examples.filter(example => !example.flashPassed && example.proPassed).length} Pro-necessary examples.`,
  )
  await writeFile(MARKDOWN_PATH, `${lines.join('\n')}\n`, 'utf8')
  process.stdout.write(`Wrote ${JSON_PATH} and ${MARKDOWN_PATH}\n`)
}

void main()
