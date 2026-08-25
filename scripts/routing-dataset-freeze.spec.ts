import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { verifyRoutingDatasetFreeze } from './verify-routing-dataset-freeze.ts'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const MANIFEST_PATH = join(REPO_ROOT, 'artifacts', 'reports', 'paired-v4-100-v1.manifest.json')

describe('verifyRoutingDatasetFreeze', () => {
  it('accepts the pinned baseline', async () => {
    await expect(verifyRoutingDatasetFreeze(REPO_ROOT, MANIFEST_PATH)).resolves.toEqual({
      datasetId: 'paired-v4-100-v1',
      taskClasses: 50,
    })
  })

  it('rejects a changed artifact hash', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'routing-freeze-'))
    try {
      const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8')) as {
        artifacts: { pairedData: { sha256: string } }
      }
      manifest.artifacts.pairedData.sha256 = '0'.repeat(64)
      const path = join(directory, 'manifest.json')
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

      await expect(verifyRoutingDatasetFreeze(REPO_ROOT, path)).rejects.toThrow(/changed/)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
