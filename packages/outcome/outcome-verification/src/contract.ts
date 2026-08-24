import { hashCanonical } from './canonical.js'
import type { AcceptanceContract, AcceptanceCriterion } from './types.js'

const ID = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/

export function validateAcceptanceContract(contract: AcceptanceContract): void {
  if (contract.contractVersion !== 1) throw new Error('unsupported acceptance contract version')
  if (!contract.goalId.trim()) throw new Error('goalId must be non-empty')
  if (!Number.isSafeInteger(contract.goalRevision) || contract.goalRevision < 1) throw new Error('goalRevision must be a positive safe integer')
  if (!contract.objective.trim()) throw new Error('objective must be non-empty')
  if (contract.pack !== undefined) {
    if (!contract.pack.id.trim()) throw new Error('pack id must be non-empty')
    if (!contract.pack.version.trim()) throw new Error('pack version must be non-empty')
  }
  if (contract.criteria.length === 0) throw new Error('at least one acceptance criterion is required')
  const ids = new Set<string>()
  for (const criterion of contract.criteria) {
    validateCriterion(criterion)
    if (ids.has(criterion.id)) throw new Error(`duplicate criterion id: ${criterion.id}`)
    ids.add(criterion.id)
  }
  for (const criterion of contract.criteria) {
    for (const dependency of criterion.dependsOn ?? []) {
      if (!ids.has(dependency)) throw new Error(`criterion ${criterion.id} depends on missing criterion ${dependency}`)
      if (dependency === criterion.id) throw new Error(`criterion ${criterion.id} cannot depend on itself`)
    }
  }
  topologicalCriteria(contract.criteria)
}

function validateCriterion(criterion: AcceptanceCriterion): void {
  if (!ID.test(criterion.id)) throw new Error(`invalid criterion id: ${criterion.id}`)
  if (!criterion.description.trim()) throw new Error(`criterion ${criterion.id} description must be non-empty`)
  if (!ID.test(criterion.verifier)) throw new Error(`criterion ${criterion.id} verifier must be a stable id`)
  if (criterion.verifierVersion !== undefined && !criterion.verifierVersion.trim()) throw new Error(`criterion ${criterion.id} verifierVersion must be non-empty`)
  if (criterion.timeoutMs !== undefined && (!Number.isSafeInteger(criterion.timeoutMs) || criterion.timeoutMs < 1)) throw new Error(`criterion ${criterion.id} timeoutMs must be positive`)
}

export function acceptanceContractHash(contract: AcceptanceContract): string {
  validateAcceptanceContract(contract)
  return hashCanonical(contract)
}

export function topologicalCriteria(criteria: readonly AcceptanceCriterion[]): readonly AcceptanceCriterion[] {
  const byId = new Map(criteria.map(criterion => [criterion.id, criterion]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const output: AcceptanceCriterion[] = []
  const visit = (id: string): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) throw new Error(`criterion dependency cycle includes ${id}`)
    const criterion = byId.get(id)
    if (!criterion) throw new Error(`missing criterion ${id}`)
    visiting.add(id)
    for (const dependency of criterion.dependsOn ?? []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
    output.push(criterion)
  }
  for (const criterion of criteria) visit(criterion.id)
  return output
}

export function createAcceptanceContract(input: Omit<AcceptanceContract, 'contractVersion'>): AcceptanceContract {
  const contract: AcceptanceContract = { contractVersion: 1, ...input }
  validateAcceptanceContract(contract)
  return contract
}
