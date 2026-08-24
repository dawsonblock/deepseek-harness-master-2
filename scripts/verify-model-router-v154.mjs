#!/usr/bin/env node
/**
 * v0.15.4 model-router source guard: control-plane correctness. Every check
 * maps to a defect the fourth external audit found in v0.15.3 or a
 * requirement it set — none may be weakened:
 *
 *   1. ONE durable ModelSelectionState (mode auto/manual) carries the
 *      COMPLETE selection — not fragmented authority/picked/header state.
 *   2. Every semantic selection change records (same-authority Pro→Flash is
 *      a transition; only a complete no-op is suppressed).
 *   3. Auto works after a real process restart — the release path derives
 *      from DURABLE state, never from WeakMap existence.
 *   4. The production API exposes Auto (selectModel mode:'auto') and resets
 *      the picked model so a stale route cannot impersonate a manual choice.
 *   5. Manual selections are crash-durable: the selection resolver consults
 *      the durable manual state before the logged header.
 *   6. Reconstruction is exhaustive (default state handled) and conservative
 *      (future authority schema fails closed).
 *   7. decideRoute is pure: the decision identity is deterministic execution
 *      coordinates, not randomUUID.
 *   8. Decisions stamp scorerVersion and a canonical config fingerprint.
 *   9. The invariant companion polices the authority stream (epochs,
 *      manual⇔selection, router-never-supersedes-manual, stamps).
 *  10. Version identity is unique to this release; chains run the gates.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const violations = []
const check = (ok, message) => { if (!ok) violations.push(message) }
const read = rel => readFileSync(join(root, rel), 'utf8')

const PKG = 'packages/llm/llm-model-router'

// -- 1. Version identity -------------------------------------------------------
const manifest = JSON.parse(read(`${PKG}/package.json`))
check(manifest.version === '0.1.1-rc.4', `verify-model-router-v154: router package must carry the v0.15.4 release version (got ${manifest.version})`)
check(read('package.json').includes('"version": "0.1.1-rc.4"'), 'verify-model-router-v154: root manifest must carry the release version')
for (const file of ['package.json', 'README.md', 'README.zh.md', 'README.i18n.yaml',
  'src/index.ts', 'src/complexity.ts', 'src/invariant.ts', 'src/types.ts',
  'tests/model-router.spec.ts', 'tests/invariant.spec.ts', 'tests/loader-composition.spec.ts']) {
  check(existsSync(join(root, PKG, file)), `verify-model-router-v154: missing ${PKG}/${file}`)
}

// -- 2. One durable ModelSelectionState ----------------------------------------
const authority = read('packages/core/agent/src/authority.ts')
check(authority.includes("export type ModelSelectionState"), 'verify-model-router-v154: the durable ModelSelectionState union is missing')
check(authority.includes("mode: 'auto'") && authority.includes("mode: 'manual'"), 'verify-model-router-v154: the state must discriminate auto/manual modes')
check(authority.includes('readonly selection: ManualModelSelection'), 'verify-model-router-v154: manual states must carry the complete selection')
check(authority.includes('reasoningEffort?: string'), 'verify-model-router-v154: the durable selection must include the reasoning effort')

// 3. Append on every semantic change (not authority equality alone).
check(
  /prior\.mode === next\.mode[\s\S]{0,220}sameSelection/.test(authority),
  'verify-model-router-v154: suppression must compare the COMPLETE semantic state (mode+authority+selection+source), not authority alone',
)

// 4. Auto from durable state, never the WeakMap.
check(authority.includes('export function releaseToAuto'), 'verify-model-router-v154: the Auto release operation (releaseToAuto) is missing')
check(
  /releaseToAuto[\s\S]{0,600}reconstructSelectionState\(session\.events\)/.test(authority),
  'verify-model-router-v154: releaseToAuto must derive the current state from the DURABLE event log, not the WeakMap',
)

// 5. Future schema fails closed; default is exhaustive.
check(authority.includes('{ undecidable: true }'), 'verify-model-router-v154: reconstruction must fail closed on future authority schemas')
check(authority.includes("authority === 'default' ? 'default' : 'router'"), 'verify-model-router-v154: the default authority state must reconstruct (no zombie states)')

// 6. Manual claims require a complete route.
check(
  /a manual model selection must name its complete route/.test(authority),
  'verify-model-router-v154: a manual claim without provider/model must be rejected',
)

// -- 3. Production API exposes Auto --------------------------------------------
const apiProxy = read('packages/host/apiproxy/src/api-proxy.ts')
check(apiProxy.includes("request.payload.mode === 'auto'"), 'verify-model-router-v154: selectModel must accept the discriminated mode:auto shape')
check(apiProxy.includes('releaseToAuto(found.agent.session'), 'verify-model-router-v154: the Auto branch must release durable manual authority')
check(
  /mode === 'auto'[\s\S]{0,700}defaults\.defaultModelSelection\(\)/.test(apiProxy),
  'verify-model-router-v154: Auto must reset the picked model to the deployment default (no stale-route impersonation)',
)
const sessionsApi = read('packages/host/apiproxy/src/api/sessions.ts')
check(sessionsApi.includes("mode: 'auto'"), 'verify-model-router-v154: the RPC payload type must include the mode:auto variant')
const sessionsSchema = read('packages/host/apiproxy/src/api/sessions.schema.ts')
check(sessionsSchema.includes("z.literal('auto')"), 'verify-model-router-v154: the wire schema must accept mode:auto')

// 7. Crash-durable manual selection in the resolver.
check(
  apiProxy.includes('reconstructSelectionState(agent.session.events)'),
  'verify-model-router-v154: the selection getter must consult the durable manual state before the logged header (crash durability)',
)

// -- 4. Deterministic policy -----------------------------------------------------
const routerSource = read(`${PKG}/src/index.ts`)
check(!routerSource.includes('randomUUID'), 'verify-model-router-v154: decideRoute must not generate random identities (purity)')
check(routerSource.includes('export function routingDecisionIdentity'), 'verify-model-router-v154: the deterministic decision identity helper is missing')
check(
  /routingDecisionIdentity\(\s*input\.sessionId,\s*input\.turn,\s*input\.step,\s*POLICY_VERSION,\s*input\.config\.configFingerprint/.test(routerSource),
  'verify-model-router-v154: decision records must derive their id from execution coordinates + policy + configuration',
)

// 8. Telemetry stamps.
const routerTypes = read(`${PKG}/src/types.ts`)
check(routerTypes.includes('scorerVersion?: number'), 'verify-model-router-v154: routing decisions must record scorerVersion')
check(routerTypes.includes('configFingerprint?: string'), 'verify-model-router-v154: routing decisions must record the configuration fingerprint')
check(routerSource.includes('SCORER_VERSION, scoreComplexity'), 'verify-model-router-v154: the scorer version must be stamped from the scorer module')
check(routerSource.includes('configFingerprint = createHash'), 'verify-model-router-v154: the configuration fingerprint must be a canonical hash')

// 9. Invariant companion polices the authority stream.
const companion = read(`${PKG}/src/invariant.ts`)
check(companion.includes('regressed'), 'verify-model-router-v154: the invariant companion must police epoch monotonicity')
check(companion.includes('complete non-empty selection'), 'verify-model-router-v154: the invariant companion must require complete manual selections')
check(companion.includes('missing auto release'), 'verify-model-router-v154: the invariant companion must forbid router decisions superseding manual authority')
check(companion.includes('scoring implementation'), 'verify-model-router-v154: the invariant companion must validate telemetry stamps')

// 10. Reconstruction consumes the state stream.
check(routerSource.includes('reconstructSelectionState(events)'), 'verify-model-router-v154: router reconstruction must consume the durable selection state')

// Packaging: the shared runtime chunk ships in the tarball.
const filesList = JSON.parse(read(`${PKG}/package.json`)).files ?? []
check(filesList.includes('lib/types-*.js'), 'verify-model-router-v154: the shared runtime chunk (lib/types-*.js) must be declared in files — the tarball otherwise breaks consumers')

// -- 5. Canonical vocabulary + chains -------------------------------------------
const knownEvents = read('packages/core/session/src/known-event-types.ts')
check(knownEvents.includes("'model/selection-authority'"), 'verify-model-router-v154: model/selection-authority missing from the generated known-event catalog')
const catalog = read('docs/persistence-catalog.md')
check(catalog.includes('`model/selection-authority`'), 'verify-model-router-v154: persistence catalog not regenerated')
const scripts = JSON.parse(read('package.json')).scripts
for (const chain of ['check:all', 'check:ci', 'release:verify']) {
  const script = scripts[chain] ?? ''
  for (const gate of ['verify:model-router-v15', 'verify:model-router-v152', 'verify:model-router-v153', 'verify:model-router-v154', 'verify:model-router-packed', 'qualify:model-router-authority-v154']) {
    check(script.includes(`npm run ${gate}`), `verify-model-router-v154: ${chain} must run ${gate}`)
  }
}
// Frozen baselines stay untouched.
for (const [file, version] of [['BASELINE_v0.15.1.json', '0.15.1']]) {
  const path = join(root, file)
  check(existsSync(path), `verify-model-router-v154: frozen ${file} missing`)
  if (existsSync(path)) {
    check(JSON.parse(readFileSync(path, 'utf8')).version === version, `verify-model-router-v154: ${file} altered`)
  }
}

// README pair stays recorded.
function blobHash(relPath) {
  const bytes = readFileSync(join(root, relPath))
  return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex')
}
const i18n = read(`${PKG}/README.i18n.yaml`)
for (const file of ['README.md', 'README.zh.md']) {
  const recorded = new RegExp(`^${file}: ([0-9a-f]{40})$`, 'm').exec(i18n)?.[1]
  check(recorded === blobHash(`${PKG}/${file}`), `verify-model-router-v154: ${PKG}/${file} changed without re-recording ${PKG}/README.i18n.yaml`)
}

if (violations.length > 0) {
  for (const line of violations) console.error(line)
  console.error(`verify-model-router-v154: ${violations.length} violation(s)`)
  process.exit(1)
}
console.log('verify-model-router-v154: pass')
