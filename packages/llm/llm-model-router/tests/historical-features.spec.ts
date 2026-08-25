import { describe, expect, it } from 'vitest'
import { deriveBayesianHistoricalFeatures } from '../src/historical-features.ts'
import type { BayesianHistoryPrior, HistoricalOutcomeObservation } from '../src/historical-features.ts'

const PRIOR: BayesianHistoryPrior = {
  flashPassRate: 0.85,
  proPassRate: 0.9,
  proRescueRate: 0.05,
  flashRepairRate: 0.1,
  meanCostDelta: 0.002,
  strength: 10,
}

const observation = (
  bucket: string,
  flashVerified: boolean,
  proVerified: boolean,
): HistoricalOutcomeObservation => ({
  bucket,
  flashVerified,
  proVerified,
  flashRepairs: flashVerified ? 0 : 1,
  flashCost: 0.001,
  proCost: 0.004,
})

describe('deriveBayesianHistoricalFeatures', () => {
  it('returns global priors when the bucket has no earlier observations', () => {
    expect(deriveBayesianHistoricalFeatures([], 'structured-transform', PRIOR)).toEqual({
      flashPassRate: 0.85,
      proPassRate: 0.9,
      proRescueRate: 0.05,
      flashRepairRate: 0.1,
      meanCostDelta: 0.002,
      sampleCount: 0,
      priorStrength: 10,
    })
  })

  it('shrinks sparse bucket outcomes toward global priors', () => {
    const result = deriveBayesianHistoricalFeatures([
      observation('structured-transform', false, true),
      observation('other', false, false),
    ], 'structured-transform', PRIOR)

    expect(result.sampleCount).toBe(1)
    expect(result.proRescueRate).toBeGreaterThan(PRIOR.proRescueRate)
    expect(result.proRescueRate).toBeLessThan(1)
    expect(result.flashPassRate).toBeGreaterThan(0)
  })

  it('uses only observations passed by the caller', () => {
    const earlier = [observation('planning', true, true)]
    const beforeCurrent = deriveBayesianHistoricalFeatures(earlier, 'planning', PRIOR)
    const afterCurrent = deriveBayesianHistoricalFeatures(
      [...earlier, observation('planning', false, true)],
      'planning',
      PRIOR,
    )

    expect(beforeCurrent.sampleCount).toBe(1)
    expect(afterCurrent.sampleCount).toBe(2)
    expect(beforeCurrent.proRescueRate).toBeLessThan(afterCurrent.proRescueRate)
  })

  it('rejects invalid prior probabilities', () => {
    expect(() => deriveBayesianHistoricalFeatures([], 'planning', {
      ...PRIOR,
      proRescueRate: 2,
    })).toThrow(/proRescueRate/)
  })
})
