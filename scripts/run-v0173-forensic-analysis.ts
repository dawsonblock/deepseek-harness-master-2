#!/usr/bin/env node
/** Extracts Pro-necessity cases and nearest same-category Flash-sufficient controls. */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FEATURE_NAMES,
  FEATURE_VERSION,
  classifyTaskType,
  flattenFeatures,
  predict,
  scoreComplexity,
  taskTypeExpectsProAdvantage,
} from '@deepseek-ai/dsh-llm-model-router'
import type {
  HistoricalFeatures,
  PreRoutingFeatureVector,
  StructuralFeatures,
  TaskType,
  TrainedModel,
} from '@deepseek-ai/dsh-llm-model-router'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const BENCHMARK_PATH = join(REPO_ROOT, 'artifacts', 'reports', 'v0.17.2-expanded-benchmark.json')
const EVALUATION_PATH = join(REPO_ROOT, 'artifacts', 'reports', 'v0.17.2-offline-evaluation.json')
const MANIFEST_PATH = join(REPO_ROOT, 'artifacts', 'reports', 'paired-v4-100-v1.manifest.json')
const OUTPUT_PATH = join(REPO_ROOT, 'artifacts', 'reports', 'v0.17.3-pro-necessity-forensics.json')
const REPORT_PATH = join(REPO_ROOT, 'artifacts', 'reports', 'v0.17.3-pro-necessity-forensics.md')

interface FailureAnalysis {
  labelValidity: 'genuine' | 'ambiguous' | 'verifier-artifact'
  failureMechanism: string
  whyFlashFailed: string
  whatProDidDifferently: string
  missingFeature: string
}

const FAILURE_ANALYSIS: Record<string, FailureAnalysis> = {
  'constraints-email/1': {
    labelValidity: 'genuine',
    failureMechanism: 'extraneous-output-and-terminal-format-violation',
    whyFlashFailed: 'Added an introduction, separators, and a postscript; exceeded the word limit and did not end with the exact signature.',
    whatProDidDifferently: 'Returned only the email body, stayed below 50 words, and ended with the exact literal signature.',
    missingFeature: 'Explicit constraint count, maximum length, exact terminal literal, and no-extraneous-output requirement.',
  },
  'json-filter/1': {
    labelValidity: 'genuine',
    failureMechanism: 'projection-schema-and-exact-format-error',
    whyFlashFailed: 'Returned an array of strings inside a code fence instead of objects containing only the name field.',
    whatProDidDifferently: 'Applied filtering and object projection while preserving the requested JSON object schema without a fence.',
    missingFeature: 'Transformation operation count, output object cardinality, output field count, and strict unfenced JSON.',
  },
  'plan-api/1': {
    labelValidity: 'verifier-artifact',
    failureMechanism: 'numbered-step-verifier-markup-sensitivity',
    whyFlashFailed: 'The verifier ignored five semantically numbered steps because each number was wrapped in Markdown bold syntax.',
    whatProDidDifferently: 'Used plain line-leading numbers that matched the verifier regular expression.',
    missingFeature: 'None; the verifier must recognize equivalent Markdown numbering.',
  },
  'synthesis-oauth/1': {
    labelValidity: 'genuine',
    failureMechanism: 'required-cardinality-collapse',
    whyFlashFailed: 'Collapsed four requested role sentences into one compound semicolon-delimited sentence.',
    whatProDidDifferently: 'Produced one independent sentence for each of the four roles.',
    missingFeature: 'Source entity count, one-output-unit-per-entity constraint, and expected output cardinality.',
  },
  'constraints-table/1': {
    labelValidity: 'ambiguous',
    failureMechanism: 'extraneous-restatement-breaks-exact-multiplicity',
    whyFlashFailed: 'The table was correct, but a trailing explanation repeated every owner and priority, breaking exact-once checks.',
    whatProDidDifferently: 'Returned the table without a trailing restatement.',
    missingFeature: 'Exact multiplicity constraints, output-only requirement, and extraneous-text prohibition.',
  },
  'plan-migration/1': {
    labelValidity: 'verifier-artifact',
    failureMechanism: 'top-level-step-verifier-counting-error',
    whyFlashFailed: 'The answer contained six Step headings, but the verifier counted only line-leading digit-dot syntax.',
    whatProDidDifferently: 'Also used Step headings; nested numbered cutover actions accidentally made the regex count equal six.',
    missingFeature: 'None; the verifier must count top-level plan steps instead of unrelated nested numbers.',
  },
}

interface VerificationCheck {
  description: string
  passed: boolean
}

interface Run {
  model: string
  cacheState: string
  cache: { hitTokens: number; missTokens: number; hitRate: number }
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number; totalTokens: number }
  economics: { costUsd: number; pricingVersion: string }
  execution: { latencyMs: number; attempts: number; toolCalls: number; toolFailures: number; repairs: number }
  verification: { status: string; criteriaPassed: number; criteriaTotal: number; checks: VerificationCheck[] }
  output: string
}

interface Pair {
  taskId: string
  iteration: number
  flash: Run
  pro: Run
  classification: string
}

interface TaskDesign {
  id: string
  category: string
  task: string
  criteriaCount: number
}

interface Benchmark {
  design: { taskClasses: TaskDesign[] }
  pairs: Pair[]
}

interface FreezeManifest {
  datasetId: string
  partitions: Record<'train' | 'validation' | 'test', string[]>
}

interface ModelSnapshot {
  version: number
  trainingExamples: number
  selectedThreshold: number
  standardization: { means: number[]; stds: number[] }
  coefficients: {
    flashPass: { weights: number[]; bias: number }
    proPass: { weights: number[]; bias: number }
    costDelta: { weights: number[]; bias: number }
  }
}

interface Evaluation {
  model: ModelSnapshot
}

interface BaseExample {
  taskId: string
  iteration: number
  category: string
  prompt: string
  criteriaCount: number
  taskType: TaskType
  pair: Pair
}

interface FeatureExample extends BaseExample {
  features: PreRoutingFeatureVector
}

interface HistoryRecord {
  taskType: TaskType
  flashPassed: boolean
  proPassed: boolean
  flashCost: number
  proCost: number
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
  const reading = scoreComplexity(example.prompt, {})
  return {
    featureVersion: FEATURE_VERSION,
    complexity: {
      explicitReasoningRequests: reading.signals.explicitReasoningRequests,
      mathMarkers: reading.signals.mathMarkers,
      architectureMarkers: reading.signals.architectureMarkers,
      codeBlocks: reading.signals.codeBlocks,
      lengthBands: reading.signals.lengthBands,
      complexityScore: reading.score,
      promptLength: example.prompt.length,
    },
    structural: structuralFeatures(example.prompt, example.criteriaCount),
    categorical: {
      taskType: example.taskType,
      expectsProAdvantage: taskTypeExpectsProAdvantage(example.taskType),
    },
    historical: historicalFeatures(history, example.taskType),
  }
}

function materialize(base: BaseExample[], manifest: FreezeManifest): FeatureExample[] {
  const history: HistoryRecord[] = []
  const result: FeatureExample[] = []
  for (const partition of ['train', 'validation', 'test'] as const) {
    const taskIds = manifest.partitions[partition]
    const selected = base
      .filter(example => taskIds.includes(example.taskId))
      .sort((left, right) => left.taskId.localeCompare(right.taskId) || left.iteration - right.iteration)
    for (const example of selected) {
      result.push({ ...example, features: featureVector(example, history) })
      history.push({
        taskType: example.taskType,
        flashPassed: example.pair.flash.verification.status === 'verified-pass',
        proPassed: example.pair.pro.verification.status === 'verified-pass',
        flashCost: example.pair.flash.economics.costUsd,
        proCost: example.pair.pro.economics.costUsd,
      })
    }
  }
  return result
}

function answerShape(output: string): string {
  const trimmed = output.trim()
  if (trimmed === '') return 'empty'
  if (/^```/.test(trimmed)) return 'fenced-block'
  if (/^\s*\[/.test(trimmed)) return 'json-array'
  if (/^\s*\{/.test(trimmed)) return 'json-object'
  if (/^\s*\|.+\|/m.test(trimmed)) return 'markdown-table'
  if ((trimmed.match(/^\s*\d+\./gm) ?? []).length >= 2) return 'numbered-list'
  if ((trimmed.match(/^\s*[-*]/gm) ?? []).length >= 2) return 'bullet-list'
  if (/\n\s*\n/.test(trimmed)) return 'multi-paragraph-prose'
  return 'prose'
}

function model(snapshot: ModelSnapshot): TrainedModel {
  return {
    flashModel: snapshot.coefficients.flashPass,
    proModel: snapshot.coefficients.proPass,
    costDeltaModel: snapshot.coefficients.costDelta,
    featureNames: [...FEATURE_NAMES],
    means: snapshot.standardization.means,
    stds: snapshot.standardization.stds,
    modelVersion: snapshot.version,
    trainingSize: snapshot.trainingExamples,
  }
}

function distances(examples: FeatureExample[]): Map<string, number[]> {
  const vectors = examples.map(example => flattenFeatures(example.features).slice(0, 19))
  const dimensions = vectors[0]?.length ?? 0
  const means = Array.from({ length: dimensions }, (_, index) =>
    vectors.reduce((sum, vector) => sum + (vector[index] ?? 0), 0) / vectors.length,
  )
  const stds = Array.from({ length: dimensions }, (_, index) => {
    const variance = vectors.reduce((sum, vector) => sum + ((vector[index] ?? 0) - (means[index] ?? 0)) ** 2, 0)
      / vectors.length
    return Math.sqrt(variance) || 1
  })
  return new Map(examples.map((example, exampleIndex) => [
    `${example.taskId}/${example.iteration}`,
    (vectors[exampleIndex] ?? []).map((value, index) => (value - (means[index] ?? 0)) / (stds[index] ?? 1)),
  ]))
}

function euclidean(left: number[], right: number[]): number {
  return Math.sqrt(left.reduce((sum, value, index) => sum + (value - (right[index] ?? 0)) ** 2, 0))
}

function runEvidence(run: Run): Record<string, unknown> {
  return {
    model: run.model,
    verification: run.verification,
    failedCriteria: run.verification.checks.filter(check => !check.passed),
    toolCalls: run.execution.toolCalls,
    toolFailures: run.execution.toolFailures,
    repairs: run.execution.repairs,
    answerShape: answerShape(run.output),
    usage: run.usage,
    cache: run.cache,
    latencyMs: run.execution.latencyMs,
    costUsd: run.economics.costUsd,
    output: run.output,
  }
}

async function main(): Promise<void> {
  const benchmark = JSON.parse(await readFile(BENCHMARK_PATH, 'utf8')) as Benchmark
  const evaluation = JSON.parse(await readFile(EVALUATION_PATH, 'utf8')) as Evaluation
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as FreezeManifest
  const designs = new Map(benchmark.design.taskClasses.map(task => [task.id, task]))
  const base = benchmark.pairs.map((pair): BaseExample => {
    const taskId = pair.taskId.replace(/\/\d+$/, '')
    const design = designs.get(taskId)
    if (design === undefined) throw new Error(`Missing task design for ${taskId}`)
    return {
      taskId,
      iteration: pair.iteration,
      category: design.category,
      prompt: design.task,
      criteriaCount: design.criteriaCount,
      taskType: classifyTaskType(design.task),
      pair,
    }
  })
  const examples = materialize(base, manifest)
  const vectors = distances(examples)
  const trained = model(evaluation.model)
  const positives = examples.filter(example => example.pair.classification === 'pro-necessary')
  const records = positives.map((positive) => {
    const prediction = predict(trained, positive.features, evaluation.model.selectedThreshold)
    const key = `${positive.taskId}/${positive.iteration}`
    const sourceVector = vectors.get(key) ?? []
    const controls = examples
      .filter(example => example.category === positive.category
        && example.pair.classification === 'both-pass-pro-more-expensive')
      .map(example => ({
        example,
        distance: euclidean(sourceVector, vectors.get(`${example.taskId}/${example.iteration}`) ?? []),
      }))
      .sort((left, right) => left.distance - right.distance)
      .slice(0, 5)
      .map(({ example, distance }) => ({
        taskId: `${example.taskId}/${example.iteration}`,
        distance,
        prompt: example.prompt,
        features: example.features,
        flashOutput: example.pair.flash.output,
        proOutput: example.pair.pro.output,
      }))
    const analysis = FAILURE_ANALYSIS[key]
    if (analysis === undefined) throw new Error(`Missing failure analysis for ${key}`)
    const samePromptOtherIterations = examples
      .filter(example => example.taskId === positive.taskId && example.iteration !== positive.iteration)
      .map(example => ({
        taskId: `${example.taskId}/${example.iteration}`,
        classification: example.pair.classification,
        flashVerified: example.pair.flash.verification.status === 'verified-pass',
        proVerified: example.pair.pro.verification.status === 'verified-pass',
      }))
    return {
      taskId: key,
      taskClass: positive.category,
      prompt: positive.prompt,
      originalFeatures: positive.features,
      prediction: {
        pFlashPass: prediction.pFlashPass,
        pProPass: prediction.pProPass,
        predictedCostDifference: prediction.expectedCostDelta,
        selectedThreshold: evaluation.model.selectedThreshold,
        shadowChoice: prediction.recommendsPro ? 'Pro' : 'Flash',
      },
      flash: runEvidence(positive.pair.flash),
      pro: runEvidence(positive.pair.pro),
      difference: analysis,
      samePromptOtherIterations,
      nearestFlashSufficient: controls,
    }
  })
  const validityCounts = {
    genuine: records.filter(record => record.difference.labelValidity === 'genuine').length,
    ambiguous: records.filter(record => record.difference.labelValidity === 'ambiguous').length,
    verifierArtifact: records.filter(record => record.difference.labelValidity === 'verifier-artifact').length,
  }
  const identicalPromptFlashPasses = records.filter(record =>
    record.samePromptOtherIterations.some(comparison => comparison.flashVerified),
  ).length
  const output = {
    datasetId: manifest.datasetId,
    sourceCommit: '81a200dd2eb2fa46a7c2e59d5a2eae626e310348',
    positiveCount: records.length,
    validityCounts,
    identicalPromptFlashPasses,
    controlSelection: 'five nearest same-category both-pass examples by standardized v1 non-historical feature distance',
    limitations: [
      'The benchmark stores tool and repair counts, not individual tool-event payloads.',
      'Provider reasoning text is not retained; reasoning usage is available as token counts.',
    ],
    records,
  }
  await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
  const cell = (value: string): string => value.replaceAll('|', '\\|').replaceAll('\n', ' ')
  const lines = [
    '# v0.17.3 Pro-Necessity Forensic Analysis',
    '',
    `Dataset: ${manifest.datasetId}`,
    '',
    '## Label audit',
    '',
    `- ${validityCounts.genuine} genuine rescues, ${validityCounts.ambiguous} ambiguous rescue, and ${validityCounts.verifierArtifact} verifier artifacts.`,
    `- ${identicalPromptFlashPasses} of ${records.length} rescue prompts have another identical-prompt iteration where Flash passes.`,
    '- Tool and repair counts are available, but the benchmark does not retain individual tool payloads or provider reasoning text.',
    '',
    '| Task | Label validity | Failure mechanism | Why Flash failed | What Pro did differently | Missing V2 signal |',
    '|---|---|---|---|---|---|',
  ]
  for (const record of records) {
    lines.push(`| ${record.taskId} | ${record.difference.labelValidity} | ${record.difference.failureMechanism} | ${cell(record.difference.whyFlashFailed)} | ${cell(record.difference.whatProDidDifferently)} | ${cell(record.difference.missingFeature)} |`)
  }
  lines.push(
    '',
    '## Consequence',
    '',
    'The six raw rescue labels are not six independent, deterministic examples of latent Pro necessity. Two are verifier artifacts, one is verifier-sensitive, and five conflict with a Flash-pass observation at the same pre-routing task structure. V2 training keeps label validity separate and does not treat verifier artifacts as positive routing targets.',
  )
  await writeFile(REPORT_PATH, `${lines.join('\n')}\n`, 'utf8')
  process.stdout.write(`Wrote ${records.length} forensic records to ${OUTPUT_PATH} and ${REPORT_PATH}\n`)
}

void main()
