import { hashCanonical } from './canonical.js'
import type { VerifierDefinition } from './types.js'

export class VerifierRegistry {
  private readonly verifiers = new Map<string, VerifierDefinition>()

  register(verifier: VerifierDefinition): () => void {
    const id = verifier.id.trim()
    const version = verifier.version.trim()
    if (!id || !version) throw new Error('verifier id and version must be non-empty')
    if (this.verifiers.has(id)) throw new Error(`verifier already registered: ${id}`)
    const normalized: VerifierDefinition = { ...verifier, id, version }
    this.verifiers.set(id, normalized)
    return () => { if (this.verifiers.get(id) === normalized) this.verifiers.delete(id) }
  }

  resolve(id: string, version?: string): VerifierDefinition {
    const verifier = this.verifiers.get(id)
    if (!verifier) throw new Error(`unknown verifier: ${id}`)
    if (version !== undefined && verifier.version !== version) {
      throw new Error(`verifier ${id} version mismatch: contract=${version} runtime=${verifier.version}`)
    }
    return verifier
  }

  definitions(): readonly VerifierDefinition[] {
    return [...this.verifiers.values()].sort((a, b) => a.id.localeCompare(b.id))
  }

  fingerprint(): string {
    return hashCanonical(this.definitions().map(verifier => ({
      id: verifier.id,
      version: verifier.version,
      category: verifier.category,
      deterministic: verifier.deterministic,
    })))
  }
}
