import { hashCanonical } from './canonical.js'
import type { AcceptanceContract, AcceptancePackFactory } from './types.js'

/**
 * Immutable-identity registry for acceptance packs.
 * Promotion and receipts can bind to this fingerprint so a calibrated pack
 * cannot be silently swapped for a different implementation/version.
 */
export class AcceptancePackRegistry {
  private readonly factories = new Map<string, AcceptancePackFactory<any>>()

  register<TOptions>(factory: AcceptancePackFactory<TOptions>): () => void {
    if (!factory.id.trim()) throw new Error('acceptance pack id must be non-empty')
    if (!factory.version.trim()) throw new Error(`acceptance pack ${factory.id} version must be non-empty`)
    const key = this.key(factory.id, factory.version)
    if (this.factories.has(key)) throw new Error(`acceptance pack already registered: ${key}`)
    this.factories.set(key, factory)
    return () => { this.factories.delete(key) }
  }

  resolve<TOptions = unknown>(id: string, version: string): AcceptancePackFactory<TOptions> {
    const value = this.factories.get(this.key(id, version))
    if (!value) throw new Error(`acceptance pack is not registered: ${id}@${version}`)
    return value as AcceptancePackFactory<TOptions>
  }

  latest<TOptions = unknown>(id: string): AcceptancePackFactory<TOptions> {
    const candidates = [...this.factories.values()].filter(row => row.id === id)
    if (candidates.length === 0) throw new Error(`acceptance pack is not registered: ${id}`)
    candidates.sort((a, b) => compareVersions(a.version, b.version))
    return candidates.at(-1)! as AcceptancePackFactory<TOptions>
  }

  create<TOptions>(id: string, version: string, input: Parameters<AcceptancePackFactory<TOptions>['create']>[0], options?: TOptions): AcceptanceContract {
    const contract = this.resolve<TOptions>(id, version).create(input, options)
    if (contract.pack?.id !== id || contract.pack.version !== version) {
      throw new Error(`acceptance pack ${id}@${version} produced contract with mismatched descriptor`)
    }
    return contract
  }

  list(): readonly { readonly id: string; readonly version: string }[] {
    return [...this.factories.values()]
      .map(row => ({ id: row.id, version: row.version }))
      .sort((a, b) => a.id.localeCompare(b.id) || compareVersions(a.version, b.version))
  }

  fingerprint(): string {
    return hashCanonical(this.list())
  }

  private key(id: string, version: string): string { return `${id}@${version}` }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(part => Number.parseInt(part, 10))
  const pb = b.split('.').map(part => Number.parseInt(part, 10))
  if (pa.every(Number.isFinite) && pb.every(Number.isFinite)) {
    const width = Math.max(pa.length, pb.length)
    for (let index = 0; index < width; index += 1) {
      const delta = (pa[index] ?? 0) - (pb[index] ?? 0)
      if (delta !== 0) return delta
    }
    return 0
  }
  return a.localeCompare(b)
}
