/**
 * Deterministic task-type classifier. Maps turn text to one of a small
 * set of task categories using keyword and structural analysis. No
 * embedding model — the classifier is cheap, deterministic, and
 * sufficient to test how much value categorical features provide before
 * adding semantic features.
 *
 * @module @deepseek-ai/dsh-llm-model-router/task-classifier
 */

import type { TaskType } from './shadow-types.ts'

interface TaskTypeRule {
  type: TaskType
  /** Substring or regex patterns that trigger this classification. */
  match: (text: string) => boolean
  /** Whether this task type historically benefits from Pro. */
  expectsProAdvantage: boolean
  /** Priority — lower numbers are checked first. */
  priority: number
}

const hasJson = (text: string): boolean => /\bjson\b/i.test(text) || /\{[^}]*\}/.test(text)
const hasYaml = (text: string): boolean => /\byaml\b/i.test(text) || /^[a-z]+:\s/m.test(text)
const hasCsv = (text: string): boolean => /\bcsv\b/i.test(text) || /^[a-z]+,[a-z]+/im.test(text)
const hasXml = (text: string): boolean => /\bxml\b/i.test(text) || /<[a-z]+>/.test(text)
const hasConvert = (text: string): boolean => /\bconvert\b/i.test(text) || /\btransform\b/i.test(text)
const hasCodeBlock = (text: string): boolean => /```/.test(text)
const hasFunction = (text: string): boolean =>
  /\bfunction\b/i.test(text) || /\bdef\b/i.test(text) || /=>/.test(text)
const hasBug = (text: string): boolean =>
  /\bbug\b/i.test(text) || /\berror\b/i.test(text) || /\bfix\b/i.test(text)
  || /\bwrong\b/i.test(text) || /\bincorrect\b/i.test(text)
const hasProve = (text: string): boolean =>
  /\bprove\b/i.test(text) || /\bproof\b/i.test(text) || /\btheorem\b/i.test(text)
const hasPlan = (text: string): boolean =>
  /\bplan\b/i.test(text) || /\bdesign\b/i.test(text) || /\barchitecture\b/i.test(text)
const hasExplain = (text: string): boolean =>
  /\bexplain\b/i.test(text) || /\bdescribe\b/i.test(text)
  || /\bsummarize\b/i.test(text) || /\bsummary\b/i.test(text)
const hasTool = (text: string): boolean =>
  /\btool\b/i.test(text) || /\bexecute\b/i.test(text) || /\brun\b/i.test(text)
const hasLongContext = (text: string): boolean => text.length > 800
const hasStepByStep = (text: string): boolean =>
  /\bstep\s+by\s+step\b/i.test(text) || /\breasoning\b/i.test(text)
const hasSimpleFactual = (text: string): boolean =>
  /\bwhat\b/i.test(text) || /\bwho\b/i.test(text) || /\bwhere\b/i.test(text)
  || /\bwhen\b/i.test(text) || /\bhow many\b/i.test(text)

const RULES: readonly TaskTypeRule[] = [
  {
    type: 'structured-transform',
    match: text => hasConvert(text) && (hasJson(text) || hasYaml(text) || hasCsv(text) || hasXml(text)),
    expectsProAdvantage: true,
    priority: 1,
  },
  {
    type: 'debugging',
    match: text => hasBug(text) && hasCodeBlock(text),
    expectsProAdvantage: true,
    priority: 2,
  },
  {
    type: 'code-edit',
    match: text => (hasFunction(text) || hasCodeBlock(text)) && !hasBug(text),
    expectsProAdvantage: false,
    priority: 3,
  },
  {
    type: 'reasoning-proof',
    match: text => hasProve(text) || (hasStepByStep(text) && hasLongContext(text)),
    expectsProAdvantage: true,
    priority: 4,
  },
  {
    type: 'planning',
    match: text => hasPlan(text) && !hasCodeBlock(text),
    expectsProAdvantage: false,
    priority: 5,
  },
  {
    type: 'long-context',
    match: text => hasLongContext(text) && hasExplain(text),
    expectsProAdvantage: false,
    priority: 6,
  },
  {
    type: 'tool-heavy',
    match: text => hasTool(text) && text.split(/\btool\b/i).length > 3,
    expectsProAdvantage: false,
    priority: 7,
  },
  {
    type: 'factual-explain',
    match: text => hasExplain(text) && !hasCodeBlock(text),
    expectsProAdvantage: true,
    priority: 8,
  },
  {
    type: 'simple-factual',
    match: text => hasSimpleFactual(text) && text.length < 200,
    expectsProAdvantage: false,
    priority: 9,
  },
]

/**
 * Classify a turn's text into a task type using deterministic rules.
 * Returns 'unknown' when no rule matches.
 * @param text - the turn's concatenated request text.
 */
export function classifyTaskType(text: string): TaskType {
  const sorted = [...RULES].sort((a, b) => a.priority - b.priority)
  for (const rule of sorted) {
    if (rule.match(text)) return rule.type
  }
  return 'unknown'
}

/**
 * Whether a task type historically benefits from Pro, based on the
 * v0.16.0 benchmark evidence.
 */
export function taskTypeExpectsProAdvantage(type: TaskType): boolean {
  const rule = RULES.find(r => r.type === type)
  return rule?.expectsProAdvantage ?? false
}
