/**
 * Shadow-mode routing types. The learned router predicts what it would
 * select; the heuristic router retains control. Every shadow prediction
 * is recorded durably so offline evaluation can compare shadow vs actual
 * outcomes using paired/counterfactual evidence from the benchmark.
 *
 * @module @deepseek-ai/dsh-llm-model-router/shadow-types
 */

/** Structural features extractable from the session before routing. */
export interface StructuralFeatures {
  /** Estimated input token count at the pre-routing phase. */
  estimatedInputTokens: number
  /** Number of user messages in the session so far. */
  messageCount: number
  /** Number of tool schemas visible to the model. */
  toolSchemaCount: number
  /** Number of attached or retrieved files in context. */
  attachedFileCount: number
  /** Fenced code block count in the current turn's user text. */
  codeBlockCount: number
  /** Character count of structured-data markers (JSON, YAML, CSV, XML). */
  structuredDataSize: number
  /** Whether the turn requests a specific output format. */
  requestsStructuredOutput: boolean
  /** Whether the turn mentions JSON or schema transformation. */
  jsonTransformationIndicator: boolean
  /** Whether the turn references multiple files. */
  multiFileIndicator: boolean
  /** Whether the turn explicitly requests tool use. */
  toolRequirementIndicator: boolean
  /** Number of verification criteria the task declares (when known). */
  verificationCriterionCount: number
}

/** Deterministic task-type classification from text analysis. */
export type TaskType =
  | 'factual-explain'
  | 'structured-transform'
  | 'reasoning-proof'
  | 'code-edit'
  | 'debugging'
  | 'planning'
  | 'tool-heavy'
  | 'long-context'
  | 'simple-factual'
  | 'unknown'

/** Categorical features derived from task-type classification. */
export interface CategoricalFeatures {
  taskType: TaskType
  /** Whether the task type historically benefits from Pro. */
  expectsProAdvantage: boolean
}

/** Historical outcome features computed from past tasks only. */
export interface HistoricalFeatures {
  /** Flash success rate for the same task type (from past data). */
  flashSuccessRateByTaskType: number
  /** Pro success rate for the same task type (from past data). */
  proSuccessRateByTaskType: number
  /** Flash-to-Pro rescue rate for the same task type. */
  flashToProRescueRate: number
  /** Recent Flash failure rate (rolling window). */
  recentFlashFailureRate: number
  /** Historical median cost difference (Pro - Flash) for this task type. */
  historicalCostDifference: number
  /** Number of historical samples for this task type. */
  historicalSampleCount: number
}

/** Complete pre-routing feature vector for the learned predictor. */
export interface PreRoutingFeatureVector {
  /** Feature schema version, incremented when features change. */
  featureVersion: number
  /** Complexity scorer signals (from the existing heuristic router). */
  complexity: {
    explicitReasoningRequests: number
    mathMarkers: number
    architectureMarkers: number
    codeBlocks: number
    lengthBands: number
    complexityScore: number
    promptLength: number
  }
  /** Structural features from session context. */
  structural: StructuralFeatures
  /** Categorical features from task-type classification. */
  categorical: CategoricalFeatures
  /** Historical outcome features from past tasks. */
  historical: HistoricalFeatures
}

/** Multi-target model predictions. */
export interface ModelPredictions {
  /** P(Flash passes) — probability Flash completes with verified success. */
  pFlashPass: number
  /** P(Pro passes) — probability Pro completes with verified success. */
  pProPass: number
  /** Expected cost difference (Pro - Flash), in USD. */
  expectedCostDelta: number
  /** Whether the model recommends Pro over Flash. */
  recommendsPro: boolean
  /** Model schema version. */
  modelVersion: number
  /** Confidence of the recommendation (0–1). */
  confidence: number
}
