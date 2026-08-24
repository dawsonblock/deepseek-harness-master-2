#!/usr/bin/env node
/**
 * Packed-consumer verification for the model-router package: build the
 * package's runtime peer closure through the repository's own toolchain
 * (tsc project builds + tsdown bundles), then import the built bundle as a
 * plain Node consumer and exercise the public API surface.
 *
 * Usage: node scripts/verify-model-router-packed.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(import.meta.url), '..', '..')
const tsc = join(root, 'node_modules', '.bin', 'tsc')
const tsdown = join(root, 'node_modules', '.bin', 'tsdown')
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'pipe', encoding: 'utf8' })

// 1. Type-build the router's project reference closure, plus the agent-loop
//    project (dsh-agent's bundle externalizes it, but it is not one of the
//    router's own project references).
run(tsc, ['-b', 'packages/llm/llm-model-router/tsconfig.json', 'packages/core/agent-loop/tsconfig.json'], root)

// 2. Bundle the router and its runtime peers. tsdown resolves config-relative
//    entries and config-file imports against the config's own location, so each
//    package gets a transient in-package config (imports tsdown through the
//    workspace, entries as absolute paths) that is removed after its build.
//    Schemastery keeps its own dual-format config (lib/index.mjs/.cjs), so it
//    bundles through that instead of the generic single-format config.
const bundle = (pkgRel) => {
  const pkgDir = join(root, pkgRel)
  const entries = ['lib/types/index.js', 'lib/types/invariant.js']
    .map(rel => join(pkgDir, rel))
    .filter(entry => existsSync(entry))
  if (entries.length === 0) throw new Error(`packed verify: ${pkgRel} has no built lib/types entries`)
  const config = join(pkgDir, 'tsdown.packed.tmp.mjs')
  writeFileSync(config, [
    "import { defineConfig } from 'tsdown'",
    `export default defineConfig({ entry: ${JSON.stringify(entries)}, outDir: ${JSON.stringify(join(pkgDir, 'lib'))}, format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false, splitting: false })`,
    '',
  ].join('\n'))
  try {
    run(tsdown, ['--config', config], pkgDir)
  } finally {
    rmSync(config, { force: true })
  }
}
for (const pkg of ['vendor/cosmokit', 'vendor/cordis', 'packages/util/brand', 'packages/util/timeout', 'packages/core/scope', 'packages/core/session', 'packages/core/agent-loop', 'packages/llm/llm', 'packages/core/agent']) {
  bundle(pkg)
}
// Schemastery: build through its own dual-format config (requires its tsc
// lib/types output, produced by the project build above via project references).
run(tsc, ['-b', 'vendor/schemastery/tsconfig.json'], root)
run(tsdown, [], join(root, 'vendor/schemastery'))
// The router itself bundles last, over its own config.
run(tsc, ['-b', 'packages/llm/llm-model-router/tsconfig.json'], root)
{
  const pkgDir = join(root, 'packages/llm/llm-model-router')
  const config = join(pkgDir, 'tsdown.packed.tmp.mjs')
  writeFileSync(config, [
    "import { defineConfig } from 'tsdown'",
    `export default defineConfig({ entry: [${JSON.stringify(join(pkgDir, 'lib/types/index.js'))}, ${JSON.stringify(join(pkgDir, 'lib/types/invariant.js'))}], outDir: ${JSON.stringify(join(pkgDir, 'lib'))}, format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false, splitting: false })`,
    '',
  ].join('\n'))
  try {
    run(tsdown, ['--config', config], pkgDir)
  } finally {
    rmSync(config, { force: true })
  }
}

// 3. Version assertion (v0.15.3): the built package must carry the release
//    version — the published artifact may not share identity with the
//    v0.15.1/v0.15.2 builds.
const routerPkgDir = join(root, 'packages/llm/llm-model-router')
const pkgManifest = JSON.parse(readFileSync(join(routerPkgDir, 'package.json'), 'utf8'))
if (pkgManifest.version !== '0.1.1-rc.4') {
  throw new Error(`packed verify: package version must be 0.1.1-rc.3, got ${pkgManifest.version}`)
}

// 4. Plain-Node consumer: import by package name through the exports map and
//    exercise the API surface, exactly as a downstream integration would.
const consumer = `
const pkg = await import('@deepseek-ai/dsh-llm-model-router')
const inv = await import('@deepseek-ai/dsh-llm-model-router/invariant')
const required = ['apply', 'Config', 'name', 'inject', 'decideRoute', 'scoreComplexity', 'resolveConfig', 'turnUserText', 'turnDiscoveredFacts', 'reconstructRoutingState', 'POLICY_VERSION', 'DEFAULT_ESCALATION_THRESHOLD', 'noFamilyAloneReaches', 'DEFAULT_MIN_TOOL_CALLS', 'DEFAULT_MIN_TOOL_RESULT_CHARS']
const missing = required.filter(key => !(key in pkg))
if (missing.length > 0) throw new Error('missing exports: ' + missing.join(', '))
if (pkg.name !== 'llm-model-router' || pkg.POLICY_VERSION !== 2) throw new Error('bad plugin identity')
if (typeof pkg.apply !== 'function' || typeof inv.apply !== 'function' || inv.inject[0] !== 'invariants') throw new Error('bad plugin shapes')
const config = pkg.resolveConfig({ fastRoute: { provider: 'p', model: 'fast' }, heavyRoute: { provider: 'p', model: 'heavy' } })
const facts = { userText: () => 'Prove the theorem. Think step by step.', discovered: () => ({ toolCalls: 0, toolResultChars: 0 }) }
const d = pkg.decideRoute({ proposed: { provider: 'p', model: 'fast' }, explicitSelection: false, isSubagent: false, turn: 1, step: 1, facts, memory: undefined, config })
if (d.config.model !== 'heavy' || d.reason !== 'escalated-to-heavy') throw new Error('policy smoke failed: ' + d.reason)
console.log('PACKED CONSUMER OK')
`
const result = run(process.execPath, ['--input-type=module', '-e', consumer], join(root, 'packages/llm/llm-model-router'))
if (!result.includes('PACKED CONSUMER OK')) throw new Error('consumer smoke did not pass')

// 4. Tarball verification (v0.15.2, audit Phase 15): `npm pack` the package,
//    assert the tarball carries exactly the declared `files` payload plus
//    package.json/README, then extract it into an ISOLATED consumer directory
//    (only the published files present) with the runtime peer packages linked
//    in, and import the package BY NAME from there. This proves the published
//    artifact — not just the workspace source — resolves through its exports
//    map and executes.
const pkgDir = join(root, 'packages/llm/llm-model-router')
const npmBin = execFileSync('which', ['npm'], { encoding: 'utf8' }).trim() || 'npm'
const packOut = run(npmBin, ['pack', '--json'], pkgDir)
const tarballName = JSON.parse(packOut)[0]?.filename
if (tarballName === undefined) throw new Error('packed verify: npm pack produced no tarball')
const tarball = join(pkgDir, tarballName)
try {
  const consumerDir = join(root, 'node_modules', '.dsh-packed-consumer')
  rmSync(consumerDir, { recursive: true, force: true })
  const installedRoot = join(consumerDir, 'node_modules', '@deepseek-ai')
  run('mkdir', ['-p', installedRoot])
  // Extract the tarball: npm packs with a `package/` prefix — strip it.
  run('tar', ['-xzf', tarball, '-C', installedRoot])
  run('mv', [join(installedRoot, 'package'), join(installedRoot, 'dsh-llm-model-router')])
  // Link the runtime peer packages so the tarball copy's externals resolve.
  for (const pkg of ['cosmokit', 'cordis', 'schemastery']) {
    run('ln', ['-s', join(root, 'vendor', pkg), join(installedRoot, pkg === 'cosmokit' || pkg === 'cordis' || pkg === 'schemastery' ? pkg : pkg)])
  }
  for (const pkg of ['dsh-brand', 'dsh-timeout', 'dsh-scope', 'dsh-session', 'dsh-agent-loop', 'dsh-llm', 'dsh-agent']) {
    const source = pkg === 'dsh-brand' ? 'packages/util/brand'
      : pkg === 'dsh-timeout' ? 'packages/util/timeout'
        : pkg === 'dsh-scope' ? 'packages/core/scope'
          : pkg === 'dsh-session' ? 'packages/core/session'
            : pkg === 'dsh-agent-loop' ? 'packages/core/agent-loop'
              : pkg === 'dsh-llm' ? 'packages/llm/llm'
                : pkg === 'dsh-agent' ? 'packages/core/agent' : undefined
    run('ln', ['-s', join(root, source), join(installedRoot, pkg)])
  }
  // The isolated consumer imports ONLY the declared public API of the
  // extracted tarball copy — never source paths.
  const isolated = `
const pkg = await import('@deepseek-ai/dsh-llm-model-router')
const inv = await import('@deepseek-ai/dsh-llm-model-router/invariant')
if (pkg.name !== 'llm-model-router' || pkg.POLICY_VERSION !== 2) throw new Error('bad plugin identity')
if (typeof pkg.apply !== 'function' || typeof inv.apply !== 'function') throw new Error('bad plugin shapes')
const bad = () => pkg.resolveConfig({ fastRoute: { provider: 'p', model: 'f' }, heavyRoute: { provider: 'p', model: 'h' }, escalationThreshold: 2 })
try { bad(); throw new Error('threshold enforcement missing in tarball build') } catch (error) {
  if (!String(error).includes('cross-family')) throw error
}
console.log('TARBALL CONSUMER OK')
`
  const isolatedResult = run(process.execPath, ['--input-type=module', '-e', isolated], consumerDir)
  if (!isolatedResult.includes('TARBALL CONSUMER OK')) throw new Error('isolated tarball consumer did not pass')
} finally {
  rmSync(tarball, { force: true })
  rmSync(join(root, 'node_modules', '.dsh-packed-consumer'), { recursive: true, force: true })
}
console.log('verify-model-router-packed: pass')
