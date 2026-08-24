/**
 * Deterministic turn-complexity scoring for tiered model routing. Pure text
 * heuristics only: the same turn text always yields the same reading, so a
 * replayed session routes identically and the routing policy can be reasoned
 * about without touching a provider.
 *
 * Calibration contract (v2): NO single signal family can reach the escalation
 * threshold alone. Every family's point cap is strictly below the default
 * threshold of 4, so escalation always requires either one explicit
 * deep-reasoning request plus a corroborating signal from another family, or
 * several independent families agreeing. Long-but-trivial input, a pile of
 * math vocabulary, or a stack of code blocks can each contribute at most
 * supporting evidence — never the whole decision.
 *
 * @module @deepseek-ai/dsh-llm-model-router/complexity
 */

/** Version stamped into durable routing decisions for later correlation. */
export const SCORER_VERSION = 2

/** Default escalation threshold: readings at or above it serve the heavy route. */
export const DEFAULT_ESCALATION_THRESHOLD = 4

/** Points per matched explicit deep-reasoning request. */
const EXPLICIT_REASONING_POINTS = 3
/** Points per matched formal-reasoning marker. */
const MATH_POINTS = 1
/** Points per matched system-design marker. */
const ARCHITECTURE_POINTS = 1
/** Points per fenced code block. */
const CODE_BLOCK_POINTS = 1
/** Characters per length band of prompt text. */
const LENGTH_BAND_CHARS = 800

/**
 * Per-family caps, each strictly below {@link DEFAULT_ESCALATION_THRESHOLD} so
 * the calibration contract holds even when the threshold is left at its
 * default. A deployment that lowers the threshold below a cap deliberately
 * opts that family into standalone escalation.
 */
const EXPLICIT_REASONING_CAP = 3
const MATH_CAP = 3
const ARCHITECTURE_CAP = 3
const CODE_BLOCK_CAP = 2
const LENGTH_CAP = 2

/**
 * Explicit user requests for deep reasoning (English). Patterns are disjoint
 * by construction so one phrasing never double-counts: the verb-intensifier
 * family does not include "step by step", which has its own pattern.
 */
const EXPLICIT_REASONING_PATTERNS: readonly RegExp[] = [
  /\b(?:think|reason)\s+(?:hard|harder|deeply|carefully|thoroughly|through|more)\b/i,
  /\bstep[- ]by[- ]step\b/i,
  /\bultrathink\b/i,
  /\bin\s+depth\b/i,
  /\b(?:take|spend)\s+(?:your|some)\s+time\b/i,
]

/**
 * Explicit deep-reasoning requests written in Simplified Chinese. Matched by
 * substring count rather than `\b` regexes: CJK text has no word boundaries
 * for `\b` to anchor on.
 */
const EXPLICIT_REASONING_CJK: readonly string[] = [
  '一步一步', '一步步', '逐步', '深入思考', '仔细想', '认真思考', '花点时间', '深思熟虑',
]

/** Formal-reasoning vocabulary (English): proofs, derivations, mathematical objects. */
const MATH_PATTERNS: readonly RegExp[] = [
  /\bprove\b/i,
  /\bproof\b/i,
  /\btheorem\b/i,
  /\blemma\b/i,
  /\bcorollary\b/i,
  /\bderiv(?:e|ation)\b/i,
  /\binduction\b/i,
  /\bintegral\b/i,
  /\bpolynomial\b/i,
  /\bequation\b/i,
  /\bcombinator(?:ics|ial)\b/i,
]

/** Formal-reasoning vocabulary (Simplified Chinese). */
const MATH_CJK: readonly string[] = [
  '证明', '定理', '推导', '公式', '方程', '归纳', '积分', '多项式', '组合数学', '枚举',
]

/** System-design vocabulary (English): architecture-shaped work over many components. */
const ARCHITECTURE_PATTERNS: readonly RegExp[] = [
  /\barchitect(?:ure|ural|ing)?\b/i,
  /\brefactor\b/i,
  /\bmigrat(?:e|ion)\b/i,
  /\bredesign\b/i,
  /\bdistributed\b/i,
  /\bscal(?:e|es|ing|ability|able)\b/i,
  /\bsubsystem\b/i,
  /\binfrastructure\b/i,
  /\bmulti[- ](?:file|step|node)\b/i,
  /\bsynthesis\b/i,
]

/** System-design vocabulary (Simplified Chinese). */
const ARCHITECTURE_CJK: readonly string[] = [
  '架构', '重构', '分布式', '可扩展', '扩展性', '子系统', '基础设施', '多文件', '迁移', '并发', '竞态',
]

/** Count every match of one regex pattern family against `text`. */
function countRegexMatches(text: string, patterns: readonly RegExp[]): number {
  let total = 0
  for (const pattern of patterns) {
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
    total += text.match(global)?.length ?? 0
  }
  return total
}

/** Count non-overlapping substring occurrences (CJK and configured markers). */
function countSubstringMatches(text: string, markers: readonly string[]): number {
  let total = 0
  for (const marker of markers) {
    if (marker.length === 0) continue
    let at = text.indexOf(marker)
    while (at !== -1) {
      total += 1
      at = text.indexOf(marker, at + marker.length)
    }
  }
  return total
}

/** Canonical comparison form for configured markers: trimmed, lowercased, NFC. */
export function normalizeMarker(marker: string): string {
  return marker.trim().toLowerCase().normalize('NFC')
}

/**
 * Assert that the configured marker vocabulary keeps signal families honest.
 * A marker is rejected when it duplicates another configured marker across
 * families (one occurrence would count as two "independent" signals — fake
 * corroboration), duplicates a configured marker within its own family
 * (double-counting), or matches any built-in family's vocabulary — in another
 * family that is fake cross-family evidence, and in its own family it would
 * double-count beside the built-in match.
 * @param extra - deployment-configured marker lists.
 * @throws naming the marker and both families implicated.
 */
export function assertDistinctMarkers(extra: ExtraMarkers): void {
  const builtins: ReadonlyArray<readonly [string, readonly RegExp[], readonly string[]]> = [
    ['reasoning', EXPLICIT_REASONING_PATTERNS, EXPLICIT_REASONING_CJK],
    ['math', MATH_PATTERNS, MATH_CJK],
    ['architecture', ARCHITECTURE_PATTERNS, ARCHITECTURE_CJK],
  ]
  const seen = new Map<string, string>()
  for (const [family, list] of Object.entries(extra) as Array<[string, string[] | undefined]>) {
    if (list === undefined) continue
    for (const marker of list) {
      const normalized = normalizeMarker(marker)
      const priorFamily = seen.get(normalized)
      if (priorFamily === family) {
        throw new Error(
          `llm-model-router: extraMarkers.${family} duplicates ${JSON.stringify(marker)} after normalization; a marker counts once`,
        )
      }
      if (priorFamily !== undefined) {
        throw new Error(
          `llm-model-router: extraMarkers marker ${JSON.stringify(marker)} (${family}) duplicates the ${priorFamily} family after normalization; `
          + 'one marker must belong to exactly one family or cross-family corroboration becomes fake evidence',
        )
      }
      seen.set(normalized, family)
      for (const [builtinFamily, patterns, cjk] of builtins) {
        const conflict = countRegexMatches(marker, patterns) > 0 || countSubstringMatches(marker, cjk) > 0
        if (!conflict) continue
        throw new Error(
          `llm-model-router: extraMarkers marker ${JSON.stringify(marker)} (${family}) matches the built-in ${builtinFamily} vocabulary`
          + (builtinFamily === family ? ' and would double-count beside it' : ' and would fake cross-family corroboration'),
        )
      }
    }
  }
}

/** Deployment-supplied extra markers per family; plain substrings, counted as-is. */
export interface ExtraMarkers {
  /** Additional explicit deep-reasoning markers. */
  reasoning?: string[]
  /** Additional formal-reasoning markers. */
  math?: string[]
  /** Additional system-design markers. */
  architecture?: string[]
}

/** The individual signal counts behind one complexity reading. */
export interface ComplexitySignals {
  /** Matched explicit deep-reasoning requests (English + CJK + configured). */
  readonly explicitReasoningRequests: number
  /** Matched formal-reasoning markers. */
  readonly mathMarkers: number
  /** Matched system-design markers. */
  readonly architectureMarkers: number
  /** Fenced code blocks (paired fence markers, an unclosed tail counts as one). */
  readonly codeBlocks: number
  /** Length bands of prompt text (800 characters each). */
  readonly lengthBands: number
}

/** One turn's complexity: the total score plus its signal breakdown. */
export interface ComplexityReading {
  /** Capped sum of all signal points. */
  readonly score: number
  /** Raw per-signal counts, for logging, events, and tests. */
  readonly signals: ComplexitySignals
}

/**
 * Score one turn's human-authored text for routing.
 *
 * Scoring is additive with per-family caps, every cap strictly below the
 * default threshold: an explicit reasoning request is worth 3 points,
 * formal-reasoning and system-design markers 1 each, a fenced code block 1,
 * and each 800 characters of prompt text 1. English markers match as
 * word-boundary regexes; CJK and deployment-configured markers match as plain
 * substrings (CJK has no word boundaries). `extra` markers join the CJK
 * counting path, so a deployment can grow the vocabulary for its own language
 * without shipping regexes.
 * @param text - the turn's concatenated request text.
 * @param extra - deployment-configured marker lists.
 * @returns the capped total and the raw signal counts.
 */
export function scoreComplexity(text: string, extra: ExtraMarkers = {}): ComplexityReading {
  const explicitReasoningRequests = countRegexMatches(text, EXPLICIT_REASONING_PATTERNS)
    + countSubstringMatches(text, [...EXPLICIT_REASONING_CJK, ...(extra.reasoning ?? [])])
  const mathMarkers = countRegexMatches(text, MATH_PATTERNS)
    + countSubstringMatches(text, [...MATH_CJK, ...(extra.math ?? [])])
  const architectureMarkers = countRegexMatches(text, ARCHITECTURE_PATTERNS)
    + countSubstringMatches(text, [...ARCHITECTURE_CJK, ...(extra.architecture ?? [])])
  const fenceMarkers = text.match(/^```/gm)?.length ?? 0
  const codeBlocks = Math.ceil(fenceMarkers / 2)
  const lengthBands = Math.floor(text.length / LENGTH_BAND_CHARS)
  const score = Math.min(EXPLICIT_REASONING_POINTS * explicitReasoningRequests, EXPLICIT_REASONING_CAP)
    + Math.min(MATH_POINTS * mathMarkers, MATH_CAP)
    + Math.min(ARCHITECTURE_POINTS * architectureMarkers, ARCHITECTURE_CAP)
    + Math.min(CODE_BLOCK_POINTS * codeBlocks, CODE_BLOCK_CAP)
    + Math.min(lengthBands, LENGTH_CAP)
  return {
    score,
    signals: { explicitReasoningRequests, mathMarkers, architectureMarkers, codeBlocks, lengthBands },
  }
}

/**
 * Whether one family's capped contribution alone reaches the threshold — the
 * calibration contract's runtime check. Exported for the source guard and
 * tests so the "no family escalates alone" promise stays machine-verified.
 * @param threshold - configured escalation threshold.
 * @returns whether every family cap is strictly below the threshold.
 */
export function noFamilyAloneReaches(threshold: number): boolean {
  return EXPLICIT_REASONING_CAP < threshold
    && MATH_CAP < threshold
    && ARCHITECTURE_CAP < threshold
    && CODE_BLOCK_CAP < threshold
    && LENGTH_CAP < threshold
}
