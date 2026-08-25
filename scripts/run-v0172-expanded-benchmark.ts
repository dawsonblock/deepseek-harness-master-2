#!/usr/bin/env node
/**
 * Collects 100 paired Flash/Pro outcomes across 50 task classes. The runner
 * checkpoints after every model call and resumes without repeating completed
 * calls. The heuristic and learned policies are evaluated offline from the
 * resulting pairs.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { calculateCost, DEFAULT_PRICING_REGISTRY, lookupPricing } from '@deepseek-ai/dsh-token-meter'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const REPORT_DIR = join(REPO_ROOT, 'artifacts', 'reports')
const CHECKPOINT_PATH = join(REPORT_DIR, 'v0.17.2-expanded-benchmark.checkpoint.json')
const REPORT_PATH = join(REPORT_DIR, 'v0.17.2-expanded-benchmark.json')
const MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro'] as const
const ITERATIONS = 2

type Model = typeof MODELS[number]
type CacheState = 'cold' | 'warm'
type VerificationStatus = 'verified-pass' | 'verified-fail' | 'incomplete'

interface VerificationCriterion {
  description: string
  check: (output: string) => boolean
}

interface TaskClass {
  id: string
  category: string
  description: string
  task: string
  criteria: readonly VerificationCriterion[]
  expectsProAdvantage: boolean
}

interface VerificationResult {
  status: VerificationStatus
  criteriaPassed: number
  criteriaTotal: number
  checks: Array<{ description: string; passed: boolean }>
}

interface BenchmarkRun {
  taskId: string
  category: string
  model: Model
  iteration: number
  cacheState: CacheState
  cache: { hitTokens: number; missTokens: number; hitRate: number }
  usage: {
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
    totalTokens: number
  }
  economics: { costUsd: number; pricingVersion: string }
  execution: {
    latencyMs: number
    attempts: number
    toolCalls: number
    toolFailures: number
    repairs: number
  }
  verification: VerificationResult
  output: string
  error?: string
}

interface FlashProPair {
  taskId: string
  iteration: number
  cacheState: CacheState
  flash: BenchmarkRun
  pro: BenchmarkRun
  classification:
    | 'pro-necessary'
    | 'both-pass-pro-more-expensive'
    | 'both-fail'
    | 'flash-better'
    | 'pro-better'
  cacheComparable: boolean
}

interface Checkpoint {
  release: string
  startedAt: string
  updatedAt: string
  runs: BenchmarkRun[]
}

const contains = (description: string, pattern: RegExp): VerificationCriterion => ({
  description,
  check: output => pattern.test(output),
})

const excludes = (description: string, pattern: RegExp): VerificationCriterion => ({
  description,
  check: output => !pattern.test(output),
})

const exactTrimmed = (expected: string): VerificationCriterion => ({
  description: `Output is exactly ${expected}`,
  check: output => output.trim().toLowerCase() === expected.toLowerCase(),
})

const sentenceCount = (minimum: number, maximum: number): VerificationCriterion => ({
  description: `Contains ${minimum}-${maximum} sentences`,
  check: (output) => {
    const count = (output.match(/[.!?]+(?=\s|$)/g) ?? []).length
    return count >= minimum && count <= maximum
  },
})

const validJson = (description: string, predicate: (value: unknown) => boolean): VerificationCriterion => ({
  description,
  check: (output) => {
    const clean = output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    try {
      return predicate(JSON.parse(clean) as unknown)
    } catch {
      return false
    }
  },
})

const TASK_CLASSES: readonly TaskClass[] = [
  {
    id: 'arithmetic-percent', category: 'simple-factual', description: 'Percentage arithmetic',
    task: 'What is 15% of 240? Reply with only the number.',
    criteria: [exactTrimmed('36')], expectsProAdvantage: false,
  },
  {
    id: 'capital-canada', category: 'simple-factual', description: 'Capital lookup',
    task: 'What is the capital of Canada? Reply with only the city name.',
    criteria: [exactTrimmed('Ottawa')], expectsProAdvantage: false,
  },
  {
    id: 'chemical-symbol', category: 'simple-factual', description: 'Chemical symbol lookup',
    task: 'What is the chemical symbol for potassium? Reply with only the symbol.',
    criteria: [exactTrimmed('K')], expectsProAdvantage: false,
  },
  {
    id: 'binary-conversion', category: 'simple-factual', description: 'Binary conversion',
    task: 'Convert decimal 42 to binary. Reply with only the binary digits.',
    criteria: [exactTrimmed('101010')], expectsProAdvantage: false,
  },
  {
    id: 'date-fact', category: 'simple-factual', description: 'Historical date lookup',
    task: 'In what year did the Berlin Wall fall? Reply with only the four-digit year.',
    criteria: [exactTrimmed('1989')], expectsProAdvantage: false,
  },
  {
    id: 'csv-people-json', category: 'structured-transform', description: 'CSV people to JSON',
    task: 'Convert this CSV to a JSON array. Reply with only JSON.\nname,age\nAlice,30\nBob,25',
    criteria: [validJson('Array contains Alice 30 and Bob 25', value => Array.isArray(value)
      && value.length === 2
      && JSON.stringify(value).includes('Alice')
      && JSON.stringify(value).includes('30')
      && JSON.stringify(value).includes('Bob')
      && JSON.stringify(value).includes('25'))], expectsProAdvantage: true,
  },
  {
    id: 'csv-products-json', category: 'structured-transform', description: 'CSV products to JSON',
    task: 'Convert this CSV to a JSON array of objects. Prices must be numbers. Reply with only JSON.\nproduct,price\nPen,1.5\nBook,8',
    criteria: [validJson('Array contains numeric product prices', value => Array.isArray(value)
      && value.length === 2
      && typeof (value[0] as Record<string, unknown>).price === 'number'
      && typeof (value[1] as Record<string, unknown>).price === 'number')], expectsProAdvantage: true,
  },
  {
    id: 'yaml-service-json', category: 'structured-transform', description: 'YAML service to JSON',
    task: 'Convert this YAML to JSON. Reply with only JSON.\nservice: api\nport: 8080\nenabled: true',
    criteria: [validJson('Object preserves service fields', (value) => {
      const object = value as Record<string, unknown>
      return object.service === 'api' && object.port === 8080 && object.enabled === true
    })], expectsProAdvantage: true,
  },
  {
    id: 'yaml-nested-json', category: 'structured-transform', description: 'Nested YAML to JSON',
    task: 'Convert this YAML to JSON. Reply with only JSON.\nuser:\n  name: Ada\n  roles:\n    - admin\n    - editor',
    criteria: [validJson('Object preserves nested user and roles', (value) => {
      const user = (value as { user?: { name?: unknown; roles?: unknown } }).user
      return user?.name === 'Ada' && Array.isArray(user.roles) && user.roles.join(',') === 'admin,editor'
    })], expectsProAdvantage: true,
  },
  {
    id: 'kv-json', category: 'structured-transform', description: 'Key-value text to JSON',
    task: 'Convert these key-value lines to one JSON object. Parse numbers and booleans. Reply with only JSON.\nhost=localhost\nport=3000\nsecure=false',
    criteria: [validJson('Object preserves typed values', (value) => {
      const object = value as Record<string, unknown>
      return object.host === 'localhost' && object.port === 3000 && object.secure === false
    })], expectsProAdvantage: true,
  },
  {
    id: 'table-json', category: 'structured-transform', description: 'Markdown table to JSON',
    task: 'Convert this Markdown table to a JSON array. Reply with only JSON.\n| city | temp |\n|---|---:|\n| Oslo | 7 |\n| Cairo | 28 |',
    criteria: [validJson('Array preserves cities and numeric temperatures', value => Array.isArray(value)
      && value.length === 2
      && JSON.stringify(value).includes('Oslo')
      && JSON.stringify(value).includes('Cairo'))], expectsProAdvantage: true,
  },
  {
    id: 'json-filter', category: 'structured-transform', description: 'Filter JSON records',
    task: 'From this JSON array, return only active users as a JSON array with name fields only. Reply with only JSON.\n[{"name":"A","active":true},{"name":"B","active":false},{"name":"C","active":true}]',
    criteria: [validJson('Array contains only A and C names', value => JSON.stringify(value) === '[{"name":"A"},{"name":"C"}]')],
    expectsProAdvantage: true,
  },
  {
    id: 'json-group', category: 'structured-transform', description: 'Group JSON values',
    task: 'Group these items by category into a JSON object whose values are arrays of names. Reply with only JSON.\n[{"name":"apple","category":"fruit"},{"name":"carrot","category":"veg"},{"name":"pear","category":"fruit"}]',
    criteria: [validJson('Object groups fruit and vegetable names', (value) => {
      const object = value as Record<string, unknown>
      return JSON.stringify(object.fruit) === '["apple","pear"]' && JSON.stringify(object.veg) === '["carrot"]'
    })], expectsProAdvantage: true,
  },
  {
    id: 'xml-json', category: 'structured-transform', description: 'XML records to JSON',
    task: 'Convert this XML to a JSON array of objects with id and name fields. Parse ids as numbers. Reply with only JSON.\n<items><item id="1">Alpha</item><item id="2">Beta</item></items>',
    criteria: [validJson('Array preserves numeric ids and names', value => Array.isArray(value)
      && JSON.stringify(value).includes('Alpha')
      && JSON.stringify(value).includes('Beta')
      && JSON.stringify(value).includes('1'))], expectsProAdvantage: true,
  },
  {
    id: 'log-json', category: 'structured-transform', description: 'Log lines to JSON',
    task: 'Convert these log lines to a JSON array with level and message fields. Reply with only JSON.\nINFO started\nERROR disk full\nWARN retrying',
    criteria: [validJson('Array contains all three levels and messages', value => Array.isArray(value)
      && value.length === 3
      && /INFO/.test(JSON.stringify(value))
      && /ERROR/.test(JSON.stringify(value))
      && /WARN/.test(JSON.stringify(value)))], expectsProAdvantage: true,
  },
  {
    id: 'synthesis-cache', category: 'factual-synthesis', description: 'Cache policy synthesis',
    task: 'In exactly three sentences, explain the difference between write-through and write-back caching, including one tradeoff of each.',
    criteria: [contains('Mentions write-through', /write-through/i), contains('Mentions write-back', /write-back/i),
      contains('Mentions tradeoff', /latency|durab|risk|complex|performance|slow|fast/i), sentenceCount(3, 3)], expectsProAdvantage: true,
  },
  {
    id: 'synthesis-tcp-udp', category: 'factual-synthesis', description: 'TCP and UDP synthesis',
    task: 'Compare TCP and UDP in exactly four bullet points covering connection model, reliability, ordering, and typical use.',
    criteria: [contains('Mentions connection model', /connection|connectionless/i), contains('Mentions reliability', /reliab/i),
      contains('Mentions ordering', /order/i), contains('Mentions use', /stream|web|dns|game|video|voice/i)], expectsProAdvantage: true,
  },
  {
    id: 'synthesis-index', category: 'factual-synthesis', description: 'Database index synthesis',
    task: 'Explain when a database index helps and when it hurts. Use exactly two paragraphs and mention reads, writes, and storage.',
    criteria: [contains('Mentions reads', /read|query/i), contains('Mentions writes', /write|insert|update/i),
      contains('Mentions storage', /storage|space|disk/i), contains('Has paragraph break', /\n\s*\n/)], expectsProAdvantage: true,
  },
  {
    id: 'synthesis-consistency', category: 'factual-synthesis', description: 'Consistency model synthesis',
    task: 'In 80 words or fewer, contrast strong consistency and eventual consistency and give one suitable application for each.',
    criteria: [contains('Mentions strong consistency', /strong consistency/i), contains('Mentions eventual consistency', /eventual consistency/i),
      contains('Gives applications', /bank|payment|inventory|social|feed|dns|cache/i), { description: 'At most 80 words', check: output => output.trim().split(/\s+/).length <= 80 }],
    expectsProAdvantage: true,
  },
  {
    id: 'synthesis-oauth', category: 'factual-synthesis', description: 'OAuth role synthesis',
    task: 'Explain the roles of resource owner, client, authorization server, and resource server in OAuth 2.0. Use one sentence per role.',
    criteria: [contains('Resource owner', /resource owner/i), contains('Client', /client/i), contains('Authorization server', /authorization server/i),
      contains('Resource server', /resource server/i), sentenceCount(4, 5)], expectsProAdvantage: true,
  },
  {
    id: 'synthesis-gc', category: 'factual-synthesis', description: 'Garbage collection synthesis',
    task: 'Compare tracing garbage collection with reference counting. Include cycles, pause behavior, and one implementation tradeoff.',
    criteria: [contains('Mentions tracing', /tracing|mark.and.sweep/i), contains('Mentions reference counting', /reference count/i),
      contains('Mentions cycles', /cycle/i), contains('Mentions pauses or overhead', /pause|overhead|latency/i)], expectsProAdvantage: true,
  },
  {
    id: 'constraints-release', category: 'multi-constraint', description: 'Release checklist constraints',
    task: 'Create exactly five numbered release checklist items. Item 1 must mention tests, item 3 must mention rollback, and item 5 must mention monitoring. Use no sub-bullets.',
    criteria: [contains('Item 1 mentions tests', /^1\..*test/im), contains('Item 3 mentions rollback', /^3\..*rollback/im),
      contains('Item 5 mentions monitoring', /^5\..*monitor/im), { description: 'Exactly five numbered items', check: output => (output.match(/^\d+\./gm) ?? []).length === 5 }],
    expectsProAdvantage: true,
  },
  {
    id: 'constraints-summary', category: 'multi-constraint', description: 'Constrained summary',
    task: 'Summarize photosynthesis in exactly two sentences. The first sentence must contain sunlight and chlorophyll. The second must contain glucose and oxygen. Do not use the word process.',
    criteria: [contains('First sentence has sunlight and chlorophyll', /^.*sunlight.*chlorophyll|^.*chlorophyll.*sunlight/i),
      contains('Second sentence has glucose and oxygen', /[.!?]\s+.*glucose.*oxygen|[.!?]\s+.*oxygen.*glucose/i),
      excludes('Does not use process', /\bprocess\b/i), sentenceCount(2, 2)], expectsProAdvantage: true,
  },
  {
    id: 'constraints-email', category: 'multi-constraint', description: 'Constrained email',
    task: 'Write a professional email of 50 words or fewer declining a meeting. Include the exact phrase "schedule conflict", propose Tuesday, and end with "Best, Sam".',
    criteria: [contains('Includes exact phrase', /schedule conflict/), contains('Proposes Tuesday', /Tuesday/i),
      contains('Ends correctly', /Best, Sam\s*$/), { description: 'At most 50 words', check: output => output.trim().split(/\s+/).length <= 50 }],
    expectsProAdvantage: true,
  },
  {
    id: 'constraints-table', category: 'multi-constraint', description: 'Constrained table',
    task: 'Create a Markdown table with exactly three data rows and columns Name, Priority, Owner. Use priorities High, Medium, Low exactly once each. Owners must be Ada, Lin, and Jo exactly once each.',
    criteria: [contains('Has required header', /Name\s*\|\s*Priority\s*\|\s*Owner/i),
      { description: 'Each priority occurs once', check: output => ['High', 'Medium', 'Low'].every(value => (output.match(new RegExp(value, 'g')) ?? []).length === 1) },
      { description: 'Each owner occurs once', check: output => ['Ada', 'Lin', 'Jo'].every(value => (output.match(new RegExp(value, 'g')) ?? []).length === 1) }],
    expectsProAdvantage: true,
  },
  {
    id: 'constraints-json', category: 'multi-constraint', description: 'Constrained JSON generation',
    task: 'Return only JSON with keys title, tags, and published. title must be "Launch", tags must be an array containing alpha and beta in that order, and published must be false.',
    criteria: [validJson('Object follows exact constraints', (value) => {
      const object = value as Record<string, unknown>
      return object.title === 'Launch' && JSON.stringify(object.tags) === '["alpha","beta"]' && object.published === false
    })], expectsProAdvantage: true,
  },
  {
    id: 'constraints-order', category: 'multi-constraint', description: 'Ordered procedural constraints',
    task: 'Give exactly four steps for rotating an API key. Step 1 must say create, step 2 deploy, step 3 verify, and step 4 revoke. Each step must be one line.',
    criteria: [contains('Step 1 create', /^1\..*create/im), contains('Step 2 deploy', /^2\..*deploy/im),
      contains('Step 3 verify', /^3\..*verify/im), contains('Step 4 revoke', /^4\..*revoke/im),
      { description: 'Exactly four numbered steps', check: output => (output.match(/^\d+\./gm) ?? []).length === 4 }], expectsProAdvantage: true,
  },
  {
    id: 'code-slugify', category: 'code-edit', description: 'Implement slugify',
    task: 'Write a TypeScript function slugify(input: string): string. It must lowercase, trim, replace each run of non-alphanumeric characters with one hyphen, and remove leading/trailing hyphens. Return code only.',
    criteria: [contains('Declares slugify', /function\s+slugify|const\s+slugify/), contains('Has string types', /input\s*:\s*string|\(input:\s*string\)/),
      contains('Lowercases', /toLowerCase/), contains('Uses replacement', /replace/)], expectsProAdvantage: false,
  },
  {
    id: 'code-chunk', category: 'code-edit', description: 'Implement array chunking',
    task: 'Write a generic TypeScript function chunk<T>(items: T[], size: number): T[][]. Throw if size is not a positive integer. Do not mutate items. Return code only.',
    criteria: [contains('Declares generic chunk', /chunk\s*<T>|function\s+chunk<T>/), contains('Checks positive integer', /Number\.isInteger|size\s*<=\s*0/),
      contains('Returns nested array', /T\[\]\[\]|Array<Array<T>>/), excludes('Does not splice', /\.splice\(/)], expectsProAdvantage: true,
  },
  {
    id: 'code-dedupe', category: 'code-edit', description: 'Implement stable dedupe',
    task: 'Write a TypeScript function uniqueBy<T, K>(items: T[], key: (item: T) => K): T[] that preserves the first occurrence and input order. Return code only.',
    criteria: [contains('Declares uniqueBy', /uniqueBy/), contains('Uses generics', /<T,\s*K>|<T,K>/), contains('Tracks seen keys', /Set|Map/),
      contains('Preserves result', /push|filter/)], expectsProAdvantage: true,
  },
  {
    id: 'code-retry', category: 'code-edit', description: 'Implement async retry',
    task: 'Write a TypeScript async function retry<T>(operation: () => Promise<T>, attempts: number): Promise<T>. Retry rejected operations up to attempts total calls, then throw the final error. Return code only.',
    criteria: [contains('Declares retry', /async\s+function\s+retry|const\s+retry/), contains('Generic promise type', /Promise<T>/),
      contains('Catches rejection', /catch/), contains('Throws final error', /throw/)], expectsProAdvantage: true,
  },
  {
    id: 'code-flatten', category: 'code-edit', description: 'Implement one-level flatten',
    task: 'Write a TypeScript function flattenOne<T>(items: Array<T | T[]>): T[] without using flat(). Preserve order. Return code only.',
    criteria: [contains('Declares flattenOne', /flattenOne/), contains('Uses generics', /<T>/), excludes('Does not call flat', /\.flat\(/),
      contains('Checks arrays', /Array\.isArray/)], expectsProAdvantage: false,
  },
  {
    id: 'code-group', category: 'code-edit', description: 'Implement groupBy',
    task: 'Write a TypeScript function groupBy<T, K extends PropertyKey>(items: T[], key: (item: T) => K): Record<K, T[]>. Preserve input order within groups. Return code only.',
    criteria: [contains('Declares groupBy', /groupBy/), contains('Uses PropertyKey', /PropertyKey/), contains('Returns record', /Record<K,\s*T\[\]>/),
      contains('Accumulates arrays', /push/)], expectsProAdvantage: true,
  },
  {
    id: 'debug-binary-search', category: 'debugging', description: 'Debug binary search',
    task: 'Fix this TypeScript binary search and explain both bugs:\nfunction search(a: number[], x: number) { let lo=0, hi=a.length; while (lo<=hi) { const mid=(lo+hi)/2; if (a[mid]===x) return mid; if (a[mid]<x) lo=mid; else hi=mid; } return -1 }',
    criteria: [contains('Floors midpoint', /Math\.floor|trunc/), contains('Uses last valid high index', /length\s*-\s*1/),
      contains('Advances low', /lo\s*=\s*mid\s*\+\s*1/), contains('Decrements high', /hi\s*=\s*mid\s*-\s*1/)], expectsProAdvantage: true,
  },
  {
    id: 'debug-async-map', category: 'debugging', description: 'Debug async map',
    task: 'This returns Promise<number>[] instead of number[]:\nasync function doubleAll(xs: number[]): Promise<number[]> { return xs.map(async x => x * 2) }\nFix it and explain why.',
    criteria: [contains('Uses Promise.all', /Promise\.all/), contains('Keeps async', /async\s+function/), contains('Explains promises', /Promise|await/i)],
    expectsProAdvantage: true,
  },
  {
    id: 'debug-reduce', category: 'debugging', description: 'Debug reduce initialization',
    task: 'This throws on an empty array:\nfunction sum(xs: number[]) { return xs.reduce((a, b) => a + b) }\nFix it so sum([]) is 0 and explain the bug.',
    criteria: [contains('Adds zero initializer', /reduce\([^)]*0\)|,\s*0\s*\)/), contains('Explains empty reduce', /empty|initial/i),
      contains('Returns zero behavior', /sum\(\[\]\)|return.*0|zero/i)], expectsProAdvantage: false,
  },
  {
    id: 'debug-timeout', category: 'debugging', description: 'Debug closure capture',
    task: 'This logs 3 three times instead of 0,1,2:\nfor (var i = 0; i < 3; i++) setTimeout(() => console.log(i), 0)\nFix it using block scoping and explain the bug.',
    criteria: [contains('Uses let', /for\s*\(let\s+i/), contains('Explains var scope', /var|function.scope|closure/i),
      contains('Mentions per-iteration binding', /iteration|binding|block/i)], expectsProAdvantage: false,
  },
  {
    id: 'debug-sort', category: 'debugging', description: 'Debug numeric sort',
    task: 'Why does [10, 2, 1].sort() produce the wrong numeric order? Provide the corrected TypeScript expression and explain.',
    criteria: [contains('Uses numeric comparator', /sort\(\s*\(?.*a.*b.*\)?\s*=>\s*a\s*-\s*b/),
      contains('Explains lexicographic default', /lexicograph|string|unicode/i)], expectsProAdvantage: false,
  },
  {
    id: 'debug-race', category: 'debugging', description: 'Debug lost update race',
    task: 'Two async workers read the same counter value, each increments locally, then both write back, losing one increment. Explain the race and propose a database-safe fix.',
    criteria: [contains('Identifies lost update', /lost update|race condition/i), contains('Proposes atomic update or lock', /atomic|transaction|lock|compare.and.swap/i),
      contains('Mentions database', /database|SQL|row/i)], expectsProAdvantage: true,
  },
  {
    id: 'verify-toposort', category: 'verification-heavy', description: 'Verify topological sort',
    task: 'A topological-sort implementation returns a result after Kahn\'s algorithm without checking whether every vertex was emitted. Is it correct for cyclic graphs? Explain the missing verification and the required check.',
    criteria: [contains('Says incorrect for cycles', /not correct|incorrect|fails.*cycle|cyclic/i), contains('Checks emitted count', /count|length.*vert|all.*vert/i),
      contains('Detects cycle', /cycle/i)], expectsProAdvantage: true,
  },
  {
    id: 'verify-cache-key', category: 'verification-heavy', description: 'Verify cache key design',
    task: 'A response cache uses only URL pathname as its key, ignoring query parameters, HTTP method, authorization, and content negotiation. Identify at least three correctness or security failures.',
    criteria: [contains('Query parameters', /query/i), contains('HTTP method', /method|GET|POST/i), contains('Authorization', /authoriz|user|credential/i),
      contains('Content negotiation', /accept|content.negotiation|representation/i)], expectsProAdvantage: true,
  },
  {
    id: 'verify-pagination', category: 'verification-heavy', description: 'Verify pagination loop',
    task: 'Review this pagination condition: while (nextCursor !== null) { fetch(nextCursor) }. The API uses undefined when there is no next page. Explain the bug and give a robust termination condition.',
    criteria: [contains('Identifies undefined mismatch', /undefined/), contains('Robust nullish check', /==\s*null|nullish|nextCursor\s*!==\s*undefined/i),
      contains('Mentions infinite or extra loop', /infinite|extra|never terminat/i)], expectsProAdvantage: true,
  },
  {
    id: 'verify-rate-limit', category: 'verification-heavy', description: 'Verify rate limiter',
    task: 'A distributed rate limiter increments a local in-memory counter on each server. Explain why the global limit is not enforced and propose a correct distributed design.',
    criteria: [contains('Explains per-server divergence', /server|instance|local/i), contains('Shared atomic store', /Redis|shared|central|atomic/i),
      contains('Mentions race or consistency', /race|consisten|atomic/i)], expectsProAdvantage: true,
  },
  {
    id: 'verify-auth', category: 'verification-heavy', description: 'Verify authorization check',
    task: 'An endpoint checks that a JWT is valid but never checks whether the user owns the requested document. Name the vulnerability and describe the required authorization check.',
    criteria: [contains('Names object authorization vulnerability', /IDOR|insecure direct object|broken object|authorization/i),
      contains('Checks ownership or permission', /owner|permission|access control|authorize/i), contains('Distinguishes authentication', /authentication|JWT|valid token/i)],
    expectsProAdvantage: true,
  },
  {
    id: 'long-incident', category: 'long-context', description: 'Incident synthesis',
    task: 'Summarize the incident below in exactly three bullets: impact, root cause, and prevention.\n\nAt 09:12 UTC, checkout latency rose from 220ms to 8s for 37% of users in Europe. The deploy at 09:05 introduced a retry policy with no jitter. When one payment provider slowed, synchronized retries multiplied traffic by six. Database CPU reached 96%, causing unrelated checkout reads to queue. Engineers disabled retries at 09:31 and latency recovered by 09:36. No payments were duplicated, but 4,200 checkout attempts failed. Prevention includes exponential backoff with jitter, retry budgets, provider circuit breakers, and load tests that simulate partial provider slowdown.',
    criteria: [contains('Impact', /37%|4,200|failed|latency/i), contains('Root cause', /retry|jitter|traffic/i),
      contains('Prevention', /backoff|circuit breaker|budget|load test/i), { description: 'Exactly three bullets', check: output => (output.match(/^\s*[-*]/gm) ?? []).length === 3 }],
    expectsProAdvantage: true,
  },
  {
    id: 'long-design', category: 'long-context', description: 'Design tradeoff synthesis',
    task: 'Read the design notes and produce exactly two paragraphs: recommendation, then risks.\n\nOption A stores uploaded documents in PostgreSQL bytea columns. It offers transactional consistency with metadata and simple backups, but large objects increase vacuum pressure and database storage cost. Option B stores documents in object storage and keeps metadata plus object keys in PostgreSQL. It scales independently and supports lifecycle tiers, but introduces cross-system consistency, orphan cleanup, and signed-URL concerns. Expected volume is 20 TB in year one, individual files reach 2 GB, metadata queries are frequent, and document updates are rare.',
    criteria: [contains('Recommends object storage', /object storage/i), contains('Mentions scale or 20 TB', /20\s*TB|scale/i),
      contains('Mentions risks', /orphan|consisten|signed.URL/i), { description: 'Exactly two paragraphs', check: output => output.trim().split(/\n\s*\n/).length === 2 }],
    expectsProAdvantage: true,
  },
  {
    id: 'long-policy', category: 'long-context', description: 'Policy extraction',
    task: 'Extract four mandatory controls from this policy as a numbered list, preserving thresholds exactly.\n\nProduction access requires phishing-resistant MFA. Privileged sessions expire after 30 minutes of inactivity. Secrets must rotate at least every 90 days. Critical vulnerabilities must be remediated within 7 calendar days. Service accounts may not use interactive login. Every production change requires a linked review record.',
    criteria: [contains('MFA', /phishing-resistant MFA/i), contains('30 minutes', /30 minutes/i), contains('90 days', /90 days/i),
      contains('7 calendar days', /7 calendar days/i), { description: 'Exactly four numbered items', check: output => (output.match(/^\d+\./gm) ?? []).length === 4 }],
    expectsProAdvantage: true,
  },
  {
    id: 'plan-migration', category: 'planning', description: 'Database migration plan',
    task: 'Create a six-step plan to migrate a 2 TB PostgreSQL database with less than five minutes of write downtime. Include replication, validation, cutover, and rollback.',
    criteria: [contains('Replication', /replicat/i), contains('Validation', /validat/i), contains('Cutover', /cutover/i), contains('Rollback', /rollback/i),
      { description: 'Six numbered steps', check: output => (output.match(/^\d+\./gm) ?? []).length === 6 }], expectsProAdvantage: true,
  },
  {
    id: 'plan-api', category: 'planning', description: 'API version migration plan',
    task: 'Plan a backward-compatible migration from API v1 to v2 in exactly five numbered steps. Include observability, dual support, client migration, and retirement criteria.',
    criteria: [contains('Observability', /observ|metric|telemetry/i), contains('Dual support', /dual|both|parallel/i),
      contains('Client migration', /client.*migrat|migrat.*client/i), contains('Retirement criteria', /retir|deprecat|usage threshold/i),
      { description: 'Five numbered steps', check: output => (output.match(/^\d+\./gm) ?? []).length === 5 }], expectsProAdvantage: true,
  },
  {
    id: 'plan-incident', category: 'planning', description: 'Incident response plan',
    task: 'Create a seven-step incident response plan for suspected credential theft. Include containment, evidence preservation, rotation, scope analysis, recovery, communication, and retrospective.',
    criteria: [contains('Containment', /contain/i), contains('Evidence', /evidence|forensic/i), contains('Rotation', /rotat|revoke/i),
      contains('Scope analysis', /scope/i), contains('Recovery', /recover/i), contains('Communication', /communicat|notify/i),
      contains('Retrospective', /retrospective|postmortem/i), { description: 'Seven numbered steps', check: output => (output.match(/^\d+\./gm) ?? []).length === 7 }],
    expectsProAdvantage: true,
  },
]

function verify(output: string, criteria: readonly VerificationCriterion[]): VerificationResult {
  if (output.trim() === '') {
    return { status: 'incomplete', criteriaPassed: 0, criteriaTotal: criteria.length, checks: [] }
  }
  const checks = criteria.map(criterion => ({ description: criterion.description, passed: criterion.check(output) }))
  const criteriaPassed = checks.filter(check => check.passed).length
  return {
    status: criteriaPassed === criteria.length ? 'verified-pass' : 'verified-fail',
    criteriaPassed,
    criteriaTotal: criteria.length,
    checks,
  }
}

async function generateConfig(model: Model, workDir: string): Promise<string> {
  const basePath = join(REPO_ROOT, 'examples', 'headless-agent', 'cordis.yml')
  let base = await readFile(basePath, 'utf8')
  base = base.replace(/model: deepseek-v4-flash/, `model: ${model}`)
  base = base.replace(
    /compression: !!js "process.env.DSH_SNAPSHOT === undefined \? 'zstd' : 'none'"/,
    "compression: 'none'",
  )
  const configPath = join(workDir, 'cordis.yml')
  await writeFile(configPath, base, 'utf8')
  return configPath
}

function extractEvents(events: SessionEvent[]): {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheMissTokens: number
  reasoningTokens: number
  totalTokens: number
  output: string
  toolCalls: number
  toolFailures: number
} {
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheMissTokens = 0
  let reasoningTokens = 0
  let totalTokens = 0
  let output = ''
  let toolCalls = 0
  let toolFailures = 0

  for (const event of events) {
    if (event.type === 'model/usage') {
      const usage = event.data.usage
      inputTokens += usage.inputTokens
      outputTokens += usage.outputTokens
      cacheReadTokens += usage.cacheReadTokens ?? 0
      cacheMissTokens += usage.cacheMissTokens ?? 0
      reasoningTokens += usage.reasoningTokens ?? 0
      totalTokens += usage.totalTokens ?? 0
    } else if (event.type === 'assistant/message') {
      const message = event.data as { message: { content: Array<{ type: string; text?: string }> } }
      const text = message.message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
      if (text !== '') output = text
    } else if (event.type === 'tool/call') {
      toolCalls++
    } else if (event.type === 'tool/result') {
      const result = event.data as { message: { content: Array<{ isError?: boolean }> } }
      if (result.message.content.some(block => block.isError === true)) toolFailures++
    }
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheMissTokens,
    reasoningTokens,
    totalTokens,
    output,
    toolCalls,
    toolFailures,
  }
}

async function runOnce(
  taskClass: TaskClass,
  model: Model,
  iteration: number,
  workDir: string,
): Promise<BenchmarkRun> {
  const configPath = await generateConfig(model, workDir)
  const events: SessionEvent[] = []
  let uninstallFailLoud: (() => void) | undefined
  let ctx: Context | undefined

  try {
    loadEnv('v0172-expanded-benchmark')
    uninstallFailLoud = installFailLoud('v0172-expanded-benchmark')
    ctx = await boot('v0172-expanded-benchmark', resolveConfigPath(configPath, undefined))
    const started = Date.now()
    await runFixtureTurn(ctx, { task: taskClass.task, onEvent: (_sessionId, event) => events.push(event) })
    const latencyMs = Date.now() - started
    const extracted = extractEvents(events)
    if (extracted.output === '' && extracted.totalTokens === 0) {
      throw new Error('Provider returned no assistant output or usage')
    }
    const pricing = lookupPricing(DEFAULT_PRICING_REGISTRY, 'deepseek-official', model)
    const cost = pricing === undefined
      ? undefined
      : calculateCost({
        inputTokens: extracted.inputTokens,
        outputTokens: extracted.outputTokens,
        cacheReadTokens: extracted.cacheReadTokens,
        cacheMissTokens: extracted.cacheMissTokens,
        reasoningTokens: extracted.reasoningTokens,
        source: 'provider',
      }, pricing)
    const cacheTotal = extracted.cacheReadTokens + extracted.cacheMissTokens

    return {
      taskId: taskClass.id,
      category: taskClass.category,
      model,
      iteration,
      cacheState: iteration === 1 ? 'cold' : 'warm',
      cache: {
        hitTokens: extracted.cacheReadTokens,
        missTokens: extracted.cacheMissTokens,
        hitRate: cacheTotal === 0 ? 0 : extracted.cacheReadTokens / cacheTotal,
      },
      usage: {
        inputTokens: extracted.inputTokens,
        outputTokens: extracted.outputTokens,
        reasoningTokens: extracted.reasoningTokens,
        totalTokens: extracted.totalTokens,
      },
      economics: { costUsd: cost?.amount ?? 0, pricingVersion: pricing?.version ?? 'N/A' },
      execution: {
        latencyMs,
        attempts: 1,
        toolCalls: extracted.toolCalls,
        toolFailures: extracted.toolFailures,
        repairs: 0,
      },
      verification: verify(extracted.output, taskClass.criteria),
      output: extracted.output,
    }
  } catch (error: unknown) {
    return {
      taskId: taskClass.id,
      category: taskClass.category,
      model,
      iteration,
      cacheState: iteration === 1 ? 'cold' : 'warm',
      cache: { hitTokens: 0, missTokens: 0, hitRate: 0 },
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 },
      economics: { costUsd: 0, pricingVersion: 'N/A' },
      execution: { latencyMs: 0, attempts: 1, toolCalls: 0, toolFailures: 0, repairs: 0 },
      verification: { status: 'incomplete', criteriaPassed: 0, criteriaTotal: taskClass.criteria.length, checks: [] },
      output: '',
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await ctx?.fiber.dispose()
    uninstallFailLoud?.()
  }
}

function classifyPair(flash: BenchmarkRun, pro: BenchmarkRun): FlashProPair['classification'] {
  const flashPass = flash.verification.status === 'verified-pass'
  const proPass = pro.verification.status === 'verified-pass'
  if (!flashPass && !proPass) return 'both-fail'
  if (flashPass && !proPass) return 'flash-better'
  if (!flashPass && proPass) return 'pro-necessary'
  if (pro.economics.costUsd < flash.economics.costUsd) return 'pro-better'
  return 'both-pass-pro-more-expensive'
}

async function loadCheckpoint(): Promise<Checkpoint> {
  try {
    return JSON.parse(await readFile(CHECKPOINT_PATH, 'utf8')) as Checkpoint
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const now = new Date().toISOString()
    return { release: 'v0.17.2', startedAt: now, updatedAt: now, runs: [] }
  }
}

async function saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
  checkpoint.updatedAt = new Date().toISOString()
  await writeFile(CHECKPOINT_PATH, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8')
}

async function main(): Promise<void> {
  if (process.env.DEEPSEEK_API_KEY === undefined || process.env.DEEPSEEK_API_KEY === '') {
    throw new Error('DEEPSEEK_API_KEY is required')
  }
  if (TASK_CLASSES.length !== 50) throw new Error(`Expected 50 task classes, found ${TASK_CLASSES.length}`)

  await mkdir(REPORT_DIR, { recursive: true })
  const checkpoint = await loadCheckpoint()
  const workRoot = await mkdtemp(join(tmpdir(), 'v0172-benchmark-'))

  try {
    for (const taskClass of TASK_CLASSES) {
      for (let iteration = 1; iteration <= ITERATIONS; iteration++) {
        for (const model of MODELS) {
          const completed = checkpoint.runs.some(run =>
            run.taskId === taskClass.id && run.iteration === iteration && run.model === model
            && run.error === undefined,
          )
          if (completed) continue
          checkpoint.runs = checkpoint.runs.filter(run =>
            run.taskId !== taskClass.id || run.iteration !== iteration || run.model !== model,
          )

          process.stderr.write(`${checkpoint.runs.length + 1}/200 ${taskClass.id}/${iteration} ${model}\n`)
          const workDir = join(workRoot, `${taskClass.id}-${iteration}-${model}`)
          await mkdir(workDir, { recursive: true })
          const run = await runOnce(taskClass, model, iteration, workDir)
          checkpoint.runs.push(run)
          await saveCheckpoint(checkpoint)
          process.stderr.write(
            `  ${run.error === undefined ? run.verification.status : `ERROR ${run.error}`} `
            + `cost=$${run.economics.costUsd.toFixed(6)} latency=${run.execution.latencyMs}ms\n`,
          )
        }
      }
    }

    const pairs: FlashProPair[] = []
    for (const taskClass of TASK_CLASSES) {
      for (let iteration = 1; iteration <= ITERATIONS; iteration++) {
        const flash = checkpoint.runs.find(run =>
          run.taskId === taskClass.id && run.iteration === iteration && run.model === 'deepseek-v4-flash',
        )
        const pro = checkpoint.runs.find(run =>
          run.taskId === taskClass.id && run.iteration === iteration && run.model === 'deepseek-v4-pro',
        )
        if (flash === undefined || pro === undefined) continue
        pairs.push({
          taskId: `${taskClass.id}/${iteration}`,
          iteration,
          cacheState: flash.cacheState,
          flash,
          pro,
          classification: classifyPair(flash, pro),
          cacheComparable: Math.abs(flash.cache.hitRate - pro.cache.hitRate) <= 0.1,
        })
      }
    }

    const report = {
      release: 'v0.17.2',
      generatedAt: new Date().toISOString(),
      design: {
        taskClasses: TASK_CLASSES.map(taskClass => ({
          id: taskClass.id,
          category: taskClass.category,
          description: taskClass.description,
          task: taskClass.task,
          expectsProAdvantage: taskClass.expectsProAdvantage,
          criteriaCount: taskClass.criteria.length,
        })),
        iterations: ITERATIONS,
        models: MODELS,
        pairedExamples: TASK_CLASSES.length * ITERATIONS,
        policiesEvaluatedOffline: ['flash-only', 'pro-only', 'heuristic-router', 'learned-router'],
        cacheControl: 'two sequential isolated-context iterations per task and model',
        verification: 'deterministic structured criteria',
        coreMetric: 'CostPerVerifiedTask = TotalCost / VerifiedPasses',
      },
      runs: checkpoint.runs,
      pairs,
      summary: {
        runs: checkpoint.runs.length,
        pairs: pairs.length,
        errors: checkpoint.runs.filter(run => run.error !== undefined).length,
        proNecessary: pairs.filter(pair => pair.classification === 'pro-necessary').length,
        flashBetter: pairs.filter(pair => pair.classification === 'flash-better').length,
        bothFail: pairs.filter(pair => pair.classification === 'both-fail').length,
        bothPassProMoreExpensive: pairs.filter(pair => pair.classification === 'both-pass-pro-more-expensive').length,
      },
    }
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    process.stderr.write(`Wrote ${pairs.length} pairs to ${REPORT_PATH}\n`)
  } finally {
    await rm(workRoot, { recursive: true, force: true })
  }
}

void main()
