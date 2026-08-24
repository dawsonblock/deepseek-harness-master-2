/**
 * Enforce that semantic model-selection state events are never appended with
 * ignorable true. The session contract (dsh-session/types.ts) defines
 * ignorable true as "purely informational and cannot affect reconstruction";
 * an older reader may skip such an event. A semantic state event marked
 * ignorable lets an older runtime silently drop a state transition that
 * changes execution semantics — the v0.15.4 model/selection-authority defect,
 * where a manual Pro selection could be silently discarded by an older reader.
 *
 * This gate protects an explicit allow-set of semantic state event types:
 * events whose latest record is the authoritative source of WHO owns model
 * selection and WHAT mode (manual/auto) is in force. Router optimization
 * events (model/routing-decision) are NOT in this set: losing one only
 * restarts the router fresh on the next turn, it does not override user
 * ownership. Ownership protection comes exclusively from
 * model/selection-authority.
 *
 * The gate scans every session.append call site under packages and rejects
 * any whose type appears in the semantic state set below. A future developer
 * who adds a new semantic state event MUST add it to this set; the gate name
 * is intentionally specific (model-state-events) rather than generic
 * (reconstruction-events) to keep the allow-set honest. The longer-term
 * solution is event metadata (semantics: 'state' | 'modelVisible' |
 * 'telemetry' | 'observation') that makes the rule enforceable without a
 * hardcoded set.
 */

import { readFileSync } from 'node:fs'
import { globSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

/**
 * Semantic model-selection state event types: events whose latest record is
 * the authoritative source of model-selection ownership and mode. An older
 * reader skipping one would reconstruct a wrong session (wrong owner, wrong
 * mode, or a stale manual selection resurrected). Add a type here only when
 * it carries semantic ownership state, NOT route optimization continuity.
 */
const MODEL_STATE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'model/selection-authority',
])

/** Match a session.append call whose opts include ignorable true, capturing the event type. */
const APPEND_IGNORABLE = /session\.append\(\s*['"]([^'"]+)['"]\s*,[\s\S]*?\{\s*ignorable:\s*true\s*\}/g

const files = globSync('packages/**/src/**/*.ts', { cwd: root })
  .filter(p => !p.includes('/lib/') && !p.endsWith('.d.ts'))

interface Violation {
  file: string
  line: number
  type: string
}

const violations: Violation[] = []

for (const file of files) {
  const abs = resolve(root, file)
  const text = readFileSync(abs, 'utf8')
  APPEND_IGNORABLE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = APPEND_IGNORABLE.exec(text)) !== null) {
    const type = match[1]!
    if (!MODEL_STATE_EVENT_TYPES.has(type)) continue
    const line = text.slice(0, match.index).split('\n').length
    violations.push({ file: relative(root, abs), line, type })
  }
}

if (violations.length === 0) {
  console.log(
    `verify-model-state-events-not-ignorable: ${files.length} source file(s) checked, `
    + `no model-selection state event appended as ignorable.`,
  )
  process.exit(0)
}

console.error(
  'verify-model-state-events-not-ignorable: model-selection state events must NOT be ignorable '
  + '(an older reader may skip them and reconstruct a wrong session):',
)
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  session.append('${v.type}', ..., { ignorable: true })`)
}
process.exit(1)
