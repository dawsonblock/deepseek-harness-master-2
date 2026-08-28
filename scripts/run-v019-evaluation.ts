#!/usr/bin/env node
/**
 * v0.19 real-repository evaluation runner.
 *
 * Runs the frozen v0.18.0 repair controller policy against real coding tasks
 * from multiple open-source repositories. Captures full trajectory data,
 * computes pre-registered metrics, and classifies failures.
 *
 * Self-skips without DEEPSEEK_API_KEY.
 *
 * Usage:
 *   npx tsx scripts/run-v019-evaluation.ts [--max-tasks N] [--checkpoint]
 *
 * @module v019-evaluation-runner
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildExperimentManifest,
} from './v019-experiment-identity.ts'
import {
  FROZEN_V018_LIMITS,
} from './v019-task-manifest.ts'
import {
  checkoutRepo,
  cleanupWorkspace,
  computeRepoMetadata,
  installDependencies,
} from './v019-repo-checkout.ts'
import {
  type TaskTrajectory,
  runTaskTrajectory,
} from './v019-trajectory-collector.ts'
import { computeMetrics } from './v019-metrics.ts'
import {
  classifyAllFailures,
  failureCategorySummary,
} from './v019-failure-taxonomy.ts'
import { SANDBOX_QUALIFICATION_ID } from './v018-sandbox-qualification.ts'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const EVAL_DIR = join(REPO_ROOT, 'artifacts', 'evals', 'v019-real-repo-baseline-v1')
const CHECKPOINT_PATH = join(EVAL_DIR, 'checkpoint.json')
const METRICS_PATH = join(EVAL_DIR, 'metrics.json')
const FAILURES_PATH = join(EVAL_DIR, 'failures.json')
const TRAJECTORIES_DIR = join(EVAL_DIR, 'trajectories')
const MANIFEST_PATH = join(EVAL_DIR, 'manifest.json')
const REPORT_PATH = join(EVAL_DIR, 'README.md')

// ---------------------------------------------------------------------------
// Task corpus: real-repository tasks
// ---------------------------------------------------------------------------

import { TASK_CORPUS } from './v019-task-corpus.ts'

// ---------------------------------------------------------------------------
// Checkpoint management
// ---------------------------------------------------------------------------

interface Checkpoint {
  experimentId: string
  startedAt: string
  updatedAt: string
  completedTaskIds: string[]
  trajectories: TaskTrajectory[]
}

async function loadCheckpoint(): Promise<Checkpoint | undefined> {
  try {
    const content = await readFile(CHECKPOINT_PATH, 'utf8')
    return JSON.parse(content) as Checkpoint
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

  if (process.env.DEEPSEEK_API_KEY === undefined || process.env.DEEPSEEK_API_KEY === '') {
    process.stderr.write('DEEPSEEK_API_KEY is not set; skipping v0.19 real-repository evaluation.\n')
    process.stderr.write('Provide a key to run the evaluation cohort.\n')
    return
  }

  process.stderr.write('\nv0.19 Real-Repository Evaluation\n')
  process.stderr.write(`${'='.repeat(60)}\n`)

  // Build and verify experiment manifest
  const experimentManifest = buildExperimentManifest({
    repairControllerVersion: '0.18.0',
    repairRuntimeVersion: '0.18.0',
    eventSchemaVersion: 0,
    pricingVersion: '2026-08-25',
    sandboxPolicyVersion: 'v1',
    sandboxQualificationId: SANDBOX_QUALIFICATION_ID,
    taskCorpusVersion: 'v1',
    taskCount: Math.min(TASK_CORPUS.length, maxTasks),
    repositoryCount: new Set(TASK_CORPUS.slice(0, maxTasks).map(t => t.repository.name)).size,
  })

  process.stderr.write(`Experiment ID: ${experimentManifest.experimentId}\n`)
  process.stderr.write(`Source commit: ${experimentManifest.sourceCommit.slice(0, 12)}\n`)
  process.stderr.write(`Frozen v0.18 tag: ${experimentManifest.frozenV018Tag}\n`)
  process.stderr.write(`Manifest hash: ${experimentManifest.manifestHash}\n`)
  process.stderr.write(`Tasks: ${experimentManifest.taskCount}\n`)
  process.stderr.write(`Repositories: ${experimentManifest.repositoryCount}\n\n`)

  // Save experiment manifest
  await mkdir(EVAL_DIR, { recursive: true })
  await writeFile(MANIFEST_PATH, JSON.stringify(experimentManifest, null, 2) + '\n', 'utf8')
  await mkdir(TRAJECTORIES_DIR, { recursive: true })

  // Load checkpoint for resumption
  const checkpoint = await loadCheckpoint()
  const completedTaskIds = new Set(checkpoint?.completedTaskIds ?? [])
  const trajectories: TaskTrajectory[] = checkpoint?.trajectories ?? []

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
    try {
      // Checkout repository at base commit
      process.stderr.write('  Checking out repository...\n')
      workspace = await checkoutRepo(
        taskManifest.repository.url,
        taskManifest.repository.baseCommit,
        taskManifest.repository.name,
      )

      // Install dependencies
      process.stderr.write('  Installing dependencies...\n')
      await installDependencies(workspace)

      // Compute repo metadata
      const repoMetadata = computeRepoMetadata(workspace, {
        name: taskManifest.repository.name,
        url: taskManifest.repository.url,
        baseCommit: taskManifest.repository.baseCommit,
        size: taskManifest.repoSize,
      })
      process.stderr.write(`  Repo: ${repoMetadata.loc} LOC, ${repoMetadata.fileCount} files, ${repoMetadata.testCount} tests\n`)

      // Run the task trajectory
      process.stderr.write('  Running repair loop...\n')
      const trajectory = await runTaskTrajectory(taskManifest, workspace, experimentManifest.experimentId, repoMetadata)

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

      // Checkpoint after each task
      await saveCheckpoint({
        experimentId: experimentManifest.experimentId,
        startedAt: checkpoint?.startedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedTaskIds: [...completedTaskIds],
        trajectories,
      })
    } catch (error: unknown) {
      process.stderr.write(`  ERROR: ${error instanceof Error ? error.message : String(error)}\n`)
      // Record as aborted trajectory
      const failedTrajectory: TaskTrajectory = {
        taskId: taskManifest.taskId,
        taskManifestHash: taskManifest.manifestHash,
        experimentId: experimentManifest.experimentId,
        repository: {
          name: taskManifest.repository.name,
          url: taskManifest.repository.url,
          baseCommit: taskManifest.repository.baseCommit,
          size: taskManifest.repoSize,
          loc: 0, fileCount: 0, packageCount: 0, testCount: 0,
        },
        category: taskManifest.category,
        taskDescription: taskManifest.task.description,
        controlPlaneStatus: 'FAIL',
        modelCapabilityStatus: 'FAIL',
        finalVerified: false,
        holdoutPass: undefined,
        verificationStrength: taskManifest.verification.strength,
        flashAttempts: 0,
        proAttempts: 0,
        escalatedToPro: false,
        totalCostUsd: 0,
        totalLatencyMs: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheMissTokens: 0,
        attempts: [],
        changedFiles: [],
        rollbackUsed: false,
        aborted: true,
        abortReason: 'evaluation-error',
        terminalOutcome: 'evaluation-error',
        failureCategory: undefined,
        timestamp: new Date().toISOString(),
      }
      trajectories.push(failedTrajectory)
      completedTaskIds.add(taskManifest.taskId)
      await saveCheckpoint({
        experimentId: experimentManifest.experimentId,
        startedAt: checkpoint?.startedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedTaskIds: [...completedTaskIds],
        trajectories,
      })
    } finally {
      if (workspace !== undefined) {
        await cleanupWorkspace(workspace)
      }
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
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Summary',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Tasks | ${metrics.taskCount} |`,
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
