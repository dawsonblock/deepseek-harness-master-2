import { sha256Hex, stableStringify } from './canonical.js'
import type { VerifierDefinition, VerificationContext, VerificationResult } from './types.js'

function numberArg(args: Readonly<Record<string, unknown>>, key: string): number {
  const value = args[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`)
  return value
}
function stringArg(args: Readonly<Record<string, unknown>>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} must be a non-empty string`)
  return value
}
async function read(context: VerificationContext, channel: 'artifact'|'runtime'|'external', key: string) {
  const reader = channel === 'artifact' ? context.readArtifact : channel === 'runtime' ? context.readRuntime : context.readExternal
  if (!reader) return undefined
  return reader(key)
}

export const valueEqualsVerifier: VerifierDefinition = {
  id: 'value.equals', version: '1', category: 'acceptance', deterministic: true,
  async verify(context, args): Promise<VerificationResult> {
    const channel = (args.channel ?? 'runtime') as 'artifact'|'runtime'|'external'
    if (!['artifact','runtime','external'].includes(channel)) throw new Error('channel must be artifact, runtime, or external')
    const key = stringArg(args, 'key')
    const observed = await read(context, channel, key)
    if (!observed) return { passed: false, reason: `${channel} value ${key} is unavailable`, source: channel === 'external' ? 'external' : channel, result: null }
    const expected = args.expected
    const passed = stableStringify(observed.value) === stableStringify(expected)
    return {
      passed,
      reason: passed ? `${key} equals expected value` : `${key} does not equal expected value`,
      source: channel === 'external' ? 'external' : channel,
      result: observed.value,
      dependencies: [{ kind: channel, key, version: observed.version }],
    }
  },
}

export const numberMinimumVerifier: VerifierDefinition = {
  id: 'number.minimum', version: '1', category: 'quality', deterministic: true,
  async verify(context, args) {
    const key = stringArg(args, 'key')
    const minimum = numberArg(args, 'minimum')
    const observed = await read(context, 'runtime', key)
    const value = observed?.value
    const passed = typeof value === 'number' && Number.isFinite(value) && value >= minimum
    return {
      passed,
      reason: passed ? `${key}=${value} >= ${minimum}` : `${key}=${String(value)} is below ${minimum}`,
      source: 'runtime', result: value ?? null,
      dependencies: observed ? [{ kind: 'runtime', key, version: observed.version }] : [],
    }
  },
}

export const numberMaximumVerifier: VerifierDefinition = {
  id: 'number.maximum', version: '1', category: 'quality', deterministic: true,
  async verify(context, args) {
    const key = stringArg(args, 'key')
    const maximum = numberArg(args, 'maximum')
    const observed = await read(context, 'runtime', key)
    const value = observed?.value
    const passed = typeof value === 'number' && Number.isFinite(value) && value <= maximum
    return {
      passed,
      reason: passed ? `${key}=${value} <= ${maximum}` : `${key}=${String(value)} exceeds ${maximum}`,
      source: 'runtime', result: value ?? null,
      dependencies: observed ? [{ kind: 'runtime', key, version: observed.version }] : [],
    }
  },
}

export const benchmarkNoRegressionVerifier: VerifierDefinition = {
  id: 'benchmark.no-regression', version: '1', category: 'quality', deterministic: true,
  async verify(context, args) {
    const key = stringArg(args, 'key')
    const baseline = numberArg(args, 'baseline')
    const tolerance = numberArg(args, 'tolerance')
    if (tolerance < 0) throw new Error('tolerance must be non-negative')
    const direction = args.direction === 'higher-is-better' ? 'higher-is-better' : 'lower-is-better'
    const observed = await read(context, 'runtime', key)
    const value = observed?.value
    if (typeof value !== 'number' || !Number.isFinite(value)) return { passed: false, reason: `${key} has no finite benchmark value`, source: 'runtime', result: value ?? null }
    const limit = direction === 'lower-is-better' ? baseline * (1 + tolerance) : baseline * (1 - tolerance)
    const passed = direction === 'lower-is-better' ? value <= limit : value >= limit
    return { passed, reason: passed ? `${key} remained within regression tolerance` : `${key} regressed beyond tolerance`, source: 'runtime', result: { value, baseline, tolerance, direction }, dependencies: observed ? [{ kind: 'runtime', key, version: observed.version }] : [] }
  },
}

export const artifactSha256Verifier: VerifierDefinition = {
  id: 'artifact.sha256', version: '1', category: 'integrity', deterministic: true,
  async verify(context, args) {
    const key = stringArg(args, 'key')
    const expected = stringArg(args, 'sha256').toLowerCase()
    const observed = await read(context, 'artifact', key)
    if (!observed) return { passed: false, reason: `artifact ${key} is unavailable`, source: 'artifact', result: null }
    let bytes: Uint8Array
    if (observed.value instanceof Uint8Array) bytes = observed.value
    else if (typeof observed.value === 'string') bytes = new TextEncoder().encode(observed.value)
    else bytes = new TextEncoder().encode(stableStringify(observed.value))
    const actual = sha256Hex(bytes)
    return { passed: actual === expected, reason: actual === expected ? `artifact ${key} hash matches` : `artifact ${key} hash mismatch`, source: 'artifact', result: { actual, expected }, dependencies: [{ kind: 'artifact', key, version: observed.version }] }
  },
}

export const runtimeNoUnresolvedSideEffectsVerifier: VerifierDefinition = {
  id: 'runtime.no-unresolved-side-effects', version: '1', category: 'integrity', deterministic: true,
  async verify(context) {
    const observed = await read(context, 'runtime', 'unresolved-side-effects')
    const value = observed?.value
    const count = typeof value === 'number' ? value : Array.isArray(value) ? value.length : value === undefined ? Number.NaN : value ? 1 : 0
    const passed = count === 0
    return { passed, reason: passed ? 'no unresolved side effects' : `unresolved side effects remain: ${String(count)}`, source: 'runtime', result: value ?? null, dependencies: observed ? [{ kind: 'runtime', key: 'unresolved-side-effects', version: observed.version }] : [] }
  },
}

export function standardVerifiers(): readonly VerifierDefinition[] {
  return [valueEqualsVerifier, numberMinimumVerifier, numberMaximumVerifier, benchmarkNoRegressionVerifier, artifactSha256Verifier, artifactExistsVerifier, artifactNonemptyVerifier, runtimeNoUnresolvedSideEffectsVerifier, runtimeRecoveryCleanVerifier, evidenceNoContradictionsVerifier, externalResourceExistsVerifier]
}

export const artifactExistsVerifier: VerifierDefinition = {
  id: 'artifact.exists', version: '1', category: 'acceptance', deterministic: true,
  async verify(context, args) {
    const key = stringArg(args, 'key')
    const observed = await read(context, 'artifact', key)
    return {
      passed: observed !== undefined,
      reason: observed ? `artifact ${key} exists` : `artifact ${key} is unavailable`,
      source: 'artifact', result: observed?.value ?? null,
      dependencies: observed ? [{ kind: 'artifact', key, version: observed.version }] : [],
    }
  },
}

export const artifactNonemptyVerifier: VerifierDefinition = {
  id: 'artifact.nonempty', version: '1', category: 'quality', deterministic: true,
  async verify(context, args) {
    const key = stringArg(args, 'key')
    const observed = await read(context, 'artifact', key)
    const value = observed?.value
    let size = 0
    if (typeof value === 'string') size = value.length
    else if (value instanceof Uint8Array) size = value.byteLength
    else if (Array.isArray(value)) size = value.length
    else if (value && typeof value === 'object') size = Object.keys(value as Record<string, unknown>).length
    const passed = observed !== undefined && size > 0
    return {
      passed, reason: passed ? `artifact ${key} is non-empty` : `artifact ${key} is empty or unavailable`,
      source: 'artifact', result: { size },
      dependencies: observed ? [{ kind: 'artifact', key, version: observed.version }] : [],
    }
  },
}

export const runtimeRecoveryCleanVerifier: VerifierDefinition = {
  id: 'runtime.recovery-clean', version: '1', category: 'integrity', deterministic: true,
  async verify(context) {
    const observed = await read(context, 'runtime', 'recovery-status')
    const value = observed?.value
    const passed = value === 'clean'
      || (typeof value === 'object' && value !== null
        && (value as { canAutoResume?: unknown }).canAutoResume === true
        && (value as { blocked?: unknown }).blocked !== true)
    return {
      passed,
      reason: passed ? 'recovery state is clean or auto-resumable' : 'recovery state is not clean',
      source: 'runtime', result: value ?? null,
      dependencies: observed ? [{ kind: 'runtime', key: 'recovery-status', version: observed.version }] : [],
    }
  },
}

export const evidenceNoContradictionsVerifier: VerifierDefinition = {
  id: 'evidence.no-contradictions', version: '1', category: 'integrity', deterministic: true,
  async verify(context) {
    const observed = await read(context, 'runtime', 'evidence-contradictions')
    const value = observed?.value
    const count = typeof value === 'number' ? value : Array.isArray(value) ? value.length : value === undefined ? Number.NaN : value ? 1 : 0
    const passed = count === 0
    return {
      passed,
      reason: passed ? 'no unresolved evidence contradictions' : `unresolved evidence contradictions remain: ${String(count)}`,
      source: 'runtime', result: value ?? null,
      dependencies: observed ? [{ kind: 'runtime', key: 'evidence-contradictions', version: observed.version }] : [],
    }
  },
}

export const externalResourceExistsVerifier: VerifierDefinition = {
  id: 'external.resource-exists', version: '1', category: 'acceptance', deterministic: true,
  async verify(context, args) {
    const key = stringArg(args, 'key')
    const observed = await read(context, 'external', key)
    const value = observed?.value
    const exists = observed !== undefined && value !== false && value !== null
    return {
      passed: exists,
      reason: exists ? `external resource ${key} exists` : `external resource ${key} is unavailable`,
      source: 'external', result: value ?? null,
      dependencies: observed ? [{ kind: 'external', key, version: observed.version }] : [],
    }
  },
}
