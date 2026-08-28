#!/usr/bin/env node
/**
 * v0.19 Batch A live evaluation runner.
 *
 * Runs the frozen v0.18.0 repair controller policy against all 25 FROZEN
 * Batch A tasks. Captures full trajectory data, computes pre-registered
 * metrics, and classifies failures.
 *
 * Self-skips without DEEPSEEK_API_KEY.
 *
 * Usage:
 *   npx tsx scripts/run-v019-batch-a-evaluation.ts [--max-tasks N]
 *
 * @module v019-batch-a-evaluation-runner
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildExperimentManifest,
} from './v019-experiment-identity.ts'
import {
  checkoutRepo,
  cleanupWorkspace,
  computeRepoMetadata,
  installDependencies,
} from './v019-repo-checkout.ts'
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
import { BATCH_A_CORPUS } from './v019-batch-a-corpus.ts'
import { getReferenceFixFiles } from './v019-corpus-qualification.ts'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const EVAL_DIR = join(REPO_ROOT, 'artifacts', 'evals', 'v019-batch-a-baseline-v1')
const CHECKPOINT_PATH = join(EVAL_DIR, 'checkpoint.json')
const METRICS_PATH = join(EVAL_DIR, 'metrics.json')
const FAILURES_PATH = join(EVAL_DIR, 'failures.json')
const TRAJECTORIES_DIR = join(EVAL_DIR, 'trajectories')
const MANIFEST_PATH = join(EVAL_DIR, 'manifest.json')
const REPORT_PATH = join(EVAL_DIR, 'README.md')

interface Checkpoint {
  experimentId: string
  benchmarkEligible: boolean
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

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const maxTasksIdx = args.indexOf('--max-tasks')
  const maxTasks = maxTasksIdx >= 0 ? parseInt(args[maxTasksIdx + 1] ?? '25', 10) : 25

  if (process.env.DEEPSEEK_API_KEY === undefined || process.env.DEEPSEEK_API_KEY === '') {
    process.stderr.write('DEEPSEEK_API_KEY is not set; skipping Batch A evaluation.\n')
    return
  }

  process.stderr.write('\nv0.19 Batch A Live Evaluation\n')
  process.stderr.write(`${'='.repeat(60)}\n`)
  process.stderr.write('MODE: Batch A Baseline (benchmark-eligible, no controller tuning)\n')

  const tasks = BATCH_A_CORPUS.slice(0, maxTasks)
  const benchmarkEligible = true

  const experimentManifest = buildExperimentManifest({
    repairControllerVersion: '0.18.0',
    repairRuntimeVersion: '0.18.0',
    eventSchemaVersion: 0,
    pricingVersion: '2026-08-25',
    sandboxPolicyVersion: 'v1',
    sandboxQualificationId: SANDBOX_QUALIFICATION_ID,
    taskCorpusVersion: 'v019-batch-a-v1',
    taskCount: tasks.length,
    repositoryCount: new Set(tasks.map(t => t.repository.name)).size,
    benchmarkEligible,
  })

  process.stderr.write(`Experiment ID: ${experimentManifest.experimentId}\n`)
  process.stderr.write(`Source commit: ${experimentManifest.sourceCommit.slice(0, 12)}\n`)
  process.stderr.write(`Frozen v0.18 tag: ${experimentManifest.frozenV018Tag}\n`)
  process.stderr.write(`Manifest hash: ${experimentManifest.manifestHash}\n`)
  process.stderr.write(`Tasks: ${experimentManifest.taskCount}\n`)
  process.stderr.write(`Repositories: ${experimentManifest.repositoryCount}\n\n`)

  await mkdir(EVAL_DIR, { recursive: true })
  await writeFile(MANIFEST_PATH, JSON.stringify(experimentManifest, null, 2) + '\n', 'utf8')
  await mkdir(TRAJECTORIES_DIR, { recursive: true })

  const checkpoint = await loadCheckpoint()
  if (checkpoint !== undefined && checkpoint.experimentId !== experimentManifest.experimentId) {
    process.stderr.write(
      'WARNING: checkpoint experiment ID differs. Starting fresh.\n',
    )
  }
  const completedTaskIds = new Set(
    checkpoint?.experimentId === experimentManifest.experimentId
      ? checkpoint.completedTaskIds
      : [],
  )
  const trajectories: TaskTrajectory[] =
    checkpoint?.experimentId === experimentManifest.experimentId
      ? checkpoint.trajectories
      : []

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
    let taskState: TaskState = 'PENDING'
    try {
      taskState = 'CHECKOUT'
      process.stderr.write('  [CHECKOUT] Checking out repository...\n')
      workspace = await checkoutRepo(
        taskManifest.repository.url,
        taskManifest.repository.baseCommit,
        taskManifest.repository.name,
      )

      taskState = 'SETUP'
      process.stderr.write('  [SETUP] Installing dependencies...\n')
      await installDependencies(workspace)

      const repoMetadata = computeRepoMetadata(workspace, {
        name: taskManifest.repository.name,
        url: taskManifest.repository.url,
        baseCommit: taskManifest.repository.baseCommit,
        size: taskManifest.repoSize,
      })
      process.stderr.write(`  Repo: ${repoMetadata.loc} LOC, ${repoMetadata.fileCount} files, ${repoMetadata.testCount} tests\n`)

      const referenceFixFiles = taskManifest.repository.referenceFixCommit !== undefined
        ? getReferenceFixFiles(workspace, taskManifest.repository.referenceFixCommit)
        : []

      taskState = 'RUNNING'
      process.stderr.write('  [RUNNING] Running repair loop...\n')
      const trajectory = await runTaskTrajectory(
        taskManifest,
        workspace,
        experimentManifest.experimentId,
        benchmarkEligible,
        repoMetadata,
        referenceFixFiles,
      )

      const trajectoryPath = join(TRAJECTORIES_DIR, `${taskManifest.taskId}.json`)
      await writeFile(trajectoryPath, JSON.stringify(trajectory, null, 2) + '\n', 'utf8')
      trajectories.push(trajectory)
      completedTaskIds.add(taskManifest.taskId)

      process.stderr.write(`  Result: ${trajectory.finalVerified ? 'VERIFIED' : 'FAILED'}\n`)
      process.stderr.write(`  Attempts: ${trajectory.attempts.length} (Flash=${trajectory.flashAttempts}, Pro=${trajectory.proAttempts})\n`)
      process.stderr.write(`  Cost: $${trajectory.totalCostUsd.toFixed(6)}\n`)
      process.stderr.write(`  Latency: ${trajectory.totalLatencyMs}ms\n`)
      process.stderr.write(`  Terminal: ${trajectory.terminalOutcome}\n`)

      await saveCheckpoint({
        experimentId: experimentManifest.experimentId,
        benchmarkEligible,
        startedAt: checkpoint?.startedAt ?? new Date().toISOString(),
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
        benchmarkEligible,
        undefined,
        `${taskState}: ${errorMsg}`,
      )
      trajectories.push(failedTrajectory)
      completedTaskIds.add(taskManifest.taskId)
      await saveCheckpoint({
        experimentId: experimentManifest.experimentId,
        benchmarkEligible,
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

  process.stderr.write('\nComputing metrics...\n')
  const metrics = computeMetrics(trajectories)
  await writeFile(METRICS_PATH, JSON.stringify(metrics, null, 2) + '\n', 'utf8')

  const failures = classifyAllFailures(trajectories)
  const failureSummary = failureCategorySummary(failures)
  await writeFile(FAILURES_PATH, JSON.stringify({ failures, summary: failureSummary }, null, 2) + '\n', 'utf8')

  await generateReport(experimentManifest, trajectories, metrics, failureSummary)

  process.stderr.write(`\n${'='.repeat(60)}\n`)
  process.stderr.write(`BATCH A EVALUATION COMPLETE: ${trajectories.length} tasks\n`)
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
    '# v0.19 Batch A Baseline Evaluation',
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
    '## Failure Classification',
    '',
    '| Category | Count |',
    '|----------|-------|',
    ...Object.entries(failureSummary).map(([cat, count]) => `| ${cat} | ${count} |`),
    '',
    '## Per-Task Results',
    '',
    '| Task ID | Category | Verified | Attempts | Cost | Terminal |',
    '|---------|----------|----------|----------|------|----------|',
    ...trajectories.map(t =>
      `| ${t.taskId} | ${t.category} | ${t.finalVerified ? 'YES' : 'NO'} | ${t.attempts.length} | $${t.totalCostUsd.toFixed(6)} | ${t.terminalOutcome} |`,
    ),
    '',
  ]

  await writeFile(REPORT_PATH, lines.join('\n') + '\n', 'utf8')
}

main().catch((error) => {
  process.stderr.write(`Fatal error: ${String(error)}\n`)
  process.exit(1)
})
