/**
 * Corpus determinism test — verifies that the synthetic repository generator
 * produces byte-for-byte identical Git commits across two independent runs.
 *
 * Runs `scripts/v019-batch-a-repos.sh` twice into separate directories with
 * isolated holdout roots, then compares every repo's base commit, reference
 * fix commit, and dependency lock hash.
 *
 * @module v019-corpus-determinism.spec
 */

import { describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SCRIPT = join(import.meta.dirname, 'v019-batch-a-repos.sh')
const REPOS = ['ts-collections', 'ts-date', 'ts-http', 'ts-state', 'ts-string', 'ts-utils', 'ts-validate']

interface RepoReceipt {
  readonly baseCommit: string
  readonly referenceFixCommit: string
  readonly lockHash: string
}
type Receipt = Record<string, RepoReceipt>

function generateCorpus(root: string, holdouts: string): Receipt {
  execSync(`REPO_ROOT="${root}" HOLDOUT_ROOT="${holdouts}" bash "${SCRIPT}"`, {
    stdio: 'pipe',
    timeout: 300000,
    env: { ...process.env, REPO_ROOT: root, HOLDOUT_ROOT: holdouts },
  })
  const receiptPath = join(root, 'corpus-receipt.json')
  if (!existsSync(receiptPath)) throw new Error(`receipt not found at ${receiptPath}`)
  return JSON.parse(readFileSync(receiptPath, 'utf8')) as Receipt
}

describe('v019 corpus determinism', { timeout: 600000 }, () => {
  it('produces identical commit hashes and lock hashes across two independent runs', () => {
    const rootA = join(tmpdir(), `v019-corpus-determinism-A-${Date.now()}`)
    const rootB = join(tmpdir(), `v019-corpus-determinism-B-${Date.now()}`)
    const holdoutsA = join(tmpdir(), `v019-holdouts-A-${Date.now()}`)
    const holdoutsB = join(tmpdir(), `v019-holdouts-B-${Date.now()}`)

    let receiptA: Receipt
    let receiptB: Receipt
    try {
      receiptA = generateCorpus(rootA, holdoutsA)
      receiptB = generateCorpus(rootB, holdoutsB)
    } finally {
      rmSync(rootA, { recursive: true, force: true })
      rmSync(rootB, { recursive: true, force: true })
      rmSync(holdoutsA, { recursive: true, force: true })
      rmSync(holdoutsB, { recursive: true, force: true })
    }

    expect(Object.keys(receiptA).sort()).toEqual(REPOS)
    expect(Object.keys(receiptB).sort()).toEqual(REPOS)

    for (const repo of REPOS) {
      const a = receiptA[repo]!
      const b = receiptB[repo]!
      expect(a.baseCommit, `${repo} base commit`).toBe(b.baseCommit)
      expect(a.referenceFixCommit, `${repo} reference fix commit`).toBe(b.referenceFixCommit)
      expect(a.lockHash, `${repo} dependency lock hash`).toBe(b.lockHash)
      expect(a.lockHash.length).toBe(64)
    }
  })
})
