import { OutcomeVerificationEngine, type VerificationEnvironment } from './engine.js'
import type { AcceptanceContract, ContractVerificationReport, OutcomeReceipt, VerificationEnforcementMode } from './types.js'

export interface GoalLike { readonly id: string; readonly revision: number }
export interface GoalVerifierContextLike { readonly goal: GoalLike; readonly agent?: unknown }
export interface GoalVerifierCheckLike {
  readonly name: string
  readonly passed: boolean
  readonly reason: string
  readonly evidence?: readonly string[]
}

export interface GoalOutcomeVerifierOptions {
  readonly name?: string
  readonly version?: string
  readonly mode?: VerificationEnforcementMode
  readonly contract: AcceptanceContract
  readonly engine: OutcomeVerificationEngine
  readonly environment?: (context: GoalVerifierContextLike) => VerificationEnvironment | Promise<VerificationEnvironment>
  readonly onReport?: (report: ContractVerificationReport, context: GoalVerifierContextLike) => void | Promise<void>
  readonly onReceipt?: (receipt: OutcomeReceipt, context: GoalVerifierContextLike) => void | Promise<void>
}

/** Structural adapter for GoalService.registerAcceptanceVerifier(). */
export function createGoalOutcomeVerifier(options: GoalOutcomeVerifierOptions) {
  const mode = options.mode ?? 'enforce'
  return {
    name: options.name ?? 'outcome-contract',
    version: options.version ?? `contract-v${options.contract.contractVersion}`,
    async verify(context: GoalVerifierContextLike): Promise<GoalVerifierCheckLike> {
      if (context.goal.id !== options.contract.goalId || context.goal.revision !== options.contract.goalRevision) {
        return { name: options.name ?? 'outcome-contract', passed: false, reason: 'goal id/revision does not match acceptance contract' }
      }
      const environment = options.environment ? await options.environment(context) : {}
      const report = await options.engine.verify(options.contract, environment)
      if (options.onReport) await options.onReport(report, context)
      if (!report.passed) {
        const failures = report.criteria.filter(row => row.state !== 'pass').map(row => `${row.criterion.id}:${row.state}`)
        if (mode === 'observe') {
          return {
            name: options.name ?? 'outcome-contract',
            passed: true,
            reason: `observe mode: acceptance contract would reject completion: ${failures.join(', ')}`,
            evidence: ['verification-observe:reject', ...failures],
          }
        }
        return { name: options.name ?? 'outcome-contract', passed: false, reason: `acceptance contract failed: ${failures.join(', ')}`, evidence: failures }
      }
      const receipt = options.engine.createReceipt(report)
      if (options.onReceipt) await options.onReceipt(receipt, context)
      return {
        name: options.name ?? 'outcome-contract', passed: true,
        reason: `${mode === 'observe' ? 'observe mode: ' : ''}acceptance contract passed; outcome receipt ${receipt.receiptHash}`,
        evidence: [...(mode === 'observe' ? ['verification-observe:accept'] : []), `outcome-receipt:${receipt.receiptHash}`, `contract:${receipt.contractHash}`, ...receipt.criteria.map(row => `${row.criterionId}:${row.state}`)],
      }
    },
  }
}
