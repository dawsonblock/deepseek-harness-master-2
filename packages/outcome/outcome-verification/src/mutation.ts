import type {
  GeneratedVerificationMutation,
  VerificationMutationOperator,
  VerificationMutationSeed,
} from './types.js'

/**
 * Materialize deterministic invalid candidates from known-valid seeds. Each
 * generated benchmark case carries the mutation operator and seed identity so
 * promotion can gate on mutation survival instead of only aggregate FAR.
 */
export function generateVerificationMutations<TFixture>(
  seeds: readonly VerificationMutationSeed<TFixture>[],
  operators: readonly VerificationMutationOperator<TFixture>[],
): readonly GeneratedVerificationMutation<TFixture>[] {
  const out: GeneratedVerificationMutation<TFixture>[] = []
  const ids = new Set<string>()
  for (const seed of seeds) {
    if (!seed.id.trim()) throw new Error('mutation seed id must be non-empty')
    if (!seed.pack.trim()) throw new Error(`mutation seed ${seed.id} pack must be non-empty`)
    for (const operator of operators) {
      if (!operator.id.trim()) throw new Error('mutation operator id must be non-empty')
      if (!operator.faultClass.trim()) throw new Error(`mutation operator ${operator.id} faultClass must be non-empty`)
      if (operator.appliesTo && !operator.appliesTo(seed)) continue
      const id = `${seed.pack}:${seed.id}:mutation:${operator.id}`
      if (ids.has(id)) throw new Error(`duplicate generated mutation id: ${id}`)
      ids.add(id)
      out.push({
        benchmarkCase: {
          id,
          pack: seed.pack,
          groundTruth: 'invalid',
          faultClass: operator.faultClass,
          mutationOperator: operator.id,
          mutationOf: seed.id,
        },
        fixture: operator.mutate(seed.fixture, seed),
      })
    }
  }
  return out
}
