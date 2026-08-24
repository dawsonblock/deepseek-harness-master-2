import { createAcceptanceContract } from './contract.js'
import type { AcceptanceContract, AcceptanceCriterion, AcceptancePackDescriptor } from './types.js'

export interface PackInput {
  readonly goalId: string
  readonly goalRevision: number
  readonly objective: string
}

const PACK_VERSION = '1'
const trusted = (id: string, description: string, severity: 'required'|'important'|'advisory' = 'required', dependsOn?: readonly string[]): AcceptanceCriterion => ({
  id,
  description,
  severity,
  verificationMode: 'deterministic',
  verifier: 'trusted-check.pass',
  args: { check: id },
  authority: 'system',
  ...(dependsOn ? { dependsOn } : {}),
})
const pack = (id: AcceptancePackDescriptor['id']): AcceptancePackDescriptor => ({ id, version: PACK_VERSION })
const policies = {
  evidencePolicy: { requireDeterministicForRequired: true as const },
  completionPolicy: { importantPassRatio: 1, advisoryPassRatio: 0, failOnStaleRequired: true as const },
}

export function runtimeAcceptancePack(input: PackInput): AcceptanceContract {
  return createAcceptanceContract({
    ...input,
    pack: pack('runtime'),
    criteria: [
      { id: 'runtime-clean', description: 'No unresolved side effects remain', severity: 'required', verificationMode: 'runtime', verifier: 'runtime.no-unresolved-side-effects', authority: 'system' },
      { id: 'recovery-clean', description: 'Recovery state is clean or auto-resumable', severity: 'required', verificationMode: 'runtime', verifier: 'runtime.recovery-clean', authority: 'system' },
      trusted('qualification-pass', 'Targeted qualification suite passes'),
      trusted('package-consumer-pass', 'Packed consumer import succeeds'),
    ],
    ...policies,
  })
}

export interface CodingPackOptions {
  readonly requireLint?: boolean
  readonly minimumCoverage?: number
  readonly benchmark?: {
    readonly key: string
    readonly baseline: number
    readonly tolerance: number
    readonly direction: 'lower-is-better' | 'higher-is-better'
  }
}

export function codingAcceptancePack(input: PackInput, options: CodingPackOptions = {}): AcceptanceContract {
  const criteria: AcceptanceCriterion[] = [
    trusted('tests-pass', 'Relevant automated tests pass'),
    trusted('typecheck-pass', 'Type checking passes'),
    { id: 'runtime-clean', description: 'No unresolved side effects remain', severity: 'required', verificationMode: 'runtime', verifier: 'runtime.no-unresolved-side-effects', authority: 'system' },
  ]
  if (options.requireLint) criteria.push(trusted('lint-pass', 'Lint passes', 'important'))
  if (options.minimumCoverage !== undefined) criteria.push({ id: 'coverage', description: 'Coverage reaches required minimum', severity: 'important', verificationMode: 'benchmark', verifier: 'number.minimum', args: { key: 'coverage-percent', minimum: options.minimumCoverage }, authority: 'system' })
  if (options.benchmark) criteria.push({ id: 'performance-regression', description: 'Performance has not materially regressed', severity: 'important', verificationMode: 'benchmark', verifier: 'benchmark.no-regression', args: options.benchmark, authority: 'system' })
  return createAcceptanceContract({ ...input, pack: pack('coding'), criteria, ...policies })
}

export function researchAcceptancePack(input: PackInput): AcceptanceContract {
  return createAcceptanceContract({
    ...input,
    pack: pack('research'),
    criteria: [
      trusted('claim-provenance', 'Every material claim has evidence'),
      { id: 'contradictions-resolved', description: 'No unresolved material evidence contradictions remain', severity: 'required', verificationMode: 'evidence', verifier: 'evidence.no-contradictions', authority: 'system' },
      trusted('source-quality', 'Required source-quality threshold is met'),
      trusted('required-experiments', 'Required experiments were actually executed'),
    ],
    evidencePolicy: { requireDeterministicForRequired: true, minimumEvidencePerRequiredCriterion: 1 },
    completionPolicy: policies.completionPolicy,
  })
}

export interface DeploymentPackOptions {
  readonly latency?: { readonly key: string; readonly maximum: number }
  readonly errorRate?: { readonly key: string; readonly maximum: number }
}

export function deploymentAcceptancePack(input: PackInput, options: DeploymentPackOptions = {}): AcceptanceContract {
  const criteria: AcceptanceCriterion[] = [
    trusted('build-pass', 'Production build succeeds'),
    { id: 'deployment-exists', description: 'Deployment resource exists', severity: 'required', verificationMode: 'external-state', verifier: 'external.resource-exists', args: { key: 'deployment' }, authority: 'system', dependsOn: ['build-pass'] },
    trusted('healthcheck-pass', 'Deployment healthcheck succeeds', 'required', ['deployment-exists']),
    trusted('smoke-test-pass', 'Deployment smoke test succeeds', 'required', ['healthcheck-pass']),
    trusted('rollback-ready', 'Rollback path is available'),
    { id: 'runtime-clean', description: 'No unresolved side effects remain', severity: 'required', verificationMode: 'runtime', verifier: 'runtime.no-unresolved-side-effects', authority: 'system' },
  ]
  if (options.latency) criteria.push({ id: 'p95-latency', description: 'p95 latency remains under threshold', severity: 'important', verificationMode: 'benchmark', verifier: 'number.maximum', args: options.latency, authority: 'system' })
  if (options.errorRate) criteria.push({ id: 'error-rate', description: 'Error rate remains under threshold', severity: 'important', verificationMode: 'benchmark', verifier: 'number.maximum', args: options.errorRate, authority: 'system' })
  return createAcceptanceContract({ ...input, pack: pack('deployment'), criteria, ...policies })
}

export interface DataPipelinePackOptions {
  readonly minimumRows?: number
  readonly maximumNullRate?: number
  readonly maximumDuplicateRate?: number
}

export function dataPipelineAcceptancePack(input: PackInput, options: DataPipelinePackOptions = {}): AcceptanceContract {
  const criteria: AcceptanceCriterion[] = [
    trusted('schema-valid', 'Output schema is valid'),
    trusted('referential-integrity', 'Referential integrity checks pass'),
    { id: 'runtime-clean', description: 'No unresolved side effects remain', severity: 'required', verificationMode: 'runtime', verifier: 'runtime.no-unresolved-side-effects', authority: 'system' },
  ]
  if (options.minimumRows !== undefined) criteria.push({ id: 'row-count', description: 'Row count reaches required minimum', severity: 'required', verificationMode: 'benchmark', verifier: 'number.minimum', args: { key: 'dataset.row-count', minimum: options.minimumRows }, authority: 'system' })
  if (options.maximumNullRate !== undefined) criteria.push({ id: 'null-rate', description: 'Null rate stays below maximum', severity: 'required', verificationMode: 'benchmark', verifier: 'number.maximum', args: { key: 'dataset.null-rate', maximum: options.maximumNullRate }, authority: 'system' })
  if (options.maximumDuplicateRate !== undefined) criteria.push({ id: 'duplicate-rate', description: 'Duplicate rate stays below maximum', severity: 'required', verificationMode: 'benchmark', verifier: 'number.maximum', args: { key: 'dataset.duplicate-rate', maximum: options.maximumDuplicateRate }, authority: 'system' })
  return createAcceptanceContract({ ...input, pack: pack('data-pipeline'), criteria, ...policies })
}

export interface ReleasePackOptions {
  readonly latencyBenchmark?: CodingPackOptions['benchmark']
  readonly tokenBenchmark?: CodingPackOptions['benchmark']
}

/** Dogfood pack for Harness release candidates. All command execution stays behind deployment-owned trusted checks. */
export function releaseAcceptancePack(input: PackInput, options: ReleasePackOptions = {}): AcceptanceContract {
  const criteria: AcceptanceCriterion[] = [
    trusted('outcome-engine-tests', 'Outcome Verification Engine tests pass'),
    trusted('agent-hardening-tests', 'Agent hardening tests pass'),
    trusted('python-reference-tests', 'Python reference regression tests pass'),
    trusted('failure-injection-tests', 'Failure-injection qualification passes'),
    trusted('process-kill-tests', 'Process-kill qualification passes'),
    trusted('packed-consumer-pass', 'Packed clean-consumer import succeeds'),
    trusted('source-guards-pass', 'Release source guards pass'),
    trusted('archive-manifest-valid', 'Archive checksum manifest validates'),
    { id: 'runtime-clean', description: 'No unresolved side effects remain', severity: 'required', verificationMode: 'runtime', verifier: 'runtime.no-unresolved-side-effects', authority: 'system' },
    { id: 'recovery-clean', description: 'Recovery state is clean', severity: 'required', verificationMode: 'runtime', verifier: 'runtime.recovery-clean', authority: 'system' },
  ]
  if (options.latencyBenchmark) criteria.push({ id: 'latency-regression', description: 'Release latency has not materially regressed', severity: 'important', verificationMode: 'benchmark', verifier: 'benchmark.no-regression', args: options.latencyBenchmark, authority: 'system' })
  if (options.tokenBenchmark) criteria.push({ id: 'token-regression', description: 'Token cost has not materially regressed', severity: 'important', verificationMode: 'benchmark', verifier: 'benchmark.no-regression', args: options.tokenBenchmark, authority: 'system' })
  return createAcceptanceContract({ ...input, pack: pack('release'), criteria, ...policies })
}

export const ACCEPTANCE_PACK_VERSIONS = Object.freeze({ runtime: PACK_VERSION, coding: PACK_VERSION, research: PACK_VERSION, deployment: PACK_VERSION, 'data-pipeline': PACK_VERSION, release: PACK_VERSION })

/** Factories suitable for AcceptancePackRegistry registration. */
export const STANDARD_ACCEPTANCE_PACK_FACTORIES = Object.freeze([
  { id: 'runtime', version: PACK_VERSION, create: (input: PackInput) => runtimeAcceptancePack(input) },
  { id: 'coding', version: PACK_VERSION, create: (input: PackInput, options?: CodingPackOptions) => codingAcceptancePack(input, options) },
  { id: 'research', version: PACK_VERSION, create: (input: PackInput) => researchAcceptancePack(input) },
  { id: 'deployment', version: PACK_VERSION, create: (input: PackInput, options?: DeploymentPackOptions) => deploymentAcceptancePack(input, options) },
  { id: 'data-pipeline', version: PACK_VERSION, create: (input: PackInput, options?: DataPipelinePackOptions) => dataPipelineAcceptancePack(input, options) },
  { id: 'release', version: PACK_VERSION, create: (input: PackInput, options?: ReleasePackOptions) => releaseAcceptancePack(input, options) },
] as const)
