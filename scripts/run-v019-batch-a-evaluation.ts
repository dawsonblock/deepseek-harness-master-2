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
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ACCOUNTING_VERSION,
  buildExperimentManifest,
  computeCorpusManifestHash,
} from './v019-experiment-identity.ts'
import {
  checkoutRepo,
  cleanupWorkspace,
  cleanupBaseline,
  computeRepoMetadata,
  freezeBaseline,
  installDependencies,
  type RepoCheckout,
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
import { SECURITY_QUALIFICATION_ID, runSecurityQualification } from './v019-security-qualification.ts'
import { generateFreezeRecord, verifyVerifierIntegrity, FREEZE_ID, readFreezeRecord, writeFreezeRecord } from './v019-freeze-secure-eval.ts'
import { COMPOSED_QUALIFICATION_ID, runComposedRuntimeQualification, writeComposedQualificationRecord, computeQualificationSemanticHash } from './v019-composed-runtime-qualification.ts'
import { BATCH_A_CORPUS } from './v019-batch-a-corpus.ts'
import { getReferenceFixFiles } from './v019-corpus-qualification.ts'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const DEFAULT_EVAL_DIR = join(REPO_ROOT, 'artifacts', 'evals', 'v019-synthetic-multirepo-validation-v4')
let EVAL_DIR = DEFAULT_EVAL_DIR
let CHECKPOINT_PATH = join(EVAL_DIR, 'checkpoint.json')
let METRICS_PATH = join(EVAL_DIR, 'metrics.json')
let FAILURES_PATH = join(EVAL_DIR, 'failures.json')
let TRAJECTORIES_DIR = join(EVAL_DIR, 'trajectories')
let MANIFEST_PATH = join(EVAL_DIR, 'manifest.json')
let REPORT_PATH = join(EVAL_DIR, 'README.md')

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

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const maxTasksIdx = args.indexOf('--max-tasks')
  const maxTasks = maxTasksIdx >= 0 ? parseInt(args[maxTasksIdx + 1] ?? '25', 10) : 25
  const skipSecurityGate = args.includes('--skip-security-gate')
  const taskFilterIdx = args.indexOf('--task-filter')
  const taskFilter = taskFilterIdx >= 0 ? (args[taskFilterIdx + 1] ?? '').split(',').map(s => s.trim()).filter(s => s.length > 0) : []
  const outputDirIdx = args.indexOf('--output-dir')
  const outputDir = outputDirIdx >= 0 ? args[outputDirIdx + 1] : undefined
  if (outputDir !== undefined && outputDir.length > 0) {
    EVAL_DIR = outputDir
    CHECKPOINT_PATH = join(EVAL_DIR, 'checkpoint.json')
    METRICS_PATH = join(EVAL_DIR, 'metrics.json')
    FAILURES_PATH = join(EVAL_DIR, 'failures.json')
    TRAJECTORIES_DIR = join(EVAL_DIR, 'trajectories')
    MANIFEST_PATH = join(EVAL_DIR, 'manifest.json')
    REPORT_PATH = join(EVAL_DIR, 'README.md')
  }

  if (process.env.DEEPSEEK_API_KEY === undefined || process.env.DEEPSEEK_API_KEY === '') {
    process.stderr.write('DEEPSEEK_API_KEY is not set; skipping Batch A evaluation.\n')
    return
  }

  process.stderr.write('\nv0.19 Synthetic Multi-Repository Validation\n')
  process.stderr.write(`${'='.repeat(60)}\n`)
  process.stderr.write('MODE: Synthetic Multi-Repo Validation (benchmark-eligible, no controller tuning)\n')

  // Enforce the secure-eval freeze gate before any provider execution.
  // The security qualification must pass and the freeze record must be ready.
  const securityRecord = await runSecurityQualification()
  if (!securityRecord.passed) {
    if (skipSecurityGate) {
      process.stderr.write(`\nWARNING: SECURITY QUALIFICATION FAILED (${securityRecord.failedCount} properties), but --skip-security-gate was passed.\n`)
      for (const check of securityRecord.checks) {
        if (check.status === 'fail') {
          process.stderr.write(`  [FAIL] ${check.id}: ${check.name} — ${check.evidence}\n`)
        }
      }
      process.stderr.write('Results from this run are NOT benchmark-eligible due to incomplete sandbox enforcement.\n\n')
    } else {
      process.stderr.write(`\nSECURITY QUALIFICATION FAILED: ${securityRecord.failedCount} properties failed\n`)
      for (const check of securityRecord.checks) {
        if (check.status === 'fail') {
          process.stderr.write(`  [FAIL] ${check.id}: ${check.name} — ${check.evidence}\n`)
        }
      }
      process.stderr.write('\nCannot proceed to live evaluation. Fix the security qualification first.\n')
      process.exit(1)
    }
  }

  // Check for a persisted freeze record. If one exists, validate the current
  // source against it. If not, generate and persist a new one. The persisted
  // record binds the evaluation to a previously qualified source state rather
  // than a hash generated and immediately verified in the same process run.
  const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
  const persistedFreeze = readFreezeRecord(REPO_ROOT)
  let freezeRecord
  if (persistedFreeze !== undefined) {
    // Validate current source against the persisted freeze hash
    if (!verifyVerifierIntegrity(persistedFreeze.verifierIntegrityHash)) {
      if (skipSecurityGate) {
        process.stderr.write('\nWARNING: VERIFIER INTEGRITY CHECK FAILED, but --skip-security-gate was passed.\n')
        process.stderr.write('Results from this run are NOT benchmark-eligible.\n')
      } else {
        process.stderr.write('\nVERIFIER INTEGRITY CHECK FAILED: verifier-controlled files have changed since the persisted freeze.\n')
        process.stderr.write('Cannot proceed to live evaluation. Re-qualify or restore the frozen verifier files.\n')
        process.exit(1)
      }
    }
    freezeRecord = persistedFreeze
    process.stderr.write(`Secure eval freeze: ${FREEZE_ID} (persisted, verified against current source)\n`)
  } else {
    // No persisted freeze — generate, verify, and persist
    freezeRecord = await generateFreezeRecord()
    if (!freezeRecord.ready) {
      if (skipSecurityGate) {
        process.stderr.write(`\nWARNING: SECURE EVAL FREEZE NOT READY: ${FREEZE_ID}, but --skip-security-gate was passed.\n`)
        if (!freezeRecord.backendFullEnforcement) {
          process.stderr.write(`  Backend enforcement is '${freezeRecord.effectiveComposition.backendEnforcement}', not 'full'.\n`)
        }
        process.stderr.write('Results from this run are NOT benchmark-eligible.\n\n')
      } else {
        process.stderr.write(`\nSECURE EVAL FREEZE NOT READY: ${FREEZE_ID}\n`)
        if (!freezeRecord.backendFullEnforcement) {
          process.stderr.write(`  Backend enforcement is '${freezeRecord.effectiveComposition.backendEnforcement}', not 'full'.\n`)
          process.stderr.write('  Benchmark-eligible runs require full backend enforcement.\n')
        }
        process.stderr.write('Cannot proceed to live evaluation. Fix the freeze record first.\n')
        process.exit(1)
      }
    }
    writeFreezeRecord(freezeRecord, REPO_ROOT)
    process.stderr.write(`Secure eval freeze: ${FREEZE_ID} (newly generated and persisted)\n`)
  }

  // Verify verifier-controlled files match the freeze hash.
  if (!verifyVerifierIntegrity(freezeRecord.verifierIntegrityHash)) {
    if (skipSecurityGate) {
      process.stderr.write('\nWARNING: VERIFIER INTEGRITY CHECK FAILED, but --skip-security-gate was passed.\n')
      process.stderr.write('Results from this run are NOT benchmark-eligible.\n')
    } else {
      process.stderr.write('\nVERIFIER INTEGRITY CHECK FAILED: verifier-controlled files have been modified since freeze.\n')
      process.stderr.write('Cannot proceed to live evaluation. Re-qualify or restore the frozen verifier files.\n')
      process.exit(1)
    }
  }
  process.stderr.write('Verifier integrity: verified\n')
  process.stderr.write(`Security qualification: ${SECURITY_QUALIFICATION_ID} (${securityRecord.passedCount} properties passed)\n`)

  // Enforce the composed-runtime qualification gate on every launch.
  // The backend probe is environment-dependent (sandbox runner, network
  // isolation), so reusing a persisted record across launches is unsafe.
  // The persisted record is kept as audit evidence but never as a
  // permission token — every paid run must re-prove the composition.
  const composedRecord = await runComposedRuntimeQualification()
  if (!composedRecord.ready) {
    process.stderr.write(`\nCOMPOSED RUNTIME QUALIFICATION FAILED: ${COMPOSED_QUALIFICATION_ID}\n`)
    for (const check of composedRecord.checks) {
      if (check.status === 'fail') {
        process.stderr.write(`  [FAIL] ${check.id}: ${check.name} — ${check.evidence}\n`)
      }
    }
    process.stderr.write('Cannot proceed to live evaluation. Fix the composed runtime qualification first.\n')
    process.exit(1)
  }
  writeComposedQualificationRecord(composedRecord)
  process.stderr.write(`Composed runtime qualification: ${COMPOSED_QUALIFICATION_ID} (${composedRecord.passedCount} checks passed, persisted)\n`)

  // Require full enforcement for benchmark tasks. Partial backends
  // (e.g. Landlock without network isolation) are acceptable for product
  // operation but not for benchmark-eligible evaluation.
  if (composedRecord.backend.enforcement !== 'full') {
    if (skipSecurityGate) {
      process.stderr.write(`\nWARNING: BACKEND ENFORCEMENT INSUFFICIENT: ${composedRecord.backend.enforcement} (required: full)\n`)
      process.stderr.write('Results from this run are NOT benchmark-eligible due to incomplete sandbox enforcement.\n\n')
    } else {
      process.stderr.write(`\nBACKEND ENFORCEMENT INSUFFICIENT: ${composedRecord.backend.enforcement} (required: full)\n`)
      process.stderr.write('Benchmark-eligible tasks require full sandbox enforcement with network isolation.\n')
      process.exit(1)
    }
  }
  if (!composedRecord.backend.networkDenied) {
    if (skipSecurityGate) {
      process.stderr.write('\nWARNING: BACKEND NETWORK ISOLATION FAILED: network access not denied\n')
      process.stderr.write('Results from this run are NOT benchmark-eligible due to incomplete network isolation.\n\n')
    } else {
      process.stderr.write('\nBACKEND NETWORK ISOLATION FAILED: network access not denied\n')
      process.stderr.write('Benchmark-eligible tasks require network isolation.\n')
      process.exit(1)
    }
  }
  process.stderr.write(`Backend enforcement: ${composedRecord.backend.enforcement}, network denied: ${composedRecord.backend.networkDenied}\n`)
  process.stderr.write('\n')

  const allTasks = BATCH_A_CORPUS.slice(0, maxTasks)
  const tasks = taskFilter.length > 0
    ? allTasks.filter(t => taskFilter.some(f => t.taskId.includes(f)))
    : allTasks
  // Security-gate bypass forces benchmark ineligibility. The invariant
  // skipSecurityGate => !benchmarkEligible prevents exploratory runs from
  // being mistaken for qualified evidence.
  const benchmarkEligible = !skipSecurityGate
  if (skipSecurityGate) {
    process.stderr.write('Run class: exploratory (benchmarkEligible=false, security gate bypassed)\n')
  }

  const experimentManifest = buildExperimentManifest({
    repairControllerVersion: '0.18.0',
    repairRuntimeVersion: '0.18.0',
    eventSchemaVersion: 0,
    pricingVersion: '2026-08-25',
    sandboxPolicyVersion: 'v1',
    sandboxQualificationId: SECURITY_QUALIFICATION_ID,
    taskCorpusVersion: 'v019-synthetic-multirepo-v4',
    corpusManifestHash: computeCorpusManifestHash(tasks),
    taskCount: tasks.length,
    repositoryCount: new Set(tasks.map(t => t.repository.name)).size,
    benchmarkEligible,
    securityGateBypassed: skipSecurityGate,
    repairStrategy: 'transactional',
    accountingVersion: ACCOUNTING_VERSION,
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
  } else if (checkpoint !== undefined && checkpoint.experimentManifestHash !== experimentManifest.manifestHash) {
    process.stderr.write(
      'WARNING: checkpoint experiment manifest hash differs. Starting fresh.\n',
    )
  }
  const checkpointValid = checkpoint !== undefined
    && checkpoint.experimentId === experimentManifest.experimentId
    && checkpoint.experimentManifestHash === experimentManifest.manifestHash
  const completedTaskIds = new Set(
    checkpointValid
      ? checkpoint.completedTaskIds
      : [],
  )
  const trajectories: TaskTrajectory[] =
    checkpointValid
      ? checkpoint.trajectories
      : []
  // Preserve startedAt only from a valid checkpoint. An invalid checkpoint
  // represents a different experiment; inheriting its startedAt would make
  // the audit record inaccurate.
  const startedAt = checkpointValid ? checkpoint.startedAt : new Date().toISOString()

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
      taskState = 'CHECKOUT'
      process.stderr.write('  [CHECKOUT] Checking out repository...\n')
      checkout = await checkoutRepo(
        taskManifest.repository.url,
        taskManifest.repository.baseCommit,
        taskManifest.repository.name,
      )
      workspace = checkout.workspace

      taskState = 'SETUP'
      process.stderr.write('  [SETUP] Installing dependencies...\n')
      await installDependencies(workspace)

      // Freeze the exact post-setup baseline B0. Every repair attempt
      // restores from this snapshot, not a reconstruction from git archive
      // plus preserved directories. The hash verifies exact restoration.
      process.stderr.write('  [SETUP] Freezing baseline snapshot...\n')
      const baseline = freezeBaseline(workspace)

      const repoMetadata = computeRepoMetadata(workspace, {
        name: taskManifest.repository.name,
        url: taskManifest.repository.url,
        baseCommit: taskManifest.repository.baseCommit,
        size: taskManifest.repoSize,
      })
      process.stderr.write(`  Repo: ${repoMetadata.loc} LOC, ${repoMetadata.fileCount} files, ${repoMetadata.testCount} tests\n`)

      const referenceFixFiles = taskManifest.repository.referenceFixCommit !== undefined
        ? getReferenceFixFiles(checkout.cloneDir, taskManifest.repository.referenceFixCommit)
        : []

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
