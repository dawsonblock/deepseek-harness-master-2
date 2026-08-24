import { cp, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const declarations = join(root, 'lib', 'types')
const runtime = join(root, 'lib')
await mkdir(runtime, { recursive: true })

// TypeScript emits declarations and ESM side by side. Keep the public runtime
// flat at lib/*.js while retaining only declarations below lib/types/.
for (const entry of await readdir(declarations)) {
  if (!entry.endsWith('.js') && !entry.endsWith('.js.map')) continue
  await cp(join(declarations, entry), join(runtime, entry))
  await rm(join(declarations, entry), { force: true })
}
await rm(join(runtime, 'tsconfig.tsbuildinfo'), { force: true })
