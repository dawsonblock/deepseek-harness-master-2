import {
  codingAcceptancePack,
  dataPipelineAcceptancePack,
  deploymentAcceptancePack,
  releaseAcceptancePack,
  researchAcceptancePack,
  runtimeAcceptancePack,
  type CodingPackOptions,
  type DataPipelinePackOptions,
  type DeploymentPackOptions,
  type PackInput,
  type ReleasePackOptions,
} from './packs.js'
import { createAcceptanceContract } from './contract.js'
import type { AcceptanceContract, AcceptanceCriterion } from './types.js'

export type ContractPack = 'coding' | 'runtime' | 'research' | 'deployment' | 'data-pipeline' | 'release' | 'custom'

export interface ContractDraftInput extends PackInput {
  readonly pack: ContractPack
  readonly criteria?: readonly AcceptanceCriterion[]
  readonly requireLint?: boolean
  readonly minimumCoverage?: number
  readonly benchmark?: CodingPackOptions['benchmark']
  readonly deployment?: DeploymentPackOptions
  readonly dataPipeline?: DataPipelinePackOptions
  readonly release?: ReleasePackOptions
}

/**
 * Deterministic contract-draft compiler. A model may propose this input, but
 * required criteria stay explicit, versioned data owned by the selected pack.
 */
export function compileContractDraft(input: ContractDraftInput): AcceptanceContract {
  if (input.pack === 'coding') {
    return codingAcceptancePack(input, {
      ...(input.requireLint === undefined ? {} : { requireLint: input.requireLint }),
      ...(input.minimumCoverage === undefined ? {} : { minimumCoverage: input.minimumCoverage }),
      ...(input.benchmark === undefined ? {} : { benchmark: input.benchmark }),
    })
  }
  if (input.pack === 'runtime') return runtimeAcceptancePack(input)
  if (input.pack === 'research') return researchAcceptancePack(input)
  if (input.pack === 'deployment') return deploymentAcceptancePack(input, input.deployment)
  if (input.pack === 'data-pipeline') return dataPipelineAcceptancePack(input, input.dataPipeline)
  if (input.pack === 'release') return releaseAcceptancePack(input, input.release)
  if (!input.criteria || input.criteria.length === 0) throw new Error('custom contract requires criteria')
  return createAcceptanceContract({
    goalId: input.goalId,
    goalRevision: input.goalRevision,
    objective: input.objective,
    criteria: input.criteria,
    evidencePolicy: { requireDeterministicForRequired: true },
    completionPolicy: { importantPassRatio: 1, advisoryPassRatio: 0, failOnStaleRequired: true },
  })
}

export function canWorkerMutateCriterion(criterion: AcceptanceCriterion): boolean {
  return (criterion.authority ?? 'contract-compiler') === 'worker'
}
