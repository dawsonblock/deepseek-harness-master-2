#!/usr/bin/env node
/**
 * v0.15 model-router source guard: structural invariants of the tiered-routing
 * feature that must hold in every release tree. Companion to the router's own
 * test suites (unit + Loader composition), covering what tests cannot see from
 * inside the package: cross-package wiring, catalog hygiene, and release-shape
 * facts. Exits non-zero with one line per violation.
 */

import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
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
  check(existsSync(join(root, PKG, file)), `verify-model-router-v15: missing ${PKG}/${file}`)
}
if (violations.length > 0) {
  for (const line of violations) console.error(line)
  process.exit(1)
}

const manifest = JSON.parse(read(`${PKG}/package.json`))
check(manifest.name === '@deepseek-ai/dsh-llm-model-router', 'verify-model-router-v15: package name changed')
check(manifest.version === '0.1.1-rc.4', `verify-model-router-v15: version must match root (got ${manifest.version})`)
for (const subpath of ['.', './invariant', './types']) {
  check(manifest.exports[subpath] !== undefined, `verify-model-router-v15: missing exports[${subpath}]`)
}

// -- 2. Router policy invariants ----------------------------------------------
const routerSource = read(`${PKG}/src/index.ts`)
const complexitySource = read(`${PKG}/src/complexity.ts`)
check(routerSource.includes("'agent/request'"), 'verify-model-router-v15: router must ride the agent/request waterfall')
check(!routerSource.includes('llm.stream('), 'verify-model-router-v15: router must never wrap ctx.llm.stream()')
check(routerSource.includes('explicitModelSelectionMark'), 'verify-model-router-v15: router must consume explicit-selection provenance')
check(routerSource.includes("callConfigEquals(memory.decided, proposed)"), 'verify-model-router-v15: heavy ownership must require field-wise continuity, not model equality')
check(routerSource.includes("'mid-turn-escalated'"), 'verify-model-router-v15: one-way mid-turn escalation missing')
check(routerSource.includes("turnDiscoveredFacts"), 'verify-model-router-v15: discovered-complexity measurement missing')
check(routerSource.includes("'coordinator'"), 'verify-model-router-v15: coordinator-authored requests must be scorable')
check(complexitySource.includes('export function noFamilyAloneReaches'), 'verify-model-router-v15: calibration contract check missing')

// -- 3. Core provenance wiring -------------------------------------------------
const modelSelection = read('packages/core/agent/src/authority.ts')
check(modelSelection.includes('export function markExplicitModelSelection'), 'verify-model-router-v15: dsh-agent must export the explicit-selection mark')
const apiProxy = read('packages/host/apiproxy/src/api-proxy.ts')
check(apiProxy.includes('markExplicitModelSelection'), 'verify-model-router-v15: apiproxy selection setter must earn the explicit mark')

// -- 4. Durable routing events are canonical ----------------------------------
const knownEvents = read('packages/core/session/src/known-event-types.ts')
check(knownEvents.includes("'model/routing-decision'"), 'verify-model-router-v15: model/routing-decision missing from the generated known-event catalog')
const catalog = read('docs/persistence-catalog.md')
check(catalog.includes('`model/routing-decision`'), 'verify-model-router-v15: persistence catalog not regenerated for the routing event')

// -- 5. Cloud catalog hygiene: only documented API ids are defaults ------------
const deepseekSource = read('packages/llm/llm-deepseek/src/index.ts')
const defaultsBlock = deepseekSource.slice(
  deepseekSource.indexOf('const DEFAULT_MODELS'),
  deepseekSource.indexOf('const MODEL_MODALITIES'),
)
for (const unverified of ['deepseek-v4-flash-0731', 'deepseek-v4-pro-0813']) {
  check(!defaultsBlock.includes(unverified), `verify-model-router-v15: unverified cloud alias ${unverified} must not be a default catalog entry`)
}
check(defaultsBlock.includes("'deepseek-v4-flash'") && defaultsBlock.includes("'deepseek-v4-pro'"), 'verify-model-router-v15: documented V4 API ids missing from defaults')

// -- 6. SSE liveness: buffering headers AND heartbeat ---------------------------
const handler = read('packages/host/apiproxy/src/fetch/handler.ts')
check(handler.includes("'x-accel-buffering': 'no'"), 'verify-model-router-v15: SSE proxy-buffering header missing')
check(handler.includes('SSE_HEARTBEAT_INTERVAL_MS') && handler.includes(': hb'), 'verify-model-router-v15: SSE heartbeat missing from the /api event channels')
const hmr = read('packages/client/hmr/src/index.ts')
check(hmr.includes("'x-accel-buffering': 'no'") && hmr.includes(': hb'), 'verify-model-router-v15: HMR channel missing proxy headers or heartbeat')

// -- 7. Bilingual README pair stays recorded -----------------------------------
function blobHash(relPath) {
  // Git blob hash: "<type> <byte-length>\0<contents>" — the length is in BYTES.
  const bytes = readFileSync(join(root, relPath))
  const header = Buffer.from(`blob ${bytes.length}\0`)
  return createHash('sha1').update(Buffer.concat([header, bytes])).digest('hex')
}
const i18n = read(`${PKG}/README.i18n.yaml`)
for (const [file, key] of [['README.md', 'README.md'], ['README.zh.md', 'README.zh.md']]) {
  const recorded = new RegExp(`^${key}: ([0-9a-f]{40})$`, 'm').exec(i18n)?.[1]
  check(recorded === blobHash(`${PKG}/${file}`), `verify-model-router-v15: ${PKG}/${file} changed without re-recording ${PKG}/README.i18n.yaml`)
}

if (violations.length > 0) {
  for (const line of violations) console.error(line)
  console.error(`verify-model-router-v15: ${violations.length} violation(s)`)
  process.exit(1)
}
console.log('verify-model-router-v15: pass')
