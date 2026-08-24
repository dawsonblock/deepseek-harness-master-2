#!/usr/bin/env node
/**
 * v0.15.2 model-router source guard: structural invariants of the routing
 * correctness & authority release. Extends the v0.15 guard with the exact
 * regressions the second external audit found in v0.15.1 — every check here
 * corresponds to a defect that shipped, so none may be weakened:
 *
 *   1. resolveConfig() must CALL noFamilyAloneReaches (v0.15.1 exported the
 *      contract but never enforced it — thresholds 1–3 were accepted).
 *   2. Marker-vocabulary independence must be validated at config load.
 *   3. reconstructMemory() must be latest-authority-wins: a newer
 *      explicit-selection record terminates older router ownership.
 *   4. Routing events must carry authorityEpoch and discovered facts.
 *   5. The SDK server's initialize-supplied model must earn the
 *      explicit-selection mark.
 *   6. recordAllDecisions must reach every decision branch.
 *   7. release:verify must run the router gates (the audit found it lagged
 *      check:all/check:ci).
 *   8. The frozen v0.15.1 baseline must exist and stay untouched.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const violations = []
const check = (ok, message) => { if (!ok) violations.push(message) }
const read = rel => readFileSync(join(root, rel), 'utf8')

// -- 1. Package shape ---------------------------------------------------------
const PKG = 'packages/llm/llm-model-router'
for (const file of [
  'package.json', 'tsconfig.json', 'tsdown.config.ts',
  'README.md', 'README.zh.md', 'README.i18n.yaml',
  'src/index.ts', 'src/complexity.ts', 'src/invariant.ts', 'src/types.ts',
  'tests/model-router.spec.ts', 'tests/loader-composition.spec.ts',
]) {
  check(existsSync(join(root, PKG, file)), `verify-model-router-v152: missing ${PKG}/${file}`)
}
if (violations.length > 0) {
  for (const line of violations) console.error(line)
  process.exit(1)
}
const manifest = JSON.parse(read(`${PKG}/package.json`))
check(manifest.name === '@deepseek-ai/dsh-llm-model-router', 'verify-model-router-v152: package name changed')
check(manifest.version === '0.1.1-rc.4', `verify-model-router-v152: version must match root (got ${manifest.version})`)
for (const subpath of ['.', './invariant', './types']) {
  check(manifest.exports[subpath] !== undefined, `verify-model-router-v152: missing exports[${subpath}]`)
}

// -- 2. Scorer contract enforced at load (the v0.15.1 gap) --------------------
const routerSource = read(`${PKG}/src/index.ts`)
const complexitySource = read(`${PKG}/src/complexity.ts`)
check(
  /if\s*\(\s*!noFamilyAloneReaches\(escalationThreshold\)\s*\)/.test(routerSource),
  'verify-model-router-v152: resolveConfig must reject thresholds that let one family escalate alone (call noFamilyAloneReaches)',
)
check(
  complexitySource.includes('export function assertDistinctMarkers'),
  'verify-model-router-v152: marker-vocabulary independence validation missing',
)
check(
  routerSource.includes('assertDistinctMarkers(markers)'),
  'verify-model-router-v152: resolveConfig must validate marker independence at load',
)
check(
  complexitySource.includes('normalize(') || complexitySource.includes('normalize'),
  'verify-model-router-v152: marker normalization missing',
)

// -- 3. Latest-authority-wins reconstruction ----------------------------------
check(
  read(`${PKG}/src/index.ts`).includes("case 'explicit-selection':") || read(`${PKG}/src/index.ts`).includes("authority === 'explicit-selection'"),
  'verify-model-router-v152: reconstruction must terminate router ownership on a newer explicit-selection record (latest-authority-wins)',
)
check(
  !/if\s*\(\s*event\.data\.authority\s*!==\s*'router'\s*\)\s*continue/.test(routerSource),
  'verify-model-router-v152: reconstructMemory must not skip non-router records while scanning backward',
)

// -- 4. Durable event vocabulary ----------------------------------------------
const typesSource = read(`${PKG}/src/types.ts`)
check(typesSource.includes('authorityEpoch') && read('packages/core/agent/src/authority.ts').includes('authorityEpoch: number'), 'verify-model-router-v152: authority epochs must be carried durably (v0.15.3: on the authority event; legacy field on routing decisions)')
check(typesSource.includes('discovered?: DiscoveredComplexity'), 'verify-model-router-v152: routing events must carry discovered-escalation facts')
check(typesSource.includes("export type DiscoveredTrigger"), 'verify-model-router-v152: discovered trigger vocabulary missing')
check(
  routerSource.includes("reason: 'mid-turn-escalated'") && routerSource.includes('trigger: discoveredTrigger('),
  'verify-model-router-v152: mid-turn escalation must record its trigger',
)

// -- 5. SDK provenance wiring --------------------------------------------------
const sdkServer = read('packages/sdk/server/src/server.ts')
check(
  sdkServer.includes('markExplicitModelSelection(agent.session'),
  'verify-model-router-v152: SDK server must mark the initialize-supplied model as an explicit selection',
)
const apiProxy = read('packages/host/apiproxy/src/api-proxy.ts')
check(apiProxy.includes('markExplicitModelSelection(agent.session'), 'verify-model-router-v152: apiproxy selection setter must earn the explicit mark')
const modelSelection = read('packages/core/agent/src/authority.ts')
check(modelSelection.includes('export function markExplicitModelSelection'), 'verify-model-router-v152: dsh-agent must export the explicit-selection mark')

// -- 6. Truthful recordAllDecisions -------------------------------------------
check(
  routerSource.includes("}, 'subagent-owner'"),
  'verify-model-router-v152: subagent passthrough must consult the record helper (recordAllDecisions truthfulness)',
)
check(
  routerSource.includes("}, 'foreign-route'"),
  'verify-model-router-v152: foreign-route passthrough must consult the record helper (recordAllDecisions truthfulness)',
)
check(
  /if\s*\(\s*config\.recordAllDecisions\s*\)\s*\{[\s\S]*?turn-route-retained/.test(routerSource),
  'verify-model-router-v152: retention must record in telemetry mode (recordAllDecisions truthfulness)',
)

// -- 7. Release chains run the router gates ------------------------------------
const rootManifest = read('package.json')
for (const chain of ['check:all', 'check:ci', 'release:verify']) {
  const script = JSON.parse(rootManifest).scripts[chain] ?? ''
  for (const gate of ['verify:model-router-v15', 'verify:model-router-packed']) {
    check(
      script.includes(`npm run ${gate}`),
      `verify-model-router-v152: ${chain} must run ${gate} (release verification may not lag CI)`,
    )
  }
  check(
    script.includes('npm run verify:model-router-v152'),
    `verify-model-router-v152: ${chain} must run the v0.15.2 guard`,
  )
}

// -- 8. Frozen baseline ---------------------------------------------------------
const baselinePath = join(root, 'BASELINE_v0.15.1.json')
check(existsSync(baselinePath), 'verify-model-router-v152: frozen BASELINE_v0.15.1.json missing')
if (existsSync(baselinePath)) {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  check(baseline.version === '0.15.1', 'verify-model-router-v152: baseline version must stay 0.15.1')
  check(
    baseline.escalationThreshold === 4 && baseline.midTurnToolCallThreshold === 8 && baseline.midTurnToolResultCharsThreshold === 24000,
    'verify-model-router-v152: frozen baseline policy constants altered',
  )
}

// -- 9. Bilingual README pair stays recorded -----------------------------------
function blobHash(relPath) {
  // Git blob hash: "<type> <byte-length>\0<contents>" — the length is in BYTES.
  const bytes = readFileSync(join(root, relPath))
  const header = Buffer.from(`blob ${bytes.length}\0`)
  return createHash('sha1').update(Buffer.concat([header, bytes])).digest('hex')
}
const i18n = read(`${PKG}/README.i18n.yaml`)
for (const file of ['README.md', 'README.zh.md']) {
  const recorded = new RegExp(`^${file}: ([0-9a-f]{40})$`, 'm').exec(i18n)?.[1]
  check(recorded === blobHash(`${PKG}/${file}`), `verify-model-router-v152: ${PKG}/${file} changed without re-recording ${PKG}/README.i18n.yaml`)
}

// -- 10. Canonical durable vocabulary ------------------------------------------
const knownEvents = read('packages/core/session/src/known-event-types.ts')
check(knownEvents.includes("'model/routing-decision'"), 'verify-model-router-v152: model/routing-decision missing from the generated known-event catalog')
const catalog = read('docs/persistence-catalog.md')
check(catalog.includes('`model/routing-decision`'), 'verify-model-router-v152: persistence catalog not regenerated for the routing event')
check(catalog.includes('ModelRoutingDecisionEventData'), 'verify-model-router-v152: persistence catalog must reference the routing payload type')

if (violations.length > 0) {
  for (const line of violations) console.error(line)
  console.error(`verify-model-router-v152: ${violations.length} violation(s)`)
  process.exit(1)
}
console.log('verify-model-router-v152: pass')
