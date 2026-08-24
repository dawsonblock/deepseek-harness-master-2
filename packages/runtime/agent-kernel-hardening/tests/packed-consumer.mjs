import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const cwd = new URL('..', import.meta.url).pathname
const packed = spawnSync('npm', ['pack', '--json', '--ignore-scripts'], { cwd, encoding: 'utf8' })
if (packed.status !== 0) throw new Error(packed.stderr || packed.stdout)
const info = JSON.parse(packed.stdout)
const filename = info[0]?.filename
assert.equal(typeof filename, 'string')
const temp = await mkdtemp(join(tmpdir(), 'dsh-hardening-pack-'))
try {
  const packageDir = join(temp, 'node_modules', '@deepseek-ai', 'dsh-agent-kernel-hardening')
  await mkdir(packageDir, { recursive: true })
  const extract = spawnSync('tar', ['-xzf', join(cwd, filename), '--strip-components=1', '-C', packageDir], { encoding: 'utf8' })
  if (extract.status !== 0) throw new Error(extract.stderr || extract.stdout)
  const probe = join(temp, 'probe.mjs')
  await import('node:fs/promises').then(({ writeFile }) => writeFile(probe, `import { deriveAgentKernelMetrics } from '@deepseek-ai/dsh-agent-kernel-hardening';\nif (typeof deriveAgentKernelMetrics !== 'function') process.exit(2);\n`))
  const run = spawnSync(process.execPath, [probe], { cwd: temp, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr || run.stdout)
  const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
  assert.equal(manifest.exports['.'].default, './lib/index.js')
} finally {
  try { await rm(join(cwd, filename), { force: true }) } catch {}
  await rm(temp, { recursive: true, force: true })
}
