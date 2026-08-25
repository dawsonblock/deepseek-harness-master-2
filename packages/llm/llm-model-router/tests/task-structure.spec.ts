import { describe, expect, it } from 'vitest'
import { WORKLOAD_FEATURE_VERSION, analyzeTaskStructure } from '../src/task-structure.ts'

describe('analyzeTaskStructure', () => {
  it('uses a separate workload-v2 schema', () => {
    expect(analyzeTaskStructure('Explain cache invalidation.').featureVersion).toBe(WORKLOAD_FEATURE_VERSION)
  })

  it('increases constraint counts when requirements are added', () => {
    const base = analyzeTaskStructure('Write an email declining a meeting.')
    const constrained = analyzeTaskStructure(
      'Write an email declining a meeting. Use exactly 50 words. End with "Best, Sam". Return only the email.',
    )

    expect(constrained.constraints.explicitConstraintCount).toBeGreaterThan(base.constraints.explicitConstraintCount)
    expect(constrained.constraints.exactTerminalLiteral).toBe(true)
    expect(constrained.constraints.noExtraneousOutput).toBe(true)
  })

  it('distinguishes synthesis from schema-preserving restructuring', () => {
    const synthesis = analyzeTaskStructure('Summarize these three reports into two paragraphs.')
    const restructure = analyzeTaskStructure(
      'Filter this JSON array and return only active users as objects with name fields only. Return only JSON.',
    )

    expect(synthesis.transformation.type).toBe('synthesis')
    expect(restructure.transformation.type).toBe('restructure')
    expect(restructure.transformation.operationCount).toBeGreaterThanOrEqual(2)
    expect(restructure.constraints.strictFormat).toBe(true)
    expect(restructure.output.requestedType).toBe('json')
  })

  it('extracts table cardinality, fields, and exact multiplicity', () => {
    const features = analyzeTaskStructure(
      'Create a Markdown table with exactly three data rows and columns Name, Priority, Owner. '
      + 'Use High, Medium, and Low exactly once each.',
      { verificationCriterionCount: 3 },
    )

    expect(features.constraints.expectedOutputCardinality).toBe(3)
    expect(features.constraints.exactMultiplicity).toBe(true)
    expect(features.transformation.outputFieldCount).toBe(3)
    expect(features.context.verificationCriterionCount).toBe(3)
  })

  it('infers one output unit per named source entity', () => {
    const features = analyzeTaskStructure(
      'Explain the roles of resource owner, client, authorization server, and resource server. Use one sentence per role.',
    )

    expect(features.constraints.expectedOutputCardinality).toBe(4)
    expect(features.categoryScores['factual-explain']).toBe(1)
  })

  it('preserves pre-routing runtime facts', () => {
    const features = analyzeTaskStructure('Review these files for a bug.', {
      messageCount: 3,
      attachedFileCount: 2,
      toolSchemaCount: 5,
      contextUtilizationEstimate: 0.72,
    })

    expect(features.context).toMatchObject({
      messageCount: 3,
      attachedFileCount: 2,
      toolSchemaCount: 5,
      contextUtilizationEstimate: 0.72,
    })
  })
})
