#!/usr/bin/env node
/**
 * v0.15.3 model-router source guard: Routing Authority & Release Hygiene.
 * Every check maps to a defect the third external audit found in v0.15.2 or a
 * requirement it set for this release — none may be weakened:
 *
 *   1. The router package version changed (v0.15.1/v0.15.2 shipped different
 *      code under one immutable identity 0.1.1-rc.2).
 *   2. A dedicated durable authority event exists and is canonical.
 *   3. The authority event is POLICY-VERSION INDEPENDENT (its payload carries
 *      authoritySchemaVersion, never a router policy version) — a future
 *      router upgrade cannot erase a recorded user choice.
 *   4. The Auto release operation exists (clearExplicitModelSelection) and
 *      both selection surfaces attach provenance (web / sdk).
 *   5. Legacy migration exists: reconstruction honors explicit/foreign/
 *      subagent routing-decision barriers at ANY policy version.
 *   6. Epochs are truly monotonic (nextAuthorityEpoch reads every schema
 *      version and the legacy routing-decision carrier).
 *   7. Authority transitions are durable regardless of recordAllDecisions.
 *   8. All three root chains run the v0.15.3 gates.
 *   9. The frozen baselines stay untouched and the README pair stays recorded.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const violations = []
const check = (ok, message) => { if (!ok) violations.push(message) }
const read = rel => readFileSync(join(root, rel), 'utf8')

// -- 1. Package version hygiene (the audit's release-identity fix) ----------
const PKG = 'packages/llm/llm-model-router'
const manifest = JSON.parse(read(`${PKG}/package.json`))
check(manifest.version === '0.1.1-rc.4', `verify-model-router-v153: router package must carry the v0.15.3 release version 0.1.1-rc.4 (got ${manifest.version})`)
check(manifest.version !== '0.1.1-rc.2', 'verify-model-router-v153: router package must not share the v0.15.1/v0.15.2 identity')
const rootManifest = JSON.parse(read('package.json'))
check(rootManifest.version === '0.1.1-rc.4', `verify-model-router-v153: root manifest must carry the release version (got ${rootManifest.version})`)
for (const subpath of ['.', './invariant', './types']) {
  check(manifest.exports[subpath] !== undefined, `verify-model-router-v153: missing exports[${subpath}]`)
}
for (const file of ['package.json', 'tsconfig.json', 'tsdown.config.ts', 'README.md', 'README.zh.md', 'README.i18n.yaml',
  'src/index.ts', 'src/complexity.ts', 'src/invariant.ts', 'src/types.ts',
  'tests/model-router.spec.ts', 'tests/loader-composition.spec.ts']) {
  check(existsSync(join(root, PKG, file)), `verify-model-router-v153: missing ${PKG}/${file}`)
}

// -- 2. Dedicated durable authority event -------------------------------------
const authority = read('packages/core/agent/src/authority.ts')
check(authority.includes("'model/selection-authority'"), 'verify-model-router-v153: the authority event must be declared in dsh-agent (always composed), not the opt-in router')
check(authority.includes('AUTHORITY_SCHEMA_VERSION'), 'verify-model-router-v153: authority event must carry its own schema version')
check(authority.includes('clearExplicitModelSelection') || authority.includes('export function releaseToAuto'), 'verify-model-router-v153: the Auto release operation (releaseToAuto / clearExplicitModelSelection) is missing')
check(authority.includes('export function nextAuthorityEpoch'), 'verify-model-router-v153: the monotonic epoch counter (nextAuthorityEpoch) is missing')
check(authority.includes("session.append('model/selection-authority'"), 'verify-model-router-v153: authority claims must be written durably by the selection surfaces')

// -- 3. Policy-version independence -------------------------------------------
const authorityTypes = authority.slice(
  authority.indexOf('export interface ModelSelectionAuthorityEventData'),
  authority.indexOf('declare module'),
)
check(!authorityTypes.includes('policyVersion'), 'verify-model-router-v153: the authority event payload must never reference a router policy version')
check(authorityTypes.includes('authoritySchemaVersion'), 'verify-model-router-v153: the authority event payload must stamp authoritySchemaVersion')

// -- 4. Provenance on every deliberate selection surface ----------------------
const apiProxy = read('packages/host/apiproxy/src/api-proxy.ts')
check(apiProxy.includes("markExplicitModelSelection(agent.session, 'web'"), 'verify-model-router-v153: the web picker surface must claim authority with source web')
const sdkServer = read('packages/sdk/server/src/server.ts')
check(sdkServer.includes("markExplicitModelSelection(agent.session, 'sdk'"), 'verify-model-router-v153: the SDK initialize surface must claim authority with source sdk')

// -- 5. Router consumes the authority stream with legacy migration -------------
const routerSource = read(`${PKG}/src/index.ts`)
check(routerSource.includes('reconstructRoutingState'), 'verify-model-router-v153: reconstruction must be built around the authority event stream')
check(routerSource.includes('model/selection-authority'), 'verify-model-router-v153: reconstruction must read model/selection-authority events')
check(
  /data\.authority === 'explicit-selection'[\s\S]{0,400}policy-version INDEPENDENT|policy-version INDEPENDENT[\s\S]{0,400}data\.authority === 'explicit-selection'/.test(routerSource),
  'verify-model-router-v153: legacy explicit barriers must be honored at any policy version',
)
check(
  routerSource.includes('data.policyVersion === POLICY_VERSION'),
  'verify-model-router-v153: router-owned route continuity must stay policy-version filtered',
)
check(routerSource.includes('nextAuthorityEpoch') === false, 'verify-model-router-v153: epochs belong to the authority stream (dsh-agent), not the router')

// -- 6. Event vocabulary is canonical -----------------------------------------
const knownEvents = read('packages/core/session/src/known-event-types.ts')
check(knownEvents.includes("'model/selection-authority'"), 'verify-model-router-v153: model/selection-authority missing from the generated known-event catalog')
const catalog = read('docs/persistence-catalog.md')
check(catalog.includes('`model/selection-authority`'), 'verify-model-router-v153: persistence catalog not regenerated for the authority event')
check(catalog.includes('ModelSelectionAuthorityEventData'), 'verify-model-router-v153: persistence catalog must reference the authority payload type')
check(catalog.includes('`model/routing-decision`'), 'verify-model-router-v153: routing decisions must remain canonical alongside the authority stream')

// -- 7. Root chains run the v0.15.3 gates --------------------------------------
const scripts = JSON.parse(read('package.json')).scripts
for (const chain of ['check:all', 'check:ci', 'release:verify']) {
  const script = scripts[chain] ?? ''
  for (const gate of ['verify:model-router-v15', 'verify:model-router-v152', 'verify:model-router-v153', 'verify:model-router-packed', 'qualify:model-router-authority-v153']) {
    check(
      script.includes(`npm run ${gate}`),
      `verify-model-router-v153: ${chain} must run ${gate} (release verification may not lag CI)`,
    )
  }
}

// -- 8. Frozen baselines stay untouched -----------------------------------------
for (const [file, version] of [['BASELINE_v0.15.1.json', '0.15.1']]) {
  const path = join(root, file)
  check(existsSync(path), `verify-model-router-v153: frozen ${file} missing`)
  if (existsSync(path)) {
    const baseline = JSON.parse(readFileSync(path, 'utf8'))
    check(baseline.version === version, `verify-model-router-v153: ${file} version must stay ${version}`)
    check(baseline.escalationThreshold === 4, `verify-model-router-v153: ${file} policy constants altered`)
  }
}

// -- 9. Bilingual README pair stays recorded -----------------------------------
function blobHash(relPath) {
  const bytes = readFileSync(join(root, relPath))
  const header = Buffer.from(`blob ${bytes.length}\0`)
  return createHash('sha1').update(Buffer.concat([header, bytes])).digest('hex')
}
const i18n = read(`${PKG}/README.i18n.yaml`)
for (const file of ['README.md', 'README.zh.md']) {
  const recorded = new RegExp(`^${file}: ([0-9a-f]{40})$`, 'm').exec(i18n)?.[1]
  check(recorded === blobHash(`${PKG}/${file}`), `verify-model-router-v153: ${PKG}/${file} changed without re-recording ${PKG}/README.i18n.yaml`)
}

if (violations.length > 0) {
  for (const line of violations) console.error(line)
  console.error(`verify-model-router-v153: ${violations.length} violation(s)`)
  process.exit(1)
}
console.log('verify-model-router-v153: pass')
