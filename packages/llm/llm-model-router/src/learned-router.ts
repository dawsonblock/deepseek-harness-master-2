/**
 * Multi-target learned router model. Trains three separate logistic
 * regression models: P(Flash passes), P(Pro passes), and expected cost
 * difference. The routing decision is then a threshold on the utility
 * difference rather than a single opaque classification.
 *
 * The model uses only pre-routing features, preserving the invariant:
 * featureSeq < routingDecisionSeq.
 *
 * @module @deepseek-ai/dsh-llm-model-router/learned-router
 */

import type { ModelPredictions, PreRoutingFeatureVector } from './shadow-types.ts'

/** Training example for the multi-target model. */
export interface TrainingExample {
  features: PreRoutingFeatureVector
  flashPassed: boolean
  proPassed: boolean
  flashCost: number
  proCost: number
}

/** Trained multi-target model. */
export interface TrainedModel {
  flashModel: LogisticModel
  proModel: LogisticModel
  costDeltaModel: LogisticModel
  featureNames: string[]
  /** Standardization means from training data. */
  means: number[]
  /** Standardization stds from training data. */
  stds: number[]
  /** Model schema version. */
  modelVersion: number
  /** Training sample count. */
  trainingSize: number
}

/** Internal logistic regression model. */
interface LogisticModel {
  weights: number[]
  bias: number
}

/** Current model schema version. */
export const MODEL_VERSION = 1

/** Feature version, incremented when the feature vector changes. */
export const FEATURE_VERSION = 1

/** Feature names in canonical order. */
export const FEATURE_NAMES: readonly string[] = [
  'complexity.explicitReasoningRequests',
  'complexity.mathMarkers',
  'complexity.architectureMarkers',
  'complexity.codeBlocks',
  'complexity.lengthBands',
  'complexity.complexityScore',
  'complexity.promptLength',
  'structural.estimatedInputTokens',
  'structural.messageCount',
  'structural.toolSchemaCount',
  'structural.attachedFileCount',
  'structural.codeBlockCount',
  'structural.structuredDataSize',
  'structural.requestsStructuredOutput',
  'structural.jsonTransformationIndicator',
  'structural.multiFileIndicator',
  'structural.toolRequirementIndicator',
  'structural.verificationCriterionCount',
  'categorical.expectsProAdvantage',
  'historical.flashSuccessRateByTaskType',
  'historical.proSuccessRateByTaskType',
  'historical.flashToProRescueRate',
  'historical.recentFlashFailureRate',
  'historical.historicalCostDifference',
  'historical.historicalSampleCount',
]

function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z))
  const expZ = Math.exp(z)
  return expZ / (1 + expZ)
}

/** Extract a numeric feature array from a feature vector in canonical order. */
export function flattenFeatures(fv: PreRoutingFeatureVector): number[] {
  return [
    fv.complexity.explicitReasoningRequests,
    fv.complexity.mathMarkers,
    fv.complexity.architectureMarkers,
    fv.complexity.codeBlocks,
    fv.complexity.lengthBands,
    fv.complexity.complexityScore,
    fv.complexity.promptLength,
    fv.structural.estimatedInputTokens,
    fv.structural.messageCount,
    fv.structural.toolSchemaCount,
    fv.structural.attachedFileCount,
    fv.structural.codeBlockCount,
    fv.structural.structuredDataSize,
    fv.structural.requestsStructuredOutput ? 1 : 0,
    fv.structural.jsonTransformationIndicator ? 1 : 0,
    fv.structural.multiFileIndicator ? 1 : 0,
    fv.structural.toolRequirementIndicator ? 1 : 0,
    fv.structural.verificationCriterionCount,
    fv.categorical.expectsProAdvantage ? 1 : 0,
    fv.historical.flashSuccessRateByTaskType,
    fv.historical.proSuccessRateByTaskType,
    fv.historical.flashToProRescueRate,
    fv.historical.recentFlashFailureRate,
    fv.historical.historicalCostDifference,
    fv.historical.historicalSampleCount,
  ]
}

function trainLogistic(
  examples: Array<{ x: number[]; y: number }>,
  learningRate: number,
  iterations: number,
): LogisticModel {
  const nFeatures = examples[0]?.x.length ?? 0
  const weights = new Array(nFeatures).fill(0)
  let bias = 0

  for (let iter = 0; iter < iterations; iter++) {
    const gradW = new Array(nFeatures).fill(0)
    let gradB = 0
    for (const { x, y } of examples) {
      const z = bias + weights.reduce((s, w, i) => s + w * (x[i] ?? 0), 0)
      const p = sigmoid(z)
      const error = p - y
      for (let i = 0; i < nFeatures; i++) gradW[i] += error * (x[i] ?? 0)
      gradB += error
    }
    const n = examples.length
    for (let i = 0; i < nFeatures; i++) weights[i] -= learningRate * (gradW[i] ?? 0) / n
    bias -= learningRate * gradB / n
  }

  return { weights, bias }
}

/**
 * Train the multi-target model from paired examples.
 * @param examples - paired Flash/Pro training examples.
 * @param learningRate - gradient descent learning rate.
 * @param iterations - gradient descent iterations.
 */
export function trainModel(
  examples: TrainingExample[],
  learningRate = 0.05,
  iterations = 500,
): TrainedModel {
  if (examples.length === 0) {
    return {
      flashModel: { weights: [], bias: 0 },
      proModel: { weights: [], bias: 0 },
      costDeltaModel: { weights: [], bias: 0 },
      featureNames: [...FEATURE_NAMES],
      means: [],
      stds: [],
      modelVersion: MODEL_VERSION,
      trainingSize: 0,
    }
  }

  const flat = examples.map(ex => flattenFeatures(ex.features))
  const nFeatures = FEATURE_NAMES.length

  // Standardize
  const means = new Array(nFeatures).fill(0)
  const stds = new Array(nFeatures).fill(1)
  for (const x of flat) {
    for (let i = 0; i < nFeatures; i++) means[i] += x[i] ?? 0
  }
  for (let i = 0; i < nFeatures; i++) means[i] /= flat.length
  for (const x of flat) {
    for (let i = 0; i < nFeatures; i++) {
      stds[i] += ((x[i] ?? 0) - means[i]) ** 2
    }
  }
  for (let i = 0; i < nFeatures; i++) stds[i] = Math.sqrt(stds[i] / flat.length) || 1

  const standardize = (x: number[]): number[] =>
    x.map((v, i) => (v - means[i]) / stds[i])

  const flashExamples = examples.map((ex, i) => ({
    x: standardize(flat[i]),
    y: ex.flashPassed ? 1 : 0,
  }))
  const proExamples = examples.map((ex, i) => ({
    x: standardize(flat[i]),
    y: ex.proPassed ? 1 : 0,
  }))
  const costDeltaExamples = examples.map((ex, i) => ({
    x: standardize(flat[i]),
    y: ex.proCost - ex.flashCost,
  }))

  return {
    flashModel: trainLogistic(flashExamples, learningRate, iterations),
    proModel: trainLogistic(proExamples, learningRate, iterations),
    costDeltaModel: trainLogistic(costDeltaExamples, learningRate, iterations),
    featureNames: [...FEATURE_NAMES],
    means,
    stds,
    modelVersion: MODEL_VERSION,
    trainingSize: examples.length,
  }
}

/**
 * Predict P(Flash passes), P(Pro passes), and expected cost delta.
 * @param model - the trained multi-target model.
 * @param features - the pre-routing feature vector.
 * @param proCostThreshold - minimum verified-rate improvement to justify Pro cost.
 */
export function predict(
  model: TrainedModel,
  features: PreRoutingFeatureVector,
  proCostThreshold = 0.1,
): ModelPredictions {
  if (model.trainingSize === 0) {
    return {
      pFlashPass: 0.5,
      pProPass: 0.5,
      expectedCostDelta: 0,
      recommendsPro: false,
      confidence: 0,
      modelVersion: MODEL_VERSION,
    }
  }

  const x = flattenFeatures(features).map((v, i) => (v - model.means[i]) / model.stds[i])

  const zFlash = model.flashModel.bias + model.flashModel.weights.reduce((s, w, i) => s + w * (x[i] ?? 0), 0)
  const zPro = model.proModel.bias + model.proModel.weights.reduce((s, w, i) => s + w * (x[i] ?? 0), 0)
  const zCost = model.costDeltaModel.bias + model.costDeltaModel.weights.reduce((s, w, i) => s + w * (x[i] ?? 0), 0)

  const pFlashPass = sigmoid(zFlash)
  const pProPass = sigmoid(zPro)
  const expectedCostDelta = zCost

  // Choose Pro when the verified-rate improvement justifies the cost
  const verifiedImprovement = pProPass - pFlashPass
  const recommendsPro = verifiedImprovement >= proCostThreshold
  const confidence = Math.abs(verifiedImprovement)

  return {
    pFlashPass,
    pProPass,
    expectedCostDelta,
    recommendsPro,
    confidence,
    modelVersion: MODEL_VERSION,
  }
}
