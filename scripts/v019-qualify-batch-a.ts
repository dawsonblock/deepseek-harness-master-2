/**
 * v0.19 Batch A corpus qualification runner.
 *
 * Runs all 25 Batch A tasks through the qualification state machine:
 *   CANDIDATE -> REPRODUCED -> VERIFIER_VALIDATED -> LEAKAGE_CHECKED -> FROZEN
 *
 * Outputs a qualification report to stdout and writes a JSON record
 * to artifacts/evals/v019-batch-a-qualification.json.
 *
 * Usage: npx tsx scripts/v019-qualify-batch-a.ts
 *
 * @module v019-qualify-batch-a
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { BATCH_A_CORPUS } from './v019-batch-a-corpus.ts'
import {
  qualifyTask,
  getReferenceFixFiles,
  type TaskQualificationRecord,
} from './v019-corpus-qualification.ts'
import type { TaskManifest } from './v019-task-manifest.ts'

const REPO_ROOT = join(import.meta.dirname, '..')
const ARTIFACT_DIR = join(REPO_ROOT, 'artifacts', 'evals')

/**
 * Clone a repository at the base commit into a temporary workspace.
 * Returns the workspace path.
 */
function cloneAtBase(manifest: TaskManifest): string {
  const workspace = mkdtempSync(join(tmpdir(), `v019-qualify-${manifest.repository.name}-`))
  try {
    execSync(`git clone --quiet "${manifest.repository.url}" "${workspace}"`, {
      encoding: 'utf8',
      timeout: 60000,
    })
    execSync(`git checkout ${manifest.repository.baseCommit}`, {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 30000,
    })
  } catch (error: unknown) {
    rmSync(workspace, { recursive: true, force: true })
    throw error
  }
  return workspace
}

async function main(): Promise<void> {
  console.log('v0.19 Batch A Corpus Qualification')
  console.log('==================================')
  console.log(`Total tasks: ${BATCH_A_CORPUS.length}`)
  console.log()

  const results: TaskQualificationRecord[] = []

  for (const manifest of BATCH_A_CORPUS) {
    process.stdout.write(`Qualifying ${manifest.taskId}... `)

    let workspace: string | undefined
    try {
      workspace = cloneAtBase(manifest)

      // Install dependencies
      try {
        execSync('npm install --silent', {
          cwd: workspace,
          encoding: 'utf8',
          timeout: 120000,
          stdio: 'pipe',
        })
      } catch {
        // npm install may fail for the dependency-fix task at base — that's expected
      }

      // Get reference fix files
      const referenceFixFiles = manifest.repository.referenceFixCommit !== undefined
        ? getReferenceFixFiles(workspace, manifest.repository.referenceFixCommit)
        : []

      // Run qualification
      const record = qualifyTask(manifest, workspace, referenceFixFiles)
      results.push(record)

      if (record.currentState === 'FROZEN') {
        console.log('FROZEN')
      } else {
        console.log(`REJECTED at ${record.history.at(-1)?.gate ?? 'unknown'}: ${record.history.at(-1)?.reason ?? 'unknown'}`)
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(`ERROR: ${message}`)
      results.push({
        taskId: manifest.taskId,
        manifest,
        currentState: 'REJECTED',
        history: [{
          taskId: manifest.taskId,
          state: 'REJECTED',
          gate: 'REPRODUCED',
          passed: false,
          reason: `Clone/setup error: ${message}`,
          details: [],
        }],
        qualifiedAt: undefined,
      })
    } finally {
      if (workspace !== undefined && existsSync(workspace)) {
        rmSync(workspace, { recursive: true, force: true })
      }
    }
  }

  // Summary
  const frozen = results.filter(r => r.currentState === 'FROZEN')
  const rejected = results.filter(r => r.currentState === 'REJECTED')

  console.log()
  console.log('Summary')
  console.log('======')
  console.log(`FROZEN:   ${frozen.length}/${results.length}`)
  console.log(`REJECTED: ${rejected.length}/${results.length}`)
  console.log()

  if (rejected.length > 0) {
    console.log('Rejected tasks:')
    for (const r of rejected) {
      const lastGate = r.history.at(-1)
      console.log(`  ${r.taskId}: ${lastGate?.gate} — ${lastGate?.reason}`)
    }
    console.log()
  }

  // Category and strength distribution
  const frozenManifests = frozen.map(r => r.manifest)
  const categoryCounts: Record<string, number> = {}
  const strengthCounts: Record<string, number> = {}
  for (const m of frozenManifests) {
    categoryCounts[m.category] = (categoryCounts[m.category] ?? 0) + 1
    strengthCounts[m.verification.strength] = (strengthCounts[m.verification.strength] ?? 0) + 1
  }
  console.log('Category distribution (FROZEN only):')
  for (const [cat, count] of Object.entries(categoryCounts).sort()) {
    console.log(`  ${cat}: ${count}`)
  }
  console.log()
  console.log('Verification strength distribution (FROZEN only):')
  for (const [str, count] of Object.entries(strengthCounts).sort()) {
    console.log(`  ${str}: ${count}`)
  }
  console.log()

  // Write artifact
  await mkdir(ARTIFACT_DIR, { recursive: true })
  const artifactPath = join(ARTIFACT_DIR, 'v019-batch-a-qualification.json')
  await writeFile(artifactPath, JSON.stringify({
    qualifiedAt: new Date().toISOString(),
    totalTasks: results.length,
    frozen: frozen.length,
    rejected: rejected.length,
    results: results.map(r => ({
      taskId: r.taskId,
      currentState: r.currentState,
      qualifiedAt: r.qualifiedAt,
      history: r.history.map(h => ({
        gate: h.gate,
        passed: h.passed,
        reason: h.reason,
      })),
    })),
  }, null, 2), 'utf8')
  console.log(`Qualification record written to ${artifactPath}`)

  if (rejected.length > 0) {
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('Fatal error:', error)
  process.exit(1)
})
