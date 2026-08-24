import {
  createGoalOutcomeVerifier,
  type AcceptanceContract,
  type GoalVerifierContextLike,
  type OutcomeReceipt,
  type OutcomeVerificationEngine,
  type ContractVerificationReport,
  type VerificationEnforcementMode,
  type VerificationEnvironment,
} from '@deepseek-ai/dsh-outcome-verification'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GoalCompletionVerifier, GoalService } from './index.ts'
import type { GoalOutcomeReceiptMeta } from './domain.ts'

export interface RegisterOutcomeContractOptions {
  readonly contract: AcceptanceContract
  /** Observe records would-reject evidence but does not block legacy completion. Defaults enforce. */
  readonly mode?: VerificationEnforcementMode
  readonly engine: OutcomeVerificationEngine
  readonly name?: string
  readonly version?: string
  readonly environment?: (context: { readonly agent: Agent; readonly goal: GoalVerifierContextLike['goal'] }) => VerificationEnvironment | Promise<VerificationEnvironment>
  readonly onReport?: (report: ContractVerificationReport, context: { readonly agent: Agent; readonly goal: GoalVerifierContextLike['goal'] }) => void | Promise<void>
  readonly onReceipt?: (receipt: OutcomeReceipt, context: { readonly agent: Agent; readonly goal: GoalVerifierContextLike['goal'] }) => void | Promise<void>
  /** Persist the immutable receipt in the owning session before goal/verification. Defaults true. */
  readonly persistReceipt?: boolean
}

/**
 * Register one Acceptance Contract as an objective acceptance authority.
 * The full Outcome Receipt is persisted as a log-only session event before
 * GoalService appends its policy-bound goal/verification authorization.
 */
export function registerOutcomeContract(service: GoalService, options: RegisterOutcomeContractOptions): () => void {
  const verifier = createGoalOutcomeVerifier({
    contract: options.contract,
    engine: options.engine,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.environment === undefined ? {} : {
      environment: context => options.environment!({ agent: context.agent as Agent, goal: context.goal }),
    }),
    ...(options.onReport === undefined ? {} : {
      onReport: (report, context) => options.onReport!(report, { agent: context.agent as Agent, goal: context.goal }),
    }),
    onReceipt: async (receipt, context) => {
      const typed = { agent: context.agent as Agent, goal: context.goal }
      if (options.persistReceipt !== false) {
        const payload: GoalOutcomeReceiptMeta = { ...receipt, kind: 'goal/outcome-receipt', version: 1 }
        typed.agent.session.append('goal/outcome-receipt', payload, { ignorable: true })
      }
      if (options.onReceipt) await options.onReceipt(receipt, typed)
    },
  })
  return service.registerAcceptanceVerifier(verifier as GoalCompletionVerifier)
}
