import { readFile } from 'node:fs/promises'
import { evaluateVerificationPromotion } from '../packages/outcome/outcome-verification/lib/index.js'

const inputPath = process.argv[2]
const configPath = process.argv[3] ?? 'config/acceptance/release-v2.json'
if (!inputPath) {
  console.error('usage: node scripts/evaluate-verifier-promotion-v11.mjs <benchmark.json> [release-config.json]')
  process.exit(64)
}

const [input, config] = await Promise.all([
  readFile(inputPath, 'utf8').then(JSON.parse),
  readFile(configPath, 'utf8').then(JSON.parse),
])
if (!Array.isArray(input.observations)) throw new Error('benchmark input must contain observations[]')
if (!input.policyBinding) throw new Error('benchmark input must contain policyBinding')

const decision = evaluateVerificationPromotion(input.observations, {
  from: 'observe',
  to: 'enforce',
  minimumCases: config.promotion.minimumCases,
  minimumValidCases: config.promotion.minimumValidCases,
  minimumInvalidCases: config.promotion.minimumInvalidCases,
  maximumFalseAcceptanceRate: config.benchmarkGate.maximumFalseAcceptanceRate,
  ...(config.benchmarkGate.maximumFalseRejectionRate !== undefined ? { maximumFalseRejectionRate: config.benchmarkGate.maximumFalseRejectionRate } : {}),
  ...(config.benchmarkGate.maximumFalseAcceptanceUpperBound95 !== undefined ? { maximumFalseAcceptanceUpperBound95: config.benchmarkGate.maximumFalseAcceptanceUpperBound95 } : {}),
  requirePerPackGates: config.promotion.requirePerPackGates === true,
}, { policyBinding: input.policyBinding })

process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`)
if (!decision.eligible) process.exitCode = 2
