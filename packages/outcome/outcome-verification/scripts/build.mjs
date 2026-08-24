import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lib = join(root, 'lib')
rmSync(lib, { recursive: true, force: true })
mkdirSync(lib, { recursive: true })
execFileSync('tsc', ['-p', join(root, 'tsconfig.json')], { stdio: 'inherit' })
// The source is deliberately runtime-valid TypeScript with no TS-only runtime
// constructs after type erasure. Use the globally available tsc for JS emit too.
execFileSync('tsc', [
  '-p', join(root, 'tsconfig.json'),
  '--composite', 'false',
  '--declaration', 'false',
  '--declarationMap', 'false',
  '--sourceMap', 'true',
  '--outDir', lib,
], { stdio: 'inherit' })
