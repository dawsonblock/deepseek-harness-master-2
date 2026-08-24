import type { EvidenceEdge } from './types.js'

export class EvidenceGraph {
  private readonly edges: EvidenceEdge[] = []

  add(edge: EvidenceEdge): void {
    if (!edge.from || !edge.to) throw new Error('evidence edge endpoints must be non-empty')
    if (this.edges.some(item => item.from === edge.from && item.to === edge.to && item.relation === edge.relation)) return
    this.edges.push(Object.freeze({ ...edge }))
  }

  all(): readonly EvidenceEdge[] { return [...this.edges] }
  incoming(node: string): readonly EvidenceEdge[] { return this.edges.filter(edge => edge.to === node) }
  outgoing(node: string): readonly EvidenceEdge[] { return this.edges.filter(edge => edge.from === node) }
  contradictions(node: string): readonly EvidenceEdge[] { return this.edges.filter(edge => edge.relation === 'contradicts' && (edge.to === node || edge.from === node)) }

  hasContradiction(node: string): boolean { return this.contradictions(node).length > 0 }
}
