/**
 * Extracted repair loop for v0.18 qualification. Both the live qualification
 * runner and the zero-cost fake-provider tests use this module. The loop
 * accepts an injectable `decide` function (defaulting to the production
 * `decideRepair`) so tests can prove the runner actually consumes the
 * production controller rather than a copy/pasted policy.
 *
 * @module v018-repair-loop
 */

import {
  type FailurePackage,
  type ModelRef,
  type ProviderFailure,
  type RepairAttempt,
  type RepairDecision,
  type RepairLimits,
  DEFAULT_REPAIR_LIMITS,
  classifyProgress,
  classifyProviderFailure,
  computeFailureFingerprint,
  decideRepair,
} from '@deepseek-ai/dsh-repair-controller'

/** A single model turn result from either a real or fake provider. */
export interface TurnResult {
  output: string
  costUsd: number
  latencyMs: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheMissTokens: number
  routingDecisionId: string
}

/** Verification result for one attempt. */
export interface VerifyResult {
  passed: boolean
  diagnosticPass: boolean
  holdoutPass: boolean | undefined
  evidence: FailurePackage
}

/** Injectable decide function — defaults to the production controller. */
export type RepairDecideFn = typeof decideRepair

/** Injectable turn runner — real provider or fake. */
export type TurnRunnerFn = (
  task: string,
  model: ModelRef,
  workspace: string,
) => Promise<TurnResult>

/** Injectable verifier — runs diagnostic and holdout checks. */
export type VerifierFn = (
  workspace: string,
  model: ModelRef,
) => Promise<VerifyResult>

/** One attempt's record in the qualification trajectory. */
export interface LoopAttempt {
  attempt: number
  model: string
  routingDecisionId: string
  verified: boolean
  diagnosticPass: boolean
  holdoutPass: boolean | undefined
  failureFingerprint: string | undefined
  progress?: 'none' | 'partial' | 'regression' | 'resolved' | undefined
  costUsd: number
  latencyMs: number
  cacheReadTokens: number
  cacheMissTokens: number
  outputTokens: number
  inputTokens: number
  reasoningTokens: number
  totalTokens: number
  repairAction: RepairDecision['action']
  repairReason?: string | undefined
  providerFailure: ProviderFailure | undefined
}

/** One fixture's full repair-loop result. */
export interface LoopResult {
  taskId: string
  attempts: LoopAttempt[]
  finalVerified: boolean
  holdoutPass: boolean
  flashAttempts: number
  proAttempts: number
  totalCostUsd: number
  totalLatencyMs: number
  failureFingerprints: string[]
  progressHistory: string[]
  escalatedToPro: boolean
  aborted: boolean
  abortReason: ProviderFailure | undefined
}

/** Options for {@link runRepairLoop}. */
export interface RepairLoopOptions {
  taskId: string
  workspace: string
  initialTask: string
  flashModel: ModelRef
  proModel: ModelRef
  runTurn: TurnRunnerFn
  verify: VerifierFn
  limits?: RepairLimits
  decide?: RepairDecideFn
}

/** Construct a repair prompt from failure evidence. */
export function constructRepairPrompt(
  failure: FailurePackage,
  attempt: number,
): string {
  const lines: string[] = [
    `Repair attempt ${attempt}: the previous attempt failed verification.`,
    '',
    'Failed criteria:',
    ...failure.failedCriteria.map(c => `- ${c}`),
    '',
    'Failing tests:',
    ...failure.failingTests.map(t => `- ${t}`),
    '',
    'Type errors:',
    ...failure.typeErrors.map(e => `- ${e}`),
    '',
    'Build errors:',
    ...failure.buildErrors.map(e => `- ${e}`),
    '',
    'Fix the issues above. The workspace state from the previous attempt is preserved.',
  ]
  return lines.join('\n')
}

/** Construct a Pro escalation prompt. */
export function constructProEscalationPrompt(
  failure: FailurePackage,
  flashAttempts: number,
): string {
  const lines: string[] = [
    `Escalation from Flash after ${flashAttempts} failed attempt(s).`,
    'You are taking over a task that Flash could not complete.',
    'The workspace state from the previous attempts is preserved.',
    '',
    'Failed criteria:',
    ...failure.failedCriteria.map(c => `- ${c}`),
    '',
    'Failing tests:',
    ...failure.failingTests.map(t => `- ${t}`),
    '',
    'Type errors:',
    ...failure.typeErrors.map(e => `- ${e}`),
    '',
    'Build errors:',
    ...failure.buildErrors.map(e => `- ${e}`),
    '',
    'Repair the work. You may rewrite the previous attempts\' changes or start fresh.',
  ]
  return lines.join('\n')
}

/**
 * Run the v0.18 repair loop for one fixture. Calls the injectable `decide`
 * function (defaulting to the production `decideRepair`) after each
 * verification. Calls the injectable `runTurn` function for each model
 * attempt. Calls the injectable `verify` function for diagnostic and
 * holdout verification.
 *
 * Provider failures that are not retryable abort the loop immediately
 * with an {@link ProviderFailure} record. Retryable failures are surfaced
 * but do not abort (the caller handles retry/checkpoint).
 *
 * @param options - repair loop configuration with injectable dependencies.
 * @returns the full repair trajectory for one fixture.
 */
export async function runRepairLoop(options: RepairLoopOptions): Promise<LoopResult> {
  const {
    taskId,
    workspace,
    initialTask,
    flashModel,
    proModel,
    runTurn,
    verify,
    limits = DEFAULT_REPAIR_LIMITS,
    decide = decideRepair,
  } = options

  const attempts: LoopAttempt[] = []
  const repairAttempts: RepairAttempt[] = []
  let flashAttempts = 0
  let proAttempts = 0
  let totalCostUsd = 0
  let totalLatencyMs = 0
  let totalOutputTokens = 0
  const failureFingerprints: string[] = []
  const progressHistory: string[] = []
  let priorFailure: FailurePackage | undefined
  let aborted = false
  let abortReason: ProviderFailure | undefined

  let currentModel: ModelRef = flashModel
  let currentTask = initialTask
  let attemptNumber = 0

  while (true) {
    attemptNumber += 1
    const modelId = currentModel.model

    let turnResult: TurnResult
    try {
      turnResult = await runTurn(currentTask, currentModel, workspace)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      const failure = classifyProviderFailure(currentModel.provider, {
        message,
        model: currentModel.model,
      })
      if (!failure.retryable) {
        aborted = true
        abortReason = failure
        break
      }
      // Retryable: record and stop for checkpoint/resume
      aborted = true
      abortReason = failure
      break
    }

    totalCostUsd += turnResult.costUsd
    totalLatencyMs += turnResult.latencyMs
    totalOutputTokens += turnResult.outputTokens

    const verification = await verify(workspace, currentModel)
    const diagnosticPass = verification.diagnosticPass
    const holdoutPass = verification.holdoutPass
    const verified = diagnosticPass && (holdoutPass ?? true)

    // Holdout failure is terminal: diagnostic passed but the unseen holdout
    // failed. No repair, no escalation, no further provider calls.
    if (diagnosticPass && holdoutPass === false) {
      if (currentModel.model === flashModel.model) {
        flashAttempts += 1
      } else {
        proAttempts += 1
      }
      const attemptRecord: LoopAttempt = {
        attempt: attemptNumber,
        model: modelId,
        routingDecisionId: turnResult.routingDecisionId,
        verified: false,
        diagnosticPass: true,
        holdoutPass: false,
        failureFingerprint: undefined,
        costUsd: turnResult.costUsd,
        latencyMs: turnResult.latencyMs,
        cacheReadTokens: turnResult.cacheReadTokens,
        cacheMissTokens: turnResult.cacheMissTokens,
        outputTokens: turnResult.outputTokens,
        inputTokens: turnResult.inputTokens,
        reasoningTokens: turnResult.reasoningTokens,
        totalTokens: turnResult.totalTokens,
        repairAction: 'complete',
        repairReason: 'qualification-failed',
        providerFailure: undefined,
      }
      attempts.push(attemptRecord)
      break
    }

    let fingerprint: string | undefined
    let progress: RepairAttempt['progress']
    if (!verified) {
      const evidence = verification.evidence
      fingerprint = computeFailureFingerprint(evidence)
      failureFingerprints.push(fingerprint)
      progress = priorFailure !== undefined
        ? classifyProgress(priorFailure, evidence)
        : 'none'
      progressHistory.push(progress)
      priorFailure = evidence
    }

    const repairAttempt: RepairAttempt = {
      attempt: attemptNumber,
      model: currentModel,
      routingDecisionId: turnResult.routingDecisionId,
      verified,
      verificationStatus: verified ? 'verified-pass' : 'verified-fail',
      ...(fingerprint !== undefined ? { failureFingerprint: fingerprint } : {}),
      ...(progress !== undefined ? { progress } : {}),
      costUsd: turnResult.costUsd,
      latencyMs: turnResult.latencyMs,
    }
    repairAttempts.push(repairAttempt)

    if (currentModel.model === flashModel.model) {
      flashAttempts += 1
    } else {
      proAttempts += 1
    }

    const latestFailure = !verified && priorFailure !== undefined ? priorFailure : undefined

    const decision = decide({
      sessionId: `v018-${taskId}` as never,
      turn: 1,
      step: 0,
      initialModel: flashModel,
      currentModel,
      attempts: repairAttempts,
      ...(latestFailure !== undefined ? { latestFailure } : {}),
      budget: {
        totalCostUsd,
        elapsedMs: totalLatencyMs,
        totalOutputTokens,
      },
      limits,
    })

    const attemptRecord: LoopAttempt = {
      attempt: attemptNumber,
      model: modelId,
      routingDecisionId: turnResult.routingDecisionId,
      verified,
      diagnosticPass,
      holdoutPass,
      failureFingerprint: fingerprint,
      ...(progress !== undefined ? { progress } : {}),
      costUsd: turnResult.costUsd,
      latencyMs: turnResult.latencyMs,
      cacheReadTokens: turnResult.cacheReadTokens,
      cacheMissTokens: turnResult.cacheMissTokens,
      outputTokens: turnResult.outputTokens,
      inputTokens: turnResult.inputTokens,
      reasoningTokens: turnResult.reasoningTokens,
      totalTokens: turnResult.totalTokens,
      repairAction: decision.action,
      ...(decision.action === 'pro-escalate' || decision.action === 'stop'
        ? { repairReason: decision.reason }
        : {}),
      providerFailure: undefined,
    }
    attempts.push(attemptRecord)

    if (decision.action === 'complete' || decision.action === 'stop') {
      break
    }
    if (decision.action === 'flash-repair') {
      currentModel = flashModel
      currentTask = constructRepairPrompt(decision.evidence, attemptNumber + 1)
      continue
    }
    if (decision.action === 'pro-escalate') {
      currentModel = proModel
      currentTask = constructProEscalationPrompt(decision.evidence, flashAttempts)
      continue
    }
    break
  }

  const lastAttempt = attempts.at(-1)
  const finalVerified = lastAttempt?.verified ?? false
  const holdoutPass = lastAttempt?.holdoutPass ?? false

  return {
    taskId,
    attempts,
    finalVerified,
    holdoutPass: finalVerified && holdoutPass,
    flashAttempts,
    proAttempts,
    totalCostUsd,
    totalLatencyMs,
    failureFingerprints,
    progressHistory,
    escalatedToPro: proAttempts > 0,
    aborted,
    abortReason,
  }
}
