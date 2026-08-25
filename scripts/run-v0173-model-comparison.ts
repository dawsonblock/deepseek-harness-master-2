#!/usr/bin/env node
/** Compares workload-v2 logistic and gradient-boosted models on frozen task splits. */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  analyzeTaskStructure,
  deriveBayesianHistoricalFeatures,
} from '@deepseek-ai/dsh-llm-model-router'
import {
  DEFAULT_PRICING_REGISTRY,
  calculateCost,
  lookupPricingAt,
} from '@deepseek-ai/dsh-token-meter'
import type {
  BayesianHistoricalFeatures,
  HistoricalOutcomeObservation,
  WorkloadFeaturesV2,
} from '@deepseek-ai/dsh-llm-model-router'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const BENCHMARK_PATH = join(REPO_ROOT, 'artifacts', 'reports', 'v0.17.2-expanded-benchmark.json')
const MANIFEST_PATH = join(REPO_ROOT, 'artifacts', 'reports', 'paired-v4-100-v1.manifest.json')
const FORENSIC_PATH = join(REPO_ROOT, 'artifacts', 'reports', 'v0.17.3-pro-necessity-forensics.json')
const JSON_PATH = join(REPO_ROOT, 'artifacts', 'reports', 'v0.17.3-model-comparison.json')
const REPORT_PATH = join(REPO_ROOT, 'artifacts', 'reports', 'v0.17.3-model-comparison.md')

interface Run {
  model: string
  verification: { status: string; criteriaPassed: number; criteriaTotal: number }
  usage: { inputTokens: number; outputTokens: number; reasoningTokens: number; totalTokens: number }
  cache: { hitTokens: number; missTokens: number }
  execution: { repairs: number }
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

interface ForensicRecord {
  taskId: string
  difference: { labelValidity: 'genuine' | 'ambiguous' | 'verifier-artifact' }
}

interface Forensics {
  records: ForensicRecord[]
}

interface LabeledExample {
  id: string
  taskId: string
  partition: 'train' | 'validation' | 'test'
  category: string
  featureNames: string[]
  featureGroups: string[]
  x: number[]
  rawFlashVerified: boolean
  auditedFlashVerified: boolean
  proVerified: boolean
  rawProNecessary: boolean
  auditedProNecessary: number | null
  outcomeClass: string
  deltaQuality: number
  flashCost: number
  proCost: number
}

interface Standardization {
  means: number[]
  stds: number[]
}

interface LogisticModel {
  weights: number[]
  bias: number
}

interface LinearModel {
  weights: number[]
  bias: number
}

interface Stump {
  feature: number
  threshold: number
  left: number
  right: number
  gain: number
}

interface BoostedModel {
  initial: number
  learningRate: number
  stumps: Stump[]
  logistic: boolean
}

interface ClassificationMetrics {
  examples: number
  positives: number
  brier: number
  logLoss: number
  accuracyAtHalf: number
  recallAtHalf: number | null
}

interface RegressionMetrics {
  examples: number
  mae: number
  rmse: number
}

interface ModelEvaluation {
  flashPass: ClassificationMetrics
  proPass: ClassificationMetrics
  flashCost: RegressionMetrics
  proCost: RegressionMetrics
}

interface FeatureSetEvaluation {
  name: string
  groups: string[]
  featureCount: number
  logistic: ModelEvaluation
  boosted: ModelEvaluation & { topFeatures: Array<{ feature: string; gain: number }> }
}

const HISTORY_PRIOR = {
  flashPassRate: 0.733,
  proPassRate: 0.767,
  proRescueRate: 0.1,
  flashRepairRate: 0,
  meanCostDelta: 0.0045,
  strength: 10,
}

function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value))
  const exp = Math.exp(value)
  return exp / (1 + exp)
}

function clampProbability(value: number): number {
  return Math.min(1 - 1e-9, Math.max(1e-9, value))
}

function peakCost(run: Run): number {
  const pricing = lookupPricingAt(
    DEFAULT_PRICING_REGISTRY,
    'deepseek-official',
    run.model,
    new Date('2026-08-25T06:30:00Z'),
  )
  if (pricing === undefined) throw new Error(`Missing peak pricing for ${run.model}`)
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

function dominantCategory(features: WorkloadFeaturesV2): string {
  return Object.entries(features.categoryScores)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? 'unknown'
}

function addFeature(
  names: string[],
  groups: string[],
  values: number[],
  group: string,
  name: string,
  value: number | boolean,
): void {
  names.push(name)
  groups.push(group)
  values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
}

function flattenV2(
  workload: WorkloadFeaturesV2,
  historical: BayesianHistoricalFeatures,
): { names: string[]; groups: string[]; values: number[] } {
  const names: string[] = []
  const groups: string[] = []
  const values: number[] = []
  for (const [name, value] of Object.entries(workload.context)) {
    addFeature(names, groups, values, 'context', `context.${name}`, value)
  }
  for (const [name, value] of Object.entries(workload.constraints)) {
    if (typeof value !== 'number' && typeof value !== 'boolean') continue
    addFeature(names, groups, values, 'constraints', `constraints.${name}`, value)
  }
  const transformationTypes = ['copy-extract', 'reformat', 'restructure', 'synthesis', 'generation', 'none']
  for (const name of transformationTypes) {
    addFeature(
      names,
      groups,
      values,
      'transformation',
      `transformation.type.${name}`,
      workload.transformation.type === name,
    )
  }
  for (const [name, value] of Object.entries(workload.transformation)) {
    if (name === 'type' || (typeof value !== 'number' && typeof value !== 'boolean')) continue
    addFeature(names, groups, values, 'transformation', `transformation.${name}`, value)
  }
  const outputTypes = ['prose', 'json', 'table', 'code', 'patch', 'schema', 'list', 'email', 'unknown']
  for (const name of outputTypes) {
    addFeature(names, groups, values, 'output', `output.type.${name}`, workload.output.requestedType === name)
  }
  const lengthBands = ['tiny', 'short', 'medium', 'long', 'unknown']
  for (const name of lengthBands) {
    addFeature(names, groups, values, 'output', `output.length.${name}`, workload.output.expectedLengthBand === name)
  }
  for (const [name, value] of Object.entries(workload.output)) {
    if (name === 'requestedType' || name === 'expectedLengthBand'
      || (typeof value !== 'number' && typeof value !== 'boolean')) continue
    addFeature(names, groups, values, 'output', `output.${name}`, value)
  }
  for (const [name, value] of Object.entries(workload.categoryScores)) {
    addFeature(names, groups, values, 'category', `category.${name}`, value)
  }
  for (const [name, value] of Object.entries(historical)) {
    if (name === 'priorStrength' || typeof value !== 'number') continue
    addFeature(names, groups, values, 'history', `history.${name}`, value)
  }
  return { names, groups, values }
}

function standardization(examples: LabeledExample[], indices: number[]): Standardization {
  const means = indices.map(index =>
    examples.reduce((sum, example) => sum + (example.x[index] ?? 0), 0) / examples.length,
  )
  const stds = indices.map((index, position) => {
    const variance = examples.reduce(
      (sum, example) => sum + ((example.x[index] ?? 0) - (means[position] ?? 0)) ** 2,
      0,
    ) / examples.length
    return Math.sqrt(variance) || 1
  })
  return { means, stds }
}

function project(
  example: LabeledExample,
  indices: number[],
  scale: Standardization,
): number[] {
  return indices.map((index, position) =>
    ((example.x[index] ?? 0) - (scale.means[position] ?? 0)) / (scale.stds[position] ?? 1),
  )
}

function balancedWeights(labels: number[]): number[] {
  const positives = labels.filter(label => label === 1).length
  const negatives = labels.length - positives
  if (positives === 0 || negatives === 0) return labels.map(() => 1)
  return labels.map(label => label === 1 ? labels.length / (2 * positives) : labels.length / (2 * negatives))
}

function trainLogistic(x: number[][], y: number[], sampleWeights: number[]): LogisticModel {
  const width = x[0]?.length ?? 0
  const weights = new Array<number>(width).fill(0)
  const positiveRate = y.reduce((sum, value) => sum + value, 0) / y.length
  let bias = Math.log(clampProbability(positiveRate) / (1 - clampProbability(positiveRate)))
  const learningRate = 0.03
  const l2 = 0.01
  for (let iteration = 0; iteration < 2_000; iteration++) {
    const gradient = new Array<number>(width).fill(0)
    let biasGradient = 0
    let totalWeight = 0
    for (let row = 0; row < x.length; row++) {
      const values = x[row] ?? []
      const weight = sampleWeights[row] ?? 1
      const score = bias + weights.reduce((sum, coefficient, index) =>
        sum + coefficient * (values[index] ?? 0), 0)
      const error = (sigmoid(score) - (y[row] ?? 0)) * weight
      for (let index = 0; index < width; index++) {
        gradient[index] = (gradient[index] ?? 0) + error * (values[index] ?? 0)
      }
      biasGradient += error
      totalWeight += weight
    }
    for (let index = 0; index < width; index++) {
      const current = weights[index] ?? 0
      weights[index] = current - learningRate * ((gradient[index] ?? 0) / totalWeight + l2 * current)
    }
    bias -= learningRate * biasGradient / totalWeight
  }
  return { weights, bias }
}

function trainLinear(x: number[][], y: number[]): LinearModel {
  const width = x[0]?.length ?? 0
  const weights = new Array<number>(width).fill(0)
  let bias = y.reduce((sum, value) => sum + value, 0) / y.length
  const learningRate = 0.03
  for (let iteration = 0; iteration < 2_000; iteration++) {
    const gradient = new Array<number>(width).fill(0)
    let biasGradient = 0
    for (let row = 0; row < x.length; row++) {
      const values = x[row] ?? []
      const prediction = bias + weights.reduce((sum, coefficient, index) =>
        sum + coefficient * (values[index] ?? 0), 0)
      const error = prediction - (y[row] ?? 0)
      for (let index = 0; index < width; index++) {
        gradient[index] = (gradient[index] ?? 0) + error * (values[index] ?? 0)
      }
      biasGradient += error
    }
    for (let index = 0; index < width; index++) {
      weights[index] = (weights[index] ?? 0) - learningRate * (gradient[index] ?? 0) / x.length
    }
    bias -= learningRate * biasGradient / x.length
  }
  return { weights, bias }
}

function linearPrediction(model: LinearModel | LogisticModel, x: number[]): number {
  return model.bias + model.weights.reduce((sum, weight, index) => sum + weight * (x[index] ?? 0), 0)
}

function candidateThresholds(values: number[]): number[] {
  const unique = [...new Set(values)].sort((left, right) => left - right)
  if (unique.length <= 1) return []
  const midpoints = unique.slice(0, -1).map((value, index) => (value + (unique[index + 1] ?? value)) / 2)
  if (midpoints.length <= 20) return midpoints
  return Array.from({ length: 20 }, (_, index) => midpoints[Math.floor(index * (midpoints.length - 1) / 19)] ?? 0)
}

function weightedMean(values: number[], weights: number[]): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  return total === 0
    ? 0
    : values.reduce((sum, value, index) => sum + value * (weights[index] ?? 1), 0) / total
}

function weightedSquaredError(values: number[], weights: number[], mean: number): number {
  return values.reduce((sum, value, index) =>
    sum + (weights[index] ?? 1) * (value - mean) ** 2, 0)
}

function fitStump(x: number[][], residuals: number[], sampleWeights: number[]): Stump | null {
  const width = x[0]?.length ?? 0
  const parentMean = weightedMean(residuals, sampleWeights)
  const parentError = weightedSquaredError(residuals, sampleWeights, parentMean)
  let best: Stump | null = null
  for (let feature = 0; feature < width; feature++) {
    const values = x.map(row => row[feature] ?? 0)
    for (const threshold of candidateThresholds(values)) {
      const leftIndices = values.flatMap((value, index) => value <= threshold ? [index] : [])
      const rightIndices = values.flatMap((value, index) => value > threshold ? [index] : [])
      if (leftIndices.length < 2 || rightIndices.length < 2) continue
      const leftValues = leftIndices.map(index => residuals[index] ?? 0)
      const rightValues = rightIndices.map(index => residuals[index] ?? 0)
      const leftWeights = leftIndices.map(index => sampleWeights[index] ?? 1)
      const rightWeights = rightIndices.map(index => sampleWeights[index] ?? 1)
      const left = weightedMean(leftValues, leftWeights)
      const right = weightedMean(rightValues, rightWeights)
      const error = weightedSquaredError(leftValues, leftWeights, left)
        + weightedSquaredError(rightValues, rightWeights, right)
      const gain = parentError - error
      if (best === null || gain > best.gain) best = { feature, threshold, left, right, gain }
    }
  }
  return best
}

function boostedPrediction(model: BoostedModel, x: number[]): number {
  const score = model.stumps.reduce((sum, stump) =>
    sum + model.learningRate * ((x[stump.feature] ?? 0) <= stump.threshold ? stump.left : stump.right),
  model.initial)
  return model.logistic ? sigmoid(score) : score
}

function trainBoosted(
  x: number[][],
  y: number[],
  sampleWeights: number[],
  logistic: boolean,
): BoostedModel {
  const rate = weightedMean(y, sampleWeights)
  const initial = logistic ? Math.log(clampProbability(rate) / (1 - clampProbability(rate))) : rate
  const learningRate = 0.08
  const model: BoostedModel = { initial, learningRate, stumps: [], logistic }
  for (let iteration = 0; iteration < 120; iteration++) {
    const predictions = x.map(row => boostedPrediction(model, row))
    const residuals = y.map((value, index) => value - (predictions[index] ?? 0))
    const stump = fitStump(x, residuals, sampleWeights)
    if (stump === null || stump.gain <= 1e-12) break
    model.stumps.push(stump)
  }
  return model
}

function classificationMetrics(labels: number[], predictions: number[]): ClassificationMetrics {
  const positives = labels.filter(label => label === 1).length
  const predicted = predictions.map(clampProbability)
  const truePositives = labels.filter((label, index) => label === 1 && (predicted[index] ?? 0) >= 0.5).length
  return {
    examples: labels.length,
    positives,
    brier: labels.reduce((sum, label, index) => sum + ((predicted[index] ?? 0) - label) ** 2, 0) / labels.length,
    logLoss: -labels.reduce((sum, label, index) => {
      const probability = predicted[index] ?? 0.5
      return sum + label * Math.log(probability) + (1 - label) * Math.log(1 - probability)
    }, 0) / labels.length,
    accuracyAtHalf: labels.filter((label, index) => ((predicted[index] ?? 0) >= 0.5 ? 1 : 0) === label).length
      / labels.length,
    recallAtHalf: positives === 0 ? null : truePositives / positives,
  }
}

function regressionMetrics(labels: number[], predictions: number[]): RegressionMetrics {
  return {
    examples: labels.length,
    mae: labels.reduce((sum, label, index) => sum + Math.abs((predictions[index] ?? 0) - label), 0)
      / labels.length,
    rmse: Math.sqrt(labels.reduce((sum, label, index) => sum + ((predictions[index] ?? 0) - label) ** 2, 0)
      / labels.length),
  }
}

function featureIndices(examples: LabeledExample[], groups: string[]): number[] {
  const source = examples[0]
  if (source === undefined) return []
  return source.featureGroups.flatMap((group, index) => groups.includes(group) ? [index] : [])
}

function evaluateFeatureSet(
  name: string,
  groups: string[],
  train: LabeledExample[],
  test: LabeledExample[],
): FeatureSetEvaluation {
  const indices = featureIndices(train, groups)
  const scale = standardization(train, indices)
  const trainX = train.map(example => project(example, indices, scale))
  const testX = test.map(example => project(example, indices, scale))
  const flashLabels = train.map(example => example.auditedFlashVerified ? 1 : 0)
  const proLabels = train.map(example => example.proVerified ? 1 : 0)
  const flashTest = test.map(example => example.auditedFlashVerified ? 1 : 0)
  const proTest = test.map(example => example.proVerified ? 1 : 0)
  const logisticFlash = trainLogistic(trainX, flashLabels, balancedWeights(flashLabels))
  const logisticPro = trainLogistic(trainX, proLabels, balancedWeights(proLabels))
  const boostedFlash = trainBoosted(trainX, flashLabels, balancedWeights(flashLabels), true)
  const boostedPro = trainBoosted(trainX, proLabels, balancedWeights(proLabels), true)
  const flashCostLabels = train.map(example => example.flashCost)
  const proCostLabels = train.map(example => example.proCost)
  const flashCostTest = test.map(example => example.flashCost)
  const proCostTest = test.map(example => example.proCost)
  const linearFlashCost = trainLinear(trainX, flashCostLabels)
  const linearProCost = trainLinear(trainX, proCostLabels)
  const boostedFlashCost = trainBoosted(trainX, flashCostLabels, flashCostLabels.map(() => 1), false)
  const boostedProCost = trainBoosted(trainX, proCostLabels, proCostLabels.map(() => 1), false)
  const importance = new Map<number, number>()
  for (const stump of [...boostedFlash.stumps, ...boostedPro.stumps]) {
    importance.set(stump.feature, (importance.get(stump.feature) ?? 0) + stump.gain)
  }
  const topFeatures = [...importance.entries()]
    .map(([localIndex, gain]) => ({ feature: train[0]?.featureNames[indices[localIndex] ?? -1] ?? 'unknown', gain }))
    .sort((left, right) => right.gain - left.gain)
    .slice(0, 10)
  return {
    name,
    groups,
    featureCount: indices.length,
    logistic: {
      flashPass: classificationMetrics(flashTest, testX.map(row => sigmoid(linearPrediction(logisticFlash, row)))),
      proPass: classificationMetrics(proTest, testX.map(row => sigmoid(linearPrediction(logisticPro, row)))),
      flashCost: regressionMetrics(flashCostTest, testX.map(row => linearPrediction(linearFlashCost, row))),
      proCost: regressionMetrics(proCostTest, testX.map(row => linearPrediction(linearProCost, row))),
    },
    boosted: {
      flashPass: classificationMetrics(flashTest, testX.map(row => boostedPrediction(boostedFlash, row))),
      proPass: classificationMetrics(proTest, testX.map(row => boostedPrediction(boostedPro, row))),
      flashCost: regressionMetrics(flashCostTest, testX.map(row => boostedPrediction(boostedFlashCost, row))),
      proCost: regressionMetrics(proCostTest, testX.map(row => boostedPrediction(boostedProCost, row))),
      topFeatures,
    },
  }
}

function uncertaintyStates(
  examples: LabeledExample[],
  train: LabeledExample[],
  groups: string[],
): Record<string, unknown> {
  const indices = featureIndices(train, groups)
  const scale = standardization(train, indices)
  const trainX = train.map(example => project(example, indices, scale))
  const targetX = examples.map(example => project(example, indices, scale))
  const flashLabels = train.map(example => example.auditedFlashVerified ? 1 : 0)
  const proLabels = train.map(example => example.proVerified ? 1 : 0)
  const flash = trainBoosted(trainX, flashLabels, balancedWeights(flashLabels), true)
  const pro = trainBoosted(trainX, proLabels, balancedWeights(proLabels), true)
  const rows = examples.map((example, index) => {
    const pFlash = boostedPrediction(flash, targetX[index] ?? [])
    const pPro = boostedPrediction(pro, targetX[index] ?? [])
    const delta = pPro - pFlash
    const state = Math.abs(delta) < 0.1 ? 'UNCERTAIN' : delta > 0 ? 'CONFIDENT_PRO' : 'CONFIDENT_FLASH'
    return { taskId: example.id, pFlash, pPro, delta, state, outcomeClass: example.outcomeClass }
  })
  return {
    diagnosticMargin: 0.1,
    counts: {
      confidentFlash: rows.filter(row => row.state === 'CONFIDENT_FLASH').length,
      uncertain: rows.filter(row => row.state === 'UNCERTAIN').length,
      confidentPro: rows.filter(row => row.state === 'CONFIDENT_PRO').length,
    },
    rows,
  }
}

async function main(): Promise<void> {
  const benchmark = JSON.parse(await readFile(BENCHMARK_PATH, 'utf8')) as Benchmark
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as FreezeManifest
  const forensics = JSON.parse(await readFile(FORENSIC_PATH, 'utf8')) as Forensics
  const audit = new Map(forensics.records.map(record => [record.taskId, record.difference.labelValidity]))
  const designs = new Map(benchmark.design.taskClasses.map(task => [task.id, task]))
  const observations: HistoricalOutcomeObservation[] = []
  const examples: LabeledExample[] = []
  for (const partition of ['train', 'validation', 'test'] as const) {
    const pairs = benchmark.pairs
      .filter(pair => manifest.partitions[partition].includes(pair.taskId.replace(/\/\d+$/, '')))
      .sort((left, right) => left.taskId.localeCompare(right.taskId) || left.iteration - right.iteration)
    for (const pair of pairs) {
      const taskId = pair.taskId.replace(/\/\d+$/, '')
      const design = designs.get(taskId)
      if (design === undefined) throw new Error(`Missing task design for ${taskId}`)
      const workload = analyzeTaskStructure(design.task, { verificationCriterionCount: design.criteriaCount })
      const bucket = `${dominantCategory(workload)}:${workload.transformation.type}`
      const historical = deriveBayesianHistoricalFeatures(observations, bucket, HISTORY_PRIOR)
      const flat = flattenV2(workload, historical)
      const validity = audit.get(pair.taskId)
      const rawFlashVerified = pair.flash.verification.status === 'verified-pass'
      const proVerified = pair.pro.verification.status === 'verified-pass'
      const verifierArtifact = validity === 'verifier-artifact'
      const auditedFlashVerified = rawFlashVerified || verifierArtifact
      const rawProNecessary = !rawFlashVerified && proVerified
      const auditedProNecessary = rawProNecessary
        ? validity === 'genuine' ? 1 : null
        : 0
      const flashQuality = verifierArtifact
        ? 1
        : pair.flash.verification.criteriaPassed / pair.flash.verification.criteriaTotal
      const proQuality = pair.pro.verification.criteriaPassed / pair.pro.verification.criteriaTotal
      const flashCost = peakCost(pair.flash)
      const proCost = peakCost(pair.pro)
      examples.push({
        id: pair.taskId,
        taskId,
        partition,
        category: design.category,
        featureNames: flat.names,
        featureGroups: flat.groups,
        x: flat.values,
        rawFlashVerified,
        auditedFlashVerified,
        proVerified,
        rawProNecessary,
        auditedProNecessary,
        outcomeClass: pair.classification,
        deltaQuality: proQuality - flashQuality,
        flashCost,
        proCost,
      })
      observations.push({
        bucket,
        flashVerified: auditedFlashVerified,
        proVerified,
        flashRepairs: pair.flash.execution.repairs,
        flashCost,
        proCost,
      })
    }
  }

  const train = examples.filter(example => example.partition === 'train')
  const validation = examples.filter(example => example.partition === 'validation')
  const test = examples.filter(example => example.partition === 'test')
  const featureSets = [
    { name: 'v2-structure', groups: ['context', 'constraints', 'transformation', 'output'] },
    { name: 'v2-plus-category', groups: ['context', 'constraints', 'transformation', 'output', 'category'] },
    { name: 'v2-plus-history', groups: ['context', 'constraints', 'transformation', 'output', 'category', 'history'] },
  ]
  const validationComparison = featureSets.map(set => evaluateFeatureSet(set.name, set.groups, train, validation))
  const testComparison = featureSets.map(set => evaluateFeatureSet(set.name, set.groups, train, test))
  const directTrain = train.filter(example => example.auditedProNecessary !== null)
  const directTest = test.filter(example => example.auditedProNecessary !== null)
  const fullGroups = featureSets[2]?.groups ?? []
  const directIndices = featureIndices(directTrain, fullGroups)
  const directScale = standardization(directTrain, directIndices)
  const directTrainX = directTrain.map(example => project(example, directIndices, directScale))
  const directTestX = directTest.map(example => project(example, directIndices, directScale))
  const directLabels = directTrain.map(example => example.auditedProNecessary ?? 0)
  const directTestLabels = directTest.map(example => example.auditedProNecessary ?? 0)
  const directLogistic = trainLogistic(directTrainX, directLabels, balancedWeights(directLabels))
  const directBoosted = trainBoosted(directTrainX, directLabels, balancedWeights(directLabels), true)
  const directProNecessity = {
    trainingExamples: directTrain.length,
    trainingPositives: directLabels.filter(label => label === 1).length,
    testExamples: directTest.length,
    testPositives: directTestLabels.filter(label => label === 1).length,
    logistic: classificationMetrics(
      directTestLabels,
      directTestX.map(row => sigmoid(linearPrediction(directLogistic, row))),
    ),
    boosted: classificationMetrics(directTestLabels, directTestX.map(row => boostedPrediction(directBoosted, row))),
  }
  const output = {
    release: 'v0.17.3',
    datasetId: manifest.datasetId,
    labelAudit: {
      rawProNecessary: examples.filter(example => example.rawProNecessary).length,
      genuineProNecessary: examples.filter(example => example.auditedProNecessary === 1).length,
      excludedAmbiguousOrArtifact: examples.filter(example =>
        example.rawProNecessary && example.auditedProNecessary === null).length,
      auditedTestProNecessary: directProNecessity.testPositives,
    },
    richerTargets: [
      'flash_verified',
      'pro_verified',
      'delta_quality',
      'flash_cost',
      'pro_cost',
      'delta_cost',
      'pro_necessary',
      'outcome_class',
    ],
    validationComparison,
    testComparison,
    directProNecessity,
    uncertainty: uncertaintyStates(test, train, fullGroups),
  }
  await writeFile(JSON_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8')

  const lines = [
    '# v0.17.3 Workload-V2 Model Comparison',
    '',
    `Dataset: ${manifest.datasetId}`,
    '',
    'Cost targets use the current peak schedule because the frozen calls occurred during a peak UTC window.',
    '',
    '## Label audit',
    '',
    `- ${output.labelAudit.rawProNecessary} raw Pro-necessary labels become ${output.labelAudit.genuineProNecessary} genuine labels after forensic review.`,
    `- ${output.labelAudit.excludedAmbiguousOrArtifact} ambiguous or verifier-artifact labels are excluded from direct Pro-necessity training.`,
    `- The audited test partition contains ${output.labelAudit.auditedTestProNecessary} genuine Pro-necessary examples, so held-out recall is not estimable.`,
    '',
    '## Held-out outcome prediction',
    '',
    '| Feature set | Model | Flash-pass Brier | Pro-pass Brier | Flash-cost MAE | Pro-cost MAE |',
    '|---|---|---:|---:|---:|---:|',
  ]
  for (const comparison of testComparison) {
    const logistic = comparison.logistic
    const boosted = comparison.boosted
    lines.push(`| ${comparison.name} | logistic/linear | ${logistic.flashPass.brier.toFixed(4)} | ${logistic.proPass.brier.toFixed(4)} | $${logistic.flashCost.mae.toFixed(6)} | $${logistic.proCost.mae.toFixed(6)} |`)
    lines.push(`| ${comparison.name} | boosted stumps | ${boosted.flashPass.brier.toFixed(4)} | ${boosted.proPass.brier.toFixed(4)} | $${boosted.flashCost.mae.toFixed(6)} | $${boosted.proCost.mae.toFixed(6)} |`)
  }
  const allFeatureImportance = testComparison.find(comparison => comparison.name === 'v2-plus-history')
    ?.boosted.topFeatures ?? []
  lines.push(
    '',
    '## Boosted feature importance',
    '',
    '| Feature | Split gain |',
    '|---|---:|',
  )
  for (const feature of allFeatureImportance) lines.push(`| ${feature.feature} | ${feature.gain.toFixed(4)} |`)
  lines.push(
    '',
    '## Direct Pro-necessity target',
    '',
    `Training contains ${directProNecessity.trainingPositives} genuine positives across ${directProNecessity.trainingExamples} eligible examples. The audited test split contains ${directProNecessity.testPositives} positives, so neither logistic regression nor boosted trees can report meaningful held-out ProNecessity recall.`,
    '',
    '## Uncertainty diagnostic',
    '',
    'The three-state counts below use a 0.10 probability-difference margin for diagnosis only; they are not routing thresholds.',
    '',
    `- CONFIDENT_FLASH: ${(output.uncertainty.counts as { confidentFlash: number }).confidentFlash}`,
    `- UNCERTAIN: ${(output.uncertainty.counts as { uncertain: number }).uncertain}`,
    `- CONFIDENT_PRO: ${(output.uncertainty.counts as { confidentPro: number }).confidentPro}`,
    '',
    '## Qualification result',
    '',
    'Workload-v2 enables interpretable feature and ablation analysis, but the audited corpus cannot qualify any router: only three genuine rescues remain, two are in training, one is in validation, and none is in test. The next collection target is 30-50 genuine Pro-necessary examples with an untouched natural-distribution test set.',
  )
  await writeFile(REPORT_PATH, `${lines.join('\n')}\n`, 'utf8')
  process.stdout.write(`Wrote ${JSON_PATH} and ${REPORT_PATH}\n`)
}

void main()
