import { describe, expect, it } from 'vitest'
import {
  FEATURE_NAMES,
  MODEL_VERSION,
  flattenFeatures,
  predict,
  trainModel,
} from '../src/learned-router.ts'
import { classifyTaskType } from '../src/task-classifier.ts'
import type { PreRoutingFeatureVector } from '../src/shadow-types.ts'

function features(overrides: Partial<PreRoutingFeatureVector['structural']> = {}): PreRoutingFeatureVector {
  return {
    featureVersion: 1,
    complexity: {
      explicitReasoningRequests: 0,
      mathMarkers: 0,
      architectureMarkers: 0,
      codeBlocks: 0,
      lengthBands: 0,
      complexityScore: 0,
      promptLength: 80,
    },
    structural: {
      estimatedInputTokens: 20,
      messageCount: 1,
      toolSchemaCount: 0,
      attachedFileCount: 0,
      codeBlockCount: 0,
      structuredDataSize: 0,
      requestsStructuredOutput: false,
      jsonTransformationIndicator: false,
      multiFileIndicator: false,
      toolRequirementIndicator: false,
      verificationCriterionCount: 2,
      ...overrides,
    },
    categorical: { taskType: 'simple-factual', expectsProAdvantage: false },
    historical: {
      flashSuccessRateByTaskType: 0.8,
      proSuccessRateByTaskType: 0.9,
      flashToProRescueRate: 0.1,
      recentFlashFailureRate: 0.2,
      historicalCostDifference: 0.002,
      historicalSampleCount: 10,
    },
  }
}

describe('learned router', () => {
  it('keeps the feature vector aligned with canonical names', () => {
    expect(flattenFeatures(features())).toHaveLength(FEATURE_NAMES.length)
  })

  it('fits expected cost difference as a continuous value', () => {
    const sample = features()
    const model = trainModel(Array.from({ length: 20 }, () => ({
      features: sample,
      flashPassed: true,
      proPassed: true,
      flashCost: 0.001,
      proCost: 0.004,
    })), 0.05, 500)

    const result = predict(model, sample)
    expect(result.expectedCostDelta).toBeCloseTo(0.003, 4)
    expect(result.modelVersion).toBe(MODEL_VERSION)
  })

  it('learns a verified-success advantage independently from cost', () => {
    const flashTask = features({ structuredDataSize: 0 })
    const proTask = features({ structuredDataSize: 100, jsonTransformationIndicator: true })
    const examples = Array.from({ length: 20 }, (_, index) => {
      const proNecessary = index >= 10
      return {
        features: proNecessary ? proTask : flashTask,
        flashPassed: !proNecessary,
        proPassed: true,
        flashCost: 0.001,
        proCost: 0.004,
      }
    })
    const model = trainModel(examples, 0.05, 1_000)

    expect(predict(model, proTask, 0.1).recommendsPro).toBe(true)
    expect(predict(model, flashTask, 0.1).recommendsPro).toBe(false)
  })
})

describe('task classifier', () => {
  it('recognizes structured transformations before generic explanations', () => {
    expect(classifyTaskType('Convert this CSV to a JSON array. Reply with only JSON.')).toBe('structured-transform')
  })

  it('recognizes debugging requests with source code', () => {
    expect(classifyTaskType('Fix this bug:\n```ts\nconst value = broken()\n```')).toBe('debugging')
  })
})
