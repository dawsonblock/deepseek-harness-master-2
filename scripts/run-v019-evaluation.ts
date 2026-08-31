#!/usr/bin/env node
/**
 * v0.19 synthetic multi-repository evaluation runner.
 *
 * Runs the frozen v0.18.0 repair controller policy against real coding tasks
 * from multiple open-source repositories. Captures full trajectory data,
 * computes pre-registered metrics, and classifies failures.
 *
 * Self-skips without DEEPSEEK_API_KEY.
 *
 * Usage:
 *   npx tsx scripts/run-v019-evaluation.ts [--max-tasks N] [--b0]
 *
 * --b0: Run as B0 infrastructure validation (not benchmark-eligible).
 *
 * @module v019-evaluation-runner
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildExperimentManifest,
  computeCorpusManifestHash,
} from './v019-experiment-identity.ts'
import { runComposedRuntimeQualification, computeQualificationSemanticHash } from './v019-composed-runtime-qualification.ts'
import {
  FROZEN_V018_LIMITS,
} from './v019-task-manifest.ts'
import {
  checkoutRepo,
  cleanupWorkspace,
  cleanupBaseline,
  computeRepoMetadata,
  freezeBaseline,
  installDependencies,
  type RepoCheckout,
} from './v019-repo-checkout.ts'
import { getReferenceFixFiles } from './v019-corpus-qualification.ts'
import {
  type TaskState,
  type TaskTrajectory,
  buildInfraFailureTrajectory,
  runTaskTrajectory,
} from './v019-trajectory-collector.ts'
import { computeMetrics } from './v019-metrics.ts'
import {
  classifyAllFailures,
  failureCategorySummary,
} from './v019-failure-taxonomy.ts'
import { SANDBOX_QUALIFICATION_ID } from './v018-sandbox-qualification.ts'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const EVAL_DIR = join(REPO_ROOT, 'artifacts', 'evals', 'v019-synthetic-multirepo-validation-v3')
const CHECKPOINT_PATH = join(EVAL_DIR, 'checkpoint.json')
const METRICS_PATH = join(EVAL_DIR, 'metrics.json')
const FAILURES_PATH = join(EVAL_DIR, 'failures.json')
const TRAJECTORIES_DIR = join(EVAL_DIR, 'trajectories')
const MANIFEST_PATH = join(EVAL_DIR, 'manifest.json')
const REPORT_PATH = join(EVAL_DIR, 'README.md')

// ---------------------------------------------------------------------------
// Task corpus: synthetic multi-repository tasks
// ---------------------------------------------------------------------------

import { TASK_CORPUS } from './v019-task-corpus.ts'

// ---------------------------------------------------------------------------
// Checkpoint management
// ---------------------------------------------------------------------------

interface Checkpoint {
  experimentId: string
  /** Manifest hash that produced this checkpoint. Resume is rejected on mismatch. */
  experimentManifestHash: string
  benchmarkEligible: boolean
  startedAt: string
  updatedAt: string
  completedTaskIds: string[]
  trajectories: TaskTrajectory[]
}

async function loadCheckpoint(): Promise<Checkpoint | undefined> {
  try {
    const content = await readFile(CHECKPOINT_PATH, 'utf8')
    const parsed = JSON.parse(content) as Partial<Checkpoint>
    // Old checkpoints from v1 lack experimentManifestHash. Treat them as
    // incompatible rather than crashing on the field access.
    if (parsed.experimentId === undefined || parsed.experimentManifestHash === undefined) return undefined
    return parsed as Checkpoint
  } catch { return undefined }
}

async function saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
  await mkdir(EVAL_DIR, { recursive: true })
  await writeFile(CHECKPOINT_PATH, JSON.stringify(checkpoint, null, 2) + '\n', 'utf8')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const maxTasksIdx = args.indexOf('--max-tasks')
  const maxTasks = maxTasksIdx >= 0 ? parseInt(args[maxTasksIdx + 1] ?? '75', 10) : 75
  const isB0 = args.includes('--b0')
  const testCheckpoint = args.includes('--test-checkpoint')
  const benchmarkEligible = !isB0

  if (process.env.DEEPSEEK_API_KEY === undefined || process.env.DEEPSEEK_API_KEY === '') {
    process.stderr.write('DEEPSEEK_API_KEY is not set; skipping v0.19 synthetic multi-repository evaluation.\n')
    process.stderr.write('Provide a key to run the evaluation cohort.\n')
    return
  }

  process.stderr.write('\nv0.19 Real-Repository Evaluation\n')
  process.stderr.write(`${'='.repeat(60)}\n`)
  if (isB0) {
    process.stderr.write('MODE: B0 Infrastructure Validation (NOT benchmark-eligible)\n')
  } else {
    process.stderr.write('MODE: Baseline Cohort (benchmark-eligible)\n')
  }

  // Run composed qualification to bind the experiment manifest to the
  // actual sandbox backend and snapshot algorithm versions.
  const composedRecord = await runComposedRuntimeQualification()
  if (!composedRecord.ready) {
    process.stderr.write('\nCOMPOSED RUNTIME QUALIFICATION FAILED\n')
    process.stderr.write('Cannot proceed to evaluation. Fix the composed runtime qualification first.\n')
    process.exit(1)
  }

  // Build and verify experiment manifest
  const experimentManifest = buildExperimentManifest({
    repairControllerVersion: '0.18.0',
    repairRuntimeVersion: '0.18.0',
    eventSchemaVersion: 0,
    pricingVersion: '2026-08-25',
    sandboxPolicyVersion: 'v1',
    sandboxQualificationId: SANDBOX_QUALIFICATION_ID,
    taskCorpusVersion: 'v019-synthetic-multirepo-v3',
    corpusManifestHash: computeCorpusManifestHash(TASK_CORPUS.slice(0, maxTasks)),
    taskCount: Math.min(TASK_CORPUS.length, maxTasks),
    repositoryCount: new Set(TASK_CORPUS.slice(0, maxTasks).map(t => t.repository.name)).size,
    benchmarkEligible,
    securityGateBypassed: false,
    repairStrategy: 'transactional',
    sandboxBackend: {
      runner: composedRecord.backend.runner,
      runnerPath: composedRecord.backend.runnerPath,
      runnerVersion: composedRecord.backend.runnerVersion,
      enforcement: composedRecord.backend.enforcement,
      networkDenied: composedRecord.backend.networkDenied,
    },
    snapshotAlgorithm: composedRecord.snapshot.algorithm,
    snapshotExclusions: composedRecord.snapshot.exclusions,
    qualificationSemanticHash: computeQualificationSemanticHash(composedRecord),
    qualificationArtifactHash: createHash('sha256')
      .update(JSON.stringify(composedRecord))
      .digest('hex'),
  })

  process.stderr.write(`Experiment ID: ${experimentManifest.experimentId}\n`)
  process.stderr.write(`Source commit: ${experimentManifest.sourceCommit.slice(0, 12)}\n`)
  process.stderr.write(`Frozen v0.18 tag: ${experimentManifest.frozenV018Tag}\n`)
  process.stderr.write(`Manifest hash: ${experimentManifest.manifestHash}\n`)
  process.stderr.write(`Benchmark eligible: ${experimentManifest.benchmarkEligible}\n`)
  process.stderr.write(`Tasks: ${experimentManifest.taskCount}\n`)
  process.stderr.write(`Repositories: ${experimentManifest.repositoryCount}\n\n`)

  // Save experiment manifest
  await mkdir(EVAL_DIR, { recursive: true })
  await writeFile(MANIFEST_PATH, JSON.stringify(experimentManifest, null, 2) + '\n', 'utf8')
  await mkdir(TRAJECTORIES_DIR, { recursive: true })

  // Load checkpoint for resumption
  const checkpoint = await loadCheckpoint()
  if (checkpoint !== undefined && checkpoint.benchmarkEligible !== benchmarkEligible) {
    process.stderr.write(
      `FATAL: checkpoint benchmarkEligible=${checkpoint.benchmarkEligible} does not match run benchmarkEligible=${benchmarkEligible}\n` +
      'Delete the checkpoint to start a new run, or use the matching mode.\n',
    )
    return
  }
  if (checkpoint !== undefined && checkpoint.experimentManifestHash !== experimentManifest.manifestHash) {
    process.stderr.write(
      'WARNING: checkpoint experiment manifest hash differs. Starting fresh.\n',
    )
  }
  const checkpointValid = checkpoint !== undefined
    && checkpoint.experimentManifestHash === experimentManifest.manifestHash
  const completedTaskIds = new Set(checkpointValid ? checkpoint.completedTaskIds : [])
  const trajectories: TaskTrajectory[] = checkpointValid ? checkpoint.trajectories : []
  // Preserve startedAt only from a valid checkpoint. An invalid checkpoint
  // represents a different experiment; inheriting its startedAt would make
  // the audit record inaccurate.
  const startedAt = checkpointValid ? checkpoint.startedAt : new Date().toISOString()

  const tasks = TASK_CORPUS.slice(0, maxTasks)
  process.stderr.write(`Tasks to run: ${tasks.length - completedTaskIds.size} remaining\n\n`)

  for (const taskManifest of tasks) {
    if (completedTaskIds.has(taskManifest.taskId)) {
      process.stderr.write(`Skipping completed: ${taskManifest.taskId}\n`)
      continue
    }

    process.stderr.write(`\nRunning: ${taskManifest.taskId} (${taskManifest.task.title})\n`)
    process.stderr.write(`  Repo: ${taskManifest.repository.name} @ ${taskManifest.repository.baseCommit.slice(0, 8)}\n`)
    process.stderr.write(`  Category: ${taskManifest.category}\n`)

    let workspace: string | undefined
    let checkout: RepoCheckout | undefined
    let taskState: TaskState = 'PENDING'
    try {
      // Checkout repository at base commit (archive snapshot, no .git)
      taskState = 'CHECKOUT'
      process.stderr.write('  [CHECKOUT] Checking out repository...\n')
      checkout = await checkoutRepo(
        taskManifest.repository.url,
        taskManifest.repository.baseCommit,
        taskManifest.repository.name,
      )
      workspace = checkout.workspace

      // Install dependencies
      taskState = 'SETUP'
      process.stderr.write('  [SETUP] Installing dependencies...\n')
      await installDependencies(workspace)

      // Freeze the exact post-setup baseline B0 for rollback restoration.
      process.stderr.write('  [SETUP] Freezing baseline snapshot...\n')
      const baseline = freezeBaseline(workspace)

      // Compute repo metadata
      const repoMetadata = computeRepoMetadata(workspace, {
        name: taskManifest.repository.name,
        url: taskManifest.repository.url,
        baseCommit: taskManifest.repository.baseCommit,
        size: taskManifest.repoSize,
      })
      process.stderr.write(`  Repo: ${repoMetadata.loc} LOC, ${repoMetadata.fileCount} files, ${repoMetadata.testCount} tests\n`)

      // Get reference fix files from the verifier-only clone (not the model workspace)
      const referenceFixFiles = taskManifest.repository.referenceFixCommit !== undefined
        ? getReferenceFixFiles(checkout.cloneDir, taskManifest.repository.referenceFixCommit)
        : []

      // Run the task trajectory
      taskState = 'RUNNING'
      process.stderr.write('  [RUNNING] Running repair loop...\n')
      const trajectory = await runTaskTrajectory(
        taskManifest,
        workspace,
        experimentManifest.experimentId,
        experimentManifest.manifestHash,
        benchmarkEligible,
        repoMetadata,
        referenceFixFiles,
        checkout,
        baseline,
        experimentManifest.repairStrategy,
      )

      // Save trajectory
      const trajectoryPath = join(TRAJECTORIES_DIR, `${taskManifest.taskId}.json`)
      await writeFile(trajectoryPath, JSON.stringify(trajectory, null, 2) + '\n', 'utf8')
      trajectories.push(trajectory)
      completedTaskIds.add(taskManifest.taskId)

      process.stderr.write(`  Result: ${trajectory.finalVerified ? 'VERIFIED' : 'FAILED'}\n`)
      process.stderr.write(`  Attempts: ${trajectory.attempts.length} (Flash=${trajectory.flashAttempts}, Pro=${trajectory.proAttempts})\n`)
      process.stderr.write(`  Cost: $${trajectory.totalCostUsd.toFixed(6)}\n`)
      process.stderr.write(`  Latency: ${trajectory.totalLatencyMs}ms\n`)
      process.stderr.write(`  Terminal: ${trajectory.terminalOutcome}\n`)
      process.stderr.write(`  Control: ${trajectory.controlPlaneStatus}, Capability: ${trajectory.modelCapabilityStatus}\n`)

      // Checkpoint after each task
      await saveCheckpoint({
        experimentId: experimentManifest.experimentId,
        experimentManifestHash: experimentManifest.manifestHash,
        benchmarkEligible,
        startedAt,
        updatedAt: new Date().toISOString(),
        completedTaskIds: [...completedTaskIds],
        trajectories,
      })
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      process.stderr.write(`  [FAILED_INFRA] ${taskState}: ${errorMsg}\n`)
      const failedTrajectory = buildInfraFailureTrajectory(
        taskManifest,
        experimentManifest.experimentId,
        experimentManifest.manifestHash,
        benchmarkEligible,
        undefined,
        `${taskState}: ${errorMsg}`,
      )
      trajectories.push(failedTrajectory)
      completedTaskIds.add(taskManifest.taskId)
      await saveCheckpoint({
        experimentId: experimentManifest.experimentId,
        experimentManifestHash: experimentManifest.manifestHash,
        benchmarkEligible,
        startedAt,
        updatedAt: new Date().toISOString(),
        completedTaskIds: [...completedTaskIds],
        trajectories,
      })
    } finally {
      if (workspace !== undefined) {
        await cleanupWorkspace(workspace)
        await cleanupBaseline(workspace)
      }
    }
  }

  // Checkpoint/resume validation: verify that reloading the checkpoint
  // produces the same state without duplicate work or data loss.
  if (testCheckpoint) {
    process.stderr.write('\n--- CHECKPOINT/RESUME TEST ---\n')
    const reloaded = await loadCheckpoint()
    if (reloaded === undefined) {
      process.stderr.write('FAIL: checkpoint not found after save\n')
      process.exit(1)
    }
    const reloadedIds = new Set(reloaded.completedTaskIds)
    const reloadedTrajectories = reloaded.trajectories
    let checkpointErrors = 0

    // Same task identities
    if (reloadedIds.size !== completedTaskIds.size) {
      process.stderr.write(`FAIL: task count mismatch (${reloadedIds.size} vs ${completedTaskIds.size})\n`)
      checkpointErrors++
    }
    for (const id of completedTaskIds) {
      if (!reloadedIds.has(id)) {
        process.stderr.write(`FAIL: task ${id} missing from reloaded checkpoint\n`)
        checkpointErrors++
      }
    }

    // Same trajectory count
    if (reloadedTrajectories.length !== trajectories.length) {
      process.stderr.write(`FAIL: trajectory count mismatch (${reloadedTrajectories.length} vs ${trajectories.length})\n`)
      checkpointErrors++
    }

    // Same accumulated cost
    const reloadedCost = reloadedTrajectories.reduce((s, t) => s + t.totalCostUsd, 0)
    const originalCost = trajectories.reduce((s, t) => s + t.totalCostUsd, 0)
    if (Math.abs(reloadedCost - originalCost) > 1e-12) {
      process.stderr.write(`FAIL: cost mismatch ($${reloadedCost.toFixed(12)} vs $${originalCost.toFixed(12)})\n`)
      checkpointErrors++
    }

    // No duplicate task IDs in trajectories
    const trajectoryIds = reloadedTrajectories.map(t => t.taskId)
    const uniqueIds = new Set(trajectoryIds)
    if (uniqueIds.size !== trajectoryIds.length) {
      process.stderr.write(`FAIL: duplicate task IDs in trajectories (${trajectoryIds.length - uniqueIds.size} duplicates)\n`)
      checkpointErrors++
    }

    // Same experiment ID
    if (reloaded.experimentId !== experimentManifest.experimentId) {
      process.stderr.write(`FAIL: experiment ID mismatch (${reloaded.experimentId} vs ${experimentManifest.experimentId})\n`)
      checkpointErrors++
    }

    // Same benchmarkEligible
    if (reloaded.benchmarkEligible !== benchmarkEligible) {
      process.stderr.write(`FAIL: benchmarkEligible mismatch (${reloaded.benchmarkEligible} vs ${benchmarkEligible})\n`)
      checkpointErrors++
    }

    // All trajectories have terminal outcomes
    for (const t of reloadedTrajectories) {
      if (t.terminalOutcome.length === 0) {
        process.stderr.write(`FAIL: task ${t.taskId} missing terminal outcome\n`)
        checkpointErrors++
      }
    }

    if (checkpointErrors === 0) {
      process.stderr.write('PASS: checkpoint/resume integrity verified\n')
      process.stderr.write(`  Tasks: ${reloadedIds.size}\n`)
      process.stderr.write(`  Trajectories: ${reloadedTrajectories.length}\n`)
      process.stderr.write(`  Total cost: $${reloadedCost.toFixed(6)}\n`)
      process.stderr.write('--- END CHECKPOINT/RESUME TEST ---\n')
    } else {
      process.stderr.write(`FAIL: ${checkpointErrors} checkpoint/resume errors\n`)
      process.stderr.write('--- END CHECKPOINT/RESUME TEST ---\n')
      process.exit(1)
    }
  }

  // Compute metrics and failures
  process.stderr.write('\nComputing metrics...\n')
  const metrics = computeMetrics(trajectories)
  await writeFile(METRICS_PATH, JSON.stringify(metrics, null, 2) + '\n', 'utf8')

  const failures = classifyAllFailures(trajectories)
  const failureSummary = failureCategorySummary(failures)
  await writeFile(FAILURES_PATH, JSON.stringify({ failures, summary: failureSummary }, null, 2) + '\n', 'utf8')

  // Generate report
  await generateReport(experimentManifest, trajectories, metrics, failureSummary)

  // Print summary
  process.stderr.write(`\n${'='.repeat(60)}\n`)
  process.stderr.write(`EVALUATION COMPLETE: ${trajectories.length} tasks\n`)
  process.stderr.write(`Verified: ${trajectories.filter(t => t.finalVerified).length}/${trajectories.length}\n`)
  process.stderr.write(`One-shot Flash: ${metrics.oneShotFlashRate * 100 | 0}%\n`)
  process.stderr.write(`Pro escalation: ${metrics.proEscalationRate * 100 | 0}%\n`)
  process.stderr.write(`Mean cost/task: $${metrics.meanCostPerTask.toFixed(6)}\n`)
  process.stderr.write(`P90 latency: ${metrics.latencyP90}ms\n`)
  process.stderr.write(`${'='.repeat(60)}\n`)
}

async function generateReport(
  manifest: ReturnType<typeof buildExperimentManifest>,
  trajectories: TaskTrajectory[],
  metrics: ReturnType<typeof computeMetrics>,
  failureSummary: Record<string, number>,
): Promise<void> {
  const lines: string[] = [
    '# v0.19 Real-Repository Baseline Evaluation',
    '',
    `Experiment ID: ${manifest.experimentId}`,
    `Source commit: ${manifest.sourceCommit.slice(0, 12)}`,
    `Frozen v0.18 tag: ${manifest.frozenV018Tag}`,
    `Manifest hash: ${manifest.manifestHash}`,
    `Benchmark eligible: ${manifest.benchmarkEligible}`,
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Summary',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Tasks | ${metrics.taskCount} |`,
    `| Evaluated tasks | ${metrics.evaluatedTaskCount} |`,
    `| Infra failures | ${metrics.infraFailureCount} |`,
    `| Verified task rate | ${(metrics.verifiedTaskRate * 100).toFixed(1)}% |`,
    `| One-shot Flash rate | ${(metrics.oneShotFlashRate * 100).toFixed(1)}% |`,
    `| Repair rescue rate | ${(metrics.repairRescueRate * 100).toFixed(1)}% |`,
    `| Flash self-repair rate | ${(metrics.flashSelfRepairRate * 100).toFixed(1)}% |`,
    `| Pro escalation rate | ${(metrics.proEscalationRate * 100).toFixed(1)}% |`,
    `| Pro rescue rate | ${(metrics.proRescueRate * 100).toFixed(1)}% |`,
    `| Mean attempts/task | ${metrics.meanAttemptsPerTask.toFixed(2)} |`,
    `| Mean cost/task | $${metrics.meanCostPerTask.toFixed(6)} |`,
    `| Median cost/task | $${metrics.medianCostPerTask.toFixed(6)} |`,
    `| Mean cost/verified | $${metrics.meanCostPerVerifiedTask.toFixed(6)} |`,
    `| Latency P50 | ${metrics.latencyP50}ms |`,
    `| Latency P90 | ${metrics.latencyP90}ms |`,
    `| Latency P95 | ${metrics.latencyP95}ms |`,
    `| Budget stop rate | ${(metrics.budgetStopRate * 100).toFixed(1)}% |`,
    `| Provider failure rate | ${(metrics.providerFailureRate * 100).toFixed(1)}% |`,
    `| Reference-fix file miss rate | ${(metrics.referenceFixFileMissRate * 100).toFixed(1)}% |`,
    `| Reference-fix file inspection rate | ${(metrics.referenceFixFileInspectionRate * 100).toFixed(1)}% |`,
    `| Reference-fix file inspection recall | ${(metrics.referenceFixFileInspectionRecall * 100).toFixed(1)}% |`,
    `| Cache hit % | ${(metrics.cacheHitPercentage * 100).toFixed(1)}% |`,
    `| Flash cost share | ${(metrics.flashCostShare * 100).toFixed(1)}% |`,
    `| Pro cost share | ${(metrics.proCostShare * 100).toFixed(1)}% |`,
    '',
    '## Category breakdown',
    '',
    '| Category | N | Verified | One-shot | Flash repair | Pro rescue | Failed | Mean cost | Mean latency |',
    '|----------|---|----------|----------|--------------|------------|--------|-----------|--------------|',
    ...metrics.categoryBreakdown.map(c =>
      `| ${c.category} | ${c.count} | ${c.verified} | ${c.oneShotFlash} | ${c.flashRepair} | ${c.proRescue} | ${c.failed} | $${c.meanCost.toFixed(6)} | ${c.meanLatency.toFixed(0)}ms |`,
    ),
    '',
    '## Failure taxonomy',
    '',
    '| Category | Count |',
    '|----------|-------|',
    ...Object.entries(failureSummary).sort().map(([cat, count]) =>
      `| ${cat} | ${count} |`,
    ),
    '',
    '## Control-plane integrity',
    '',
    '| Invariant | Count |',
    '|-----------|-------|',
    `| Provider failures | ${trajectories.filter(t => t.aborted && t.abortReason !== undefined).length} |`,
    `| Control-plane failures | ${trajectories.filter(t => t.controlPlaneStatus === 'FAIL').length} |`,
    `| Budget stops | ${trajectories.filter(t => t.terminalOutcome === 'budget-stop').length} |`,
    `| Rollbacks | ${trajectories.filter(t => t.rollbackUsed).length} |`,
    '',
    '## Policy freeze',
    '',
    'The v0.18.0 repair controller policy was frozen for this entire cohort:',
    `- maxFlashAttempts: ${FROZEN_V018_LIMITS.maxFlashAttempts}`,
    `- maxProAttempts: ${FROZEN_V018_LIMITS.maxProAttempts}`,
    `- maxTotalAttempts: ${FROZEN_V018_LIMITS.maxTotalAttempts}`,
    '',
    'No threshold tuning, limit changes, or policy modifications were made during collection.',
  ]
  await writeFile(REPORT_PATH, lines.join('\n') + '\n', 'utf8')
  process.stderr.write(`Report written to ${REPORT_PATH}\n`)
}

void main()
