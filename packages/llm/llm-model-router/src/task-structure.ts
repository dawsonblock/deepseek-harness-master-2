/** Deterministic pre-routing structure analysis for workload-v2 features. */

/** Stable workload-v2 feature schema identifier. */
export const WORKLOAD_FEATURE_VERSION = 'workload-v2' as const

/** Coarse transformation distance inferred from the request. */
export type TransformationType =
  | 'copy-extract'
  | 'reformat'
  | 'restructure'
  | 'synthesis'
  | 'generation'
  | 'none'

/** Requested output representation inferred before routing. */
export type RequestedOutputType =
  | 'prose'
  | 'json'
  | 'table'
  | 'code'
  | 'patch'
  | 'schema'
  | 'list'
  | 'email'
  | 'unknown'

/** Expected output-size band derived from explicit request bounds. */
export type OutputLengthBand = 'tiny' | 'short' | 'medium' | 'long' | 'unknown'

/** Deterministic task categories represented as one-hot scores. */
export type WorkloadTaskCategory =
  | 'factual-explain'
  | 'structured-transform'
  | 'reasoning-proof'
  | 'coding'
  | 'debugging'
  | 'extraction'
  | 'synthesis'
  | 'planning'
  | 'tool-heavy'
  | 'long-context'
  | 'verification-heavy'
  | 'multi-constraint'
  | 'simple-factual'
  | 'unknown'

/** Runtime facts known before routing but not derived from prompt text. */
export interface WorkloadContextInput {
  messageCount?: number
  attachedFileCount?: number
  toolSchemaCount?: number
  verificationCriterionCount?: number
  contextUtilizationEstimate?: number
}

/** Constraint-related prompt measurements. */
export interface ConstraintStructureFeatures {
  explicitConstraintCount: number
  numberedConstraintCount: number
  constraintKeywordCount: number
  outputFormatConstraintCount: number
  nestedConstraintCount: number
  crossReferenceCount: number
  strictFormat: boolean
  noExtraneousOutput: boolean
  exactTerminalLiteral: boolean
  exactMultiplicity: boolean
  expectedOutputCardinality: number
}

/** Transformation-distance measurements. */
export interface TransformationFeatures {
  type: TransformationType
  operationCount: number
  requiresSemanticPreservation: boolean
  sourceObjectCount: number
  sourceFieldCount: number
  outputFieldCount: number
  crossFieldConsistency: boolean
  multiStage: boolean
}

/** Requested output and execution measurements. */
export interface OutputStructureFeatures {
  requestedType: RequestedOutputType
  expectedLengthBand: OutputLengthBand
  codeBlockCount: number
  languageCount: number
  multiFileIndicator: boolean
  toolRequired: boolean
}

/** Complete workload-v2 feature vector available before routing. */
export interface WorkloadFeaturesV2 {
  featureVersion: typeof WORKLOAD_FEATURE_VERSION
  context: {
    estimatedInputTokens: number
    promptCharacters: number
    messageCount: number
    attachedFileCount: number
    toolSchemaCount: number
    verificationCriterionCount: number
    contextUtilizationEstimate: number
  }
  constraints: ConstraintStructureFeatures
  transformation: TransformationFeatures
  output: OutputStructureFeatures
  categoryScores: Record<WorkloadTaskCategory, number>
}

const CATEGORY_NAMES: readonly WorkloadTaskCategory[] = [
  'factual-explain',
  'structured-transform',
  'reasoning-proof',
  'coding',
  'debugging',
  'extraction',
  'synthesis',
  'planning',
  'tool-heavy',
  'long-context',
  'verification-heavy',
  'multi-constraint',
  'simple-factual',
  'unknown',
]

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0
}

function requestedType(text: string): RequestedOutputType {
  if (/\bjson\b/i.test(text)) return 'json'
  if (/markdown table|\btable\b/i.test(text)) return 'table'
  if (/\bpatch\b|\bdiff\b/i.test(text)) return 'patch'
  if (/\bschema\b/i.test(text)) return 'schema'
  if (/\bfunction\b|\btypescript\b|\bpython\b|\bcode only\b/i.test(text)) return 'code'
  if (/\bemail\b/i.test(text)) return 'email'
  if (/\bnumbered\b|\bbullet(?:ed)?\b|\blist\b/i.test(text)) return 'list'
  if (/explain|summari[sz]e|paragraph|sentence/i.test(text)) return 'prose'
  return 'unknown'
}

function transformationType(text: string): TransformationType {
  if (/\b(?:combine|synthesi[sz]e|reconcile|summari[sz]e)\b/i.test(text)) return 'synthesis'
  if (/\b(?:group|map|project|filter|reshape|restructure)\b/i.test(text)) return 'restructure'
  if (/\b(?:convert|reformat|format)\b/i.test(text)) return 'reformat'
  if (/\b(?:extract|select|return only|find only)\b/i.test(text)) return 'copy-extract'
  if (/\b(?:write|create|plan|explain|prove|fix|implement)\b/i.test(text)) return 'generation'
  return 'none'
}

function outputLengthBand(text: string): OutputLengthBand {
  const wordLimit = text.match(/(?:at most|no more than|of)\s+(\d+)\s+words?/i)
  const words = Number(wordLimit?.[1] ?? Number.NaN)
  if (Number.isFinite(words)) {
    if (words <= 20) return 'tiny'
    if (words <= 100) return 'short'
    if (words <= 400) return 'medium'
    return 'long'
  }
  const cardinality = explicitCardinality(text)
  if (cardinality > 0 && cardinality <= 2) return 'tiny'
  if (cardinality <= 7 && cardinality > 0) return 'short'
  if (/long|detailed|comprehensive/i.test(text)) return 'long'
  return 'unknown'
}

function wordNumber(value: string): number {
  const words: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  }
  return Number.parseInt(value, 10) || words[value.toLowerCase()] || 0
}

function explicitCardinality(text: string): number {
  const quantity = String.raw`(\d+|one|two|three|four|five|six|seven|eight|nine|ten)`
  const unit = String.raw`(?:rows?|steps?|sentences?|paragraphs?|bullets?|items?)`
  const direct = text.match(new RegExp(String.raw`\b(?:exactly|in)\s+${quantity}\s+(?:data\s+)?${unit}`, 'i'))
  if (direct !== null) return wordNumber(direct[1] ?? '')
  const perEntity = text.match(/\bone\s+(?:sentence|item|row|entry)\s+per\s+([^.]+)/i)
  if (perEntity !== null) {
    const segment = perEntity[1] ?? ''
    const directCount = segment.split(/,|\band\b/i).map(part => part.trim()).filter(Boolean).length
    if (directCount > 1) return directCount
    const namedEntities = text.match(/\b(?:roles?|fields?|items?)\s+of\s+([^.]+)/i)
    if (namedEntities !== null) {
      return (namedEntities[1] ?? '').split(/,|\band\b/i).map(part => part.trim()).filter(Boolean).length
    }
    return directCount
  }
  return 0
}

function sourceObjects(text: string): number {
  const jsonObjects = count(text, /\{[^{}]*\}/g)
  if (jsonObjects > 0) return jsonObjects
  const tableRows = count(text, /^\|.*\|\s*$/gm)
  if (tableRows > 2) return tableRows - 2
  const csvRows = text.split('\n').filter(line => line.includes(',')).length
  return csvRows > 1 ? csvRows - 1 : 1
}

function fieldCount(text: string): number {
  const keys = text.match(/\b(?:keys?|fields?|columns?)\s+([^.;\n]+)/i)
  if (keys === null) return 0
  return keys[1]?.split(/,|\band\b/i).map(field => field.trim()).filter(Boolean).length ?? 0
}

function category(text: string, constraints: ConstraintStructureFeatures): WorkloadTaskCategory {
  if (/\b(?:verify|review|is this correct|correctness|vulnerability)\b/i.test(text)) return 'verification-heavy'
  if (/\b(?:debug|bug|wrong answer|throws|race condition)\b/i.test(text)) return 'debugging'
  if (/\b(?:convert|restructure|reformat|group|filter)\b/i.test(text)
    && /\b(?:json|yaml|csv|xml|table|schema)\b/i.test(text)) return 'structured-transform'
  if (/\b(?:extract|select|find only)\b/i.test(text)) return 'extraction'
  if (/\b(?:synthesi[sz]e|combine|reconcile|summari[sz]e)\b/i.test(text)) return 'synthesis'
  if (/\b(?:function|typescript|python|code|implementation)\b/i.test(text)) return 'coding'
  if (/\b(?:prove|proof|theorem|step by step)\b/i.test(text)) return 'reasoning-proof'
  if (/\b(?:plan|migration|rollout|incident response)\b/i.test(text)) return 'planning'
  if (/\b(?:tool|execute|run command)\b/i.test(text)) return 'tool-heavy'
  if (text.length >= 800) return 'long-context'
  if (constraints.explicitConstraintCount >= 4) return 'multi-constraint'
  if (/\b(?:explain|compare|contrast|describe)\b/i.test(text)) return 'factual-explain'
  if (/^\s*(?:what|who|where|when|convert decimal)\b/i.test(text) && text.length < 200) return 'simple-factual'
  return 'unknown'
}

function categoryScores(name: WorkloadTaskCategory): Record<WorkloadTaskCategory, number> {
  return Object.fromEntries(
    CATEGORY_NAMES.map(candidate => [candidate, candidate === name ? 1 : 0]),
  ) as Record<WorkloadTaskCategory, number>
}

/**
 * Analyze a request using only prompt text and pre-routing runtime facts.
 * @param request - concatenated model-visible request text.
 * @param context - counts and estimates known before model selection.
 * @returns the immutable workload-v2 feature vector.
 */
export function analyzeTaskStructure(
  request: string,
  context: WorkloadContextInput = {},
): WorkloadFeaturesV2 {
  const numberedConstraintCount = count(request, /^\s*(?:\d+[.)]|[-*])\s+/gm)
  const constraintKeywordCount = count(
    request,
    /\b(?:must|shall|without|unless|exactly|preserve|only|at most|at least|no more than|do not|each|per)\b/gi,
  )
  const outputFormatConstraintCount = count(
    request,
    /\b(?:reply with|return only|code only|json|yaml|csv|xml|markdown table|numbered|bulleted|schema|format)\b/gi,
  )
  const nestedConstraintCount = count(request, /\b(?:while|within|for each|per|if|unless|except|where)\b/gi)
  const crossReferenceCount = count(request, /\b(?:same|corresponding|above|below|each|both|source|target|respectively)\b/gi)
  const exactMultiplicity = /\b(?:exactly|once each|one .* per|each .* once)\b/i.test(request)
  const constraints: ConstraintStructureFeatures = {
    explicitConstraintCount: numberedConstraintCount + constraintKeywordCount + outputFormatConstraintCount,
    numberedConstraintCount,
    constraintKeywordCount,
    outputFormatConstraintCount,
    nestedConstraintCount,
    crossReferenceCount,
    strictFormat: /\b(?:exactly|only json|valid json|schema|code only|no other text|once each)\b/i.test(request),
    noExtraneousOutput: /\b(?:reply with only|return only|code only|no other text|without explanation)\b/i.test(request),
    exactTerminalLiteral: /\b(?:end with|ends with|must end)\b/i.test(request),
    exactMultiplicity,
    expectedOutputCardinality: explicitCardinality(request),
  }
  const type = transformationType(request)
  const operationCount = count(
    request,
    /\b(?:copy|extract|select|filter|convert|reformat|group|map|project|preserve)\b/gi,
  ) + count(
    request,
    /\b(?:combine|synthesi[sz]e|reconcile|summari[sz]e|sort|return only)\b/gi,
  )
  const transformation: TransformationFeatures = {
    type,
    operationCount,
    requiresSemanticPreservation: /\b(?:preserve|retain|without losing|same meaning|all fields|equivalent)\b/i.test(request),
    sourceObjectCount: sourceObjects(request),
    sourceFieldCount: fieldCount(request),
    outputFieldCount: fieldCount(request),
    crossFieldConsistency: /\b(?:consistent|corresponding|match|same .* across|cross-field|dependency)\b/i.test(request),
    multiStage: operationCount >= 2 || /\b(?:then|after|before|while)\b/i.test(request),
  }
  const output: OutputStructureFeatures = {
    requestedType: requestedType(request),
    expectedLengthBand: outputLengthBand(request),
    codeBlockCount: Math.floor(count(request, /```/g) / 2),
    languageCount: count(request, /\b(?:typescript|javascript|python|json|yaml|csv|xml|sql|markdown)\b/gi),
    multiFileIndicator: /\b(?:multiple files|multi-file|across files|several files)\b/i.test(request),
    toolRequired: /\b(?:use|run|execute)\s+(?:a\s+)?(?:tool|command|test)\b/i.test(request),
  }
  const categoryName = category(request, constraints)
  return {
    featureVersion: WORKLOAD_FEATURE_VERSION,
    context: {
      estimatedInputTokens: Math.ceil(request.length / 4),
      promptCharacters: request.length,
      messageCount: context.messageCount ?? 1,
      attachedFileCount: context.attachedFileCount ?? 0,
      toolSchemaCount: context.toolSchemaCount ?? 0,
      verificationCriterionCount: context.verificationCriterionCount ?? 0,
      contextUtilizationEstimate: context.contextUtilizationEstimate ?? 0,
    },
    constraints,
    transformation,
    output,
    categoryScores: categoryScores(categoryName),
  }
}
