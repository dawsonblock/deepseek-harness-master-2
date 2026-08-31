/**
 * P1.5 evidence sanitization and immutable model-visible projection tests.
 * Verifies that:
 *
 * 1. `projectFailureForModel` produces a frozen, immutable projection.
 * 2. Internal harness identifiers (repair IDs, routing decision IDs,
 *    session IDs) are stripped from evidence strings.
 * 3. The rendered repair prompt contains only sanitized content.
 * 4. Mutating the original FailurePackage does not affect the projection.
 *
 * @module @deepseek-ai/dsh-repair-runtime/tests/p1-sanitization.spec
 */

import { describe, expect, it } from 'vitest'
import type { FailurePackage } from '@deepseek-ai/dsh-repair-controller'
import { projectFailureForModel } from '../src/index.ts'

describe('P1.5: projectFailureForModel produces immutable projection', () => {
  it('returns a frozen object', () => {
    const failure: FailurePackage = {
      failedCriteria: ['criterion-1'],
      failingTests: ['test-1 failed'],
      typeErrors: ['type error in foo.ts'],
      buildErrors: ['build error'],
      changedFiles: ['src/foo.ts'],
    }
    const projection = projectFailureForModel(failure)
    expect(Object.isFrozen(projection)).toBe(true)
    expect(Object.isFrozen(projection.failedCriteria)).toBe(true)
    expect(Object.isFrozen(projection.failingTests)).toBe(true)
    expect(Object.isFrozen(projection.typeErrors)).toBe(true)
    expect(Object.isFrozen(projection.buildErrors)).toBe(true)
    expect(Object.isFrozen(projection.changedFiles)).toBe(true)
  })

  it('contains the same evidence as the original when no internal IDs are present', () => {
    const failure: FailurePackage = {
      failedCriteria: ['criterion-1', 'criterion-2'],
      failingTests: ['test-1 failed', 'test-2 failed'],
      typeErrors: ['type error in foo.ts'],
      buildErrors: ['build error'],
      changedFiles: ['src/foo.ts', 'src/bar.ts'],
    }
    const projection = projectFailureForModel(failure)
    expect([...projection.failedCriteria]).toEqual(['criterion-1', 'criterion-2'])
    expect([...projection.failingTests]).toEqual(['test-1 failed', 'test-2 failed'])
    expect([...projection.typeErrors]).toEqual(['type error in foo.ts'])
    expect([...projection.buildErrors]).toEqual(['build error'])
    expect([...projection.changedFiles]).toEqual(['src/foo.ts', 'src/bar.ts'])
  })
})

describe('P1.5: internal harness identifiers are stripped', () => {
  it('strips repair:v1: IDs from evidence strings', () => {
    const failure: FailurePackage = {
      failedCriteria: ['repair:v1:abc123def456 failed criterion-1'],
      failingTests: [],
      typeErrors: [],
      buildErrors: [],
      changedFiles: [],
    }
    const projection = projectFailureForModel(failure)
    expect(projection.failedCriteria[0]).toBe('[repair-id] failed criterion-1')
  })

  it('strips rd-* routing decision IDs from evidence strings', () => {
    const failure: FailurePackage = {
      failedCriteria: [],
      failingTests: [],
      typeErrors: ['type error in rd-abc123 at line 10'],
      buildErrors: [],
      changedFiles: [],
    }
    const projection = projectFailureForModel(failure)
    expect(projection.typeErrors[0]).toBe('type error in [routing-decision] at line 10')
  })

  it('strips session-* IDs from evidence strings', () => {
    const failure: FailurePackage = {
      failedCriteria: [],
      failingTests: [],
      typeErrors: [],
      buildErrors: ['build failed in session-xyz789'],
      changedFiles: [],
    }
    const projection = projectFailureForModel(failure)
    expect(projection.buildErrors[0]).toBe('build failed in [session]')
  })

  it('strips multiple internal IDs from a single string', () => {
    const failure: FailurePackage = {
      failedCriteria: ['repair:v1:abc123 failed in rd-def456 under session-xyz789'],
      failingTests: [],
      typeErrors: [],
      buildErrors: [],
      changedFiles: [],
    }
    const projection = projectFailureForModel(failure)
    expect(projection.failedCriteria[0]).toBe(
      '[repair-id] failed in [routing-decision] under [session]',
    )
  })

  it('preserves diagnostic content when no internal IDs are present', () => {
    const failure: FailurePackage = {
      failedCriteria: ['function foo() does not return a Promise'],
      failingTests: ['test "should handle async" failed: expected Promise got undefined'],
      typeErrors: ['Type \'string\' is not assignable to type \'number\''],
      buildErrors: ['Cannot find module \'./foo\''],
      changedFiles: ['src/index.ts'],
    }
    const projection = projectFailureForModel(failure)
    expect(projection.failedCriteria[0]).toBe('function foo() does not return a Promise')
    expect(projection.failingTests[0]).toBe(
      'test "should handle async" failed: expected Promise got undefined',
    )
    expect(projection.typeErrors[0]).toBe('Type \'string\' is not assignable to type \'number\'')
    expect(projection.buildErrors[0]).toBe('Cannot find module \'./foo\'')
    expect(projection.changedFiles[0]).toBe('src/index.ts')
  })
})

describe('P1.5: projection is independent of original mutations', () => {
  it('mutating the original FailurePackage after projection does not affect the projection', () => {
    const failure: FailurePackage = {
      failedCriteria: ['criterion-1'],
      failingTests: [],
      typeErrors: [],
      buildErrors: [],
      changedFiles: ['src/foo.ts'],
    }
    const projection = projectFailureForModel(failure)

    // Mutate the original (cast to mutable for test purposes)
    const mutable = failure as unknown as { failedCriteria: string[]; changedFiles: string[] }
    mutable.failedCriteria.push('criterion-2')
    mutable.changedFiles.push('src/bar.ts')

    // The projection should be unaffected
    expect([...projection.failedCriteria]).toEqual(['criterion-1'])
    expect([...projection.changedFiles]).toEqual(['src/foo.ts'])
  })
})

describe('P1.10: secret redaction in model-visible projection', () => {
  it('redacts Authorization: Bearer tokens', () => {
    const failure: FailurePackage = {
      failedCriteria: ['Request failed: Authorization: Bearer abc123def456'],
      failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
    }
    const projection = projectFailureForModel(failure)
    expect(projection.failedCriteria[0]).not.toContain('abc123def456')
    expect(projection.failedCriteria[0]).toContain('[redacted]')
  })

  it('redacts OpenAI-style API keys (sk-...)', () => {
    const failure: FailurePackage = {
      failedCriteria: ['Error using key sk-proj1234567890abcdefghij'],
      failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
    }
    const projection = projectFailureForModel(failure)
    expect(projection.failedCriteria[0]).not.toContain('sk-proj1234567890abcdefghij')
    expect(projection.failedCriteria[0]).toContain('[api-key]')
  })

  it('redacts DEEPSEEK_API_KEY assignments', () => {
    const failure: FailurePackage = {
      failedCriteria: ['Config error: DEEPSEEK_API_KEY=sk-abcdef123456789'],
      failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
    }
    const projection = projectFailureForModel(failure)
    expect(projection.failedCriteria[0]).not.toContain('sk-abcdef123456789')
    expect(projection.failedCriteria[0]).toContain('[redacted]')
  })

  it('redacts database URLs with credentials', () => {
    const failure: FailurePackage = {
      failedCriteria: ['Connection failed: postgres://user:pass@host:5432/db'],
      failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
    }
    const projection = projectFailureForModel(failure)
    expect(projection.failedCriteria[0]).not.toContain('pass')
    expect(projection.failedCriteria[0]).toContain('[redacted]')
  })

  it('redacts AWS_SECRET_ACCESS_KEY assignments', () => {
    const failure: FailurePackage = {
      failedCriteria: ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
      failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
    }
    const projection = projectFailureForModel(failure)
    expect(projection.failedCriteria[0]).not.toContain('wJalrXUtnFEMI')
    expect(projection.failedCriteria[0]).toContain('[redacted]')
  })

  it('redacts AWS access key IDs (AKIA...)', () => {
    const failure: FailurePackage = {
      failedCriteria: ['Using AKIAIOSFODNN7EXAMPLE for authentication'],
      failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
    }
    const projection = projectFailureForModel(failure)
    expect(projection.failedCriteria[0]).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(projection.failedCriteria[0]).toContain('[aws-access-key]')
  })

  it('redacts password= assignments', () => {
    const failure: FailurePackage = {
      failedCriteria: ['DB error: password=supersecret123 connection refused'],
      failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
    }
    const projection = projectFailureForModel(failure)
    expect(projection.failedCriteria[0]).not.toContain('supersecret123')
    expect(projection.failedCriteria[0]).toContain('[redacted]')
  })

  it('redacts Cookie headers', () => {
    const failure: FailurePackage = {
      failedCriteria: ['Request header Cookie: sessionid=abc123; token=xyz789'],
      failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
    }
    const projection = projectFailureForModel(failure)
    expect(projection.failedCriteria[0]).not.toContain('sessionid=abc123')
    expect(projection.failedCriteria[0]).not.toContain('token=xyz789')
    expect(projection.failedCriteria[0]).toContain('[redacted]')
  })

  it('redacts JWT tokens', () => {
    const failure: FailurePackage = {
      failedCriteria: ['Auth failed with token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'],
      failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
    }
    const projection = projectFailureForModel(failure)
    expect(projection.failedCriteria[0]).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(projection.failedCriteria[0]).toContain('[jwt]')
  })

  it('redacts private host paths (.ssh)', () => {
    const failure: FailurePackage = {
      failedCriteria: ['Cannot read /Users/alice/.ssh/id_rsa'],
      failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
    }
    const projection = projectFailureForModel(failure)
    expect(projection.failedCriteria[0]).not.toContain('.ssh/id_rsa')
    expect(projection.failedCriteria[0]).toContain('[ssh-path]')
  })

  it('redacts .env file paths', () => {
    const failure: FailurePackage = {
      failedCriteria: ['Loaded config from /Users/bob/.env.production'],
      failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
    }
    const projection = projectFailureForModel(failure)
    expect(projection.failedCriteria[0]).not.toContain('.env.production')
    expect(projection.failedCriteria[0]).toContain('[env-file]')
  })

  it('redacts generic SECRET/TOKEN env assignments', () => {
    const failure: FailurePackage = {
      failedCriteria: ['Missing SECRET=abc123def456 in environment'],
      failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
    }
    const projection = projectFailureForModel(failure)
    expect(projection.failedCriteria[0]).not.toContain('abc123def456')
    expect(projection.failedCriteria[0]).toContain('[redacted]')
  })

  it('preserves diagnostic content when no secrets are present', () => {
    const failure: FailurePackage = {
      failedCriteria: ['function foo() does not return a Promise'],
      failingTests: ['test "should handle async" failed: expected Promise got undefined'],
      typeErrors: ['Type \'string\' is not assignable to type \'number\' in src/index.ts:42'],
      buildErrors: ['Cannot find module \'./foo\''],
      changedFiles: ['src/index.ts'],
    }
    const projection = projectFailureForModel(failure)
    expect(projection.failedCriteria[0]).toBe('function foo() does not return a Promise')
    expect(projection.failingTests[0]).toBe(
      'test "should handle async" failed: expected Promise got undefined',
    )
    expect(projection.typeErrors[0]).toBe(
      'Type \'string\' is not assignable to type \'number\' in src/index.ts:42',
    )
    expect(projection.buildErrors[0]).toBe('Cannot find module \'./foo\'')
  })

  it('original FailurePackage retains forensic evidence (not mutated by projection)', () => {
    const failure: FailurePackage = {
      failedCriteria: ['Authorization: Bearer secret_token_123'],
      failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
    }
    const projection = projectFailureForModel(failure)
    // Projection is redacted
    expect(projection.failedCriteria[0]).not.toContain('secret_token_123')
    // Original retains the secret for forensic purposes
    expect(failure.failedCriteria[0]).toContain('secret_token_123')
  })

  it('redacts multiple secrets in a single string', () => {
    const failure: FailurePackage = {
      failedCriteria: ['Config: DEEPSEEK_API_KEY=sk-abc123 and AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
      failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
    }
    const projection = projectFailureForModel(failure)
    expect(projection.failedCriteria[0]).not.toContain('sk-abc123')
    expect(projection.failedCriteria[0]).not.toContain('wJalrXUtnFEMI')
    expect(projection.failedCriteria[0]).toContain('[redacted]')
  })

  it('sanitizes testDetails assertionDiff', () => {
    const failure: FailurePackage = {
      failedCriteria: [], failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
      testDetails: [{ testName: 'should authenticate', assertionDiff: 'Authorization: Bearer sk-secret123' }],
    }
    const projection = projectFailureForModel(failure)
    expect(projection.testDetails).toBeDefined()
    const detail = projection.testDetails?.[0]
    expect(detail).toBeDefined()
    expect(detail?.assertionDiff).not.toContain('sk-secret123')
    expect(detail?.assertionDiff).toContain('[redacted]')
    // Original retains the secret
    expect(failure.testDetails?.[0]?.assertionDiff).toContain('sk-secret123')
  })

  it('sanitizes buildDetails message', () => {
    const failure: FailurePackage = {
      failedCriteria: [], failingTests: [], typeErrors: [], buildErrors: [], changedFiles: [],
      buildDetails: [{ file: 'src/config.ts', line: 42, message: 'DEEPSEEK_API_KEY=sk-leaked-key' }],
    }
    const projection = projectFailureForModel(failure)
    expect(projection.buildDetails).toBeDefined()
    const detail = projection.buildDetails?.[0]
    expect(detail).toBeDefined()
    expect(detail?.message).not.toContain('sk-leaked-key')
    expect(detail?.message).toContain('[redacted]')
    // Original retains the secret
    expect(failure.buildDetails?.[0]?.message).toContain('sk-leaked-key')
  })
})
