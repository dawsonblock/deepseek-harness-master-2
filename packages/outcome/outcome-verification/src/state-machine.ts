import type { OutcomeReceipt } from './types.js'

export type OutcomePhase = 'active' | 'candidate-complete' | 'verifying' | 'verified' | 'committed-complete' | 'blocked'

export interface OutcomeState {
  readonly phase: OutcomePhase
  readonly revision: number
  readonly receipt?: OutcomeReceipt
  readonly reason?: string
}

export class OutcomeStateMachine {
  private stateValue: OutcomeState = Object.freeze({ phase: 'active', revision: 1 })

  get state(): OutcomeState { return this.stateValue }

  candidate(): OutcomeState { return this.transition(['active'], 'candidate-complete') }
  beginVerification(): OutcomeState { return this.transition(['candidate-complete'], 'verifying') }
  verificationFailed(reason: string): OutcomeState {
    if (this.stateValue.phase !== 'verifying') throw new Error(`cannot fail verification from ${this.stateValue.phase}`)
    this.stateValue = Object.freeze({ phase: 'active', revision: this.stateValue.revision + 1, reason })
    return this.stateValue
  }
  verificationBlocked(reason: string): OutcomeState {
    if (this.stateValue.phase !== 'verifying') throw new Error(`cannot block verification from ${this.stateValue.phase}`)
    this.stateValue = Object.freeze({ phase: 'blocked', revision: this.stateValue.revision + 1, reason })
    return this.stateValue
  }
  verified(receipt: OutcomeReceipt): OutcomeState {
    if (this.stateValue.phase !== 'verifying') throw new Error(`cannot verify from ${this.stateValue.phase}`)
    this.stateValue = Object.freeze({ phase: 'verified', revision: this.stateValue.revision + 1, receipt })
    return this.stateValue
  }
  commit(receiptHash: string): OutcomeState {
    if (this.stateValue.phase !== 'verified' || !this.stateValue.receipt) throw new Error('completion requires verified outcome receipt')
    if (this.stateValue.receipt.receiptHash !== receiptHash) throw new Error('receipt hash does not match verified outcome')
    this.stateValue = Object.freeze({ phase: 'committed-complete', revision: this.stateValue.revision + 1, receipt: this.stateValue.receipt })
    return this.stateValue
  }
  reopen(reason: string): OutcomeState {
    if (!['blocked','verified','committed-complete'].includes(this.stateValue.phase)) throw new Error(`cannot reopen from ${this.stateValue.phase}`)
    this.stateValue = Object.freeze({ phase: 'active', revision: this.stateValue.revision + 1, reason })
    return this.stateValue
  }

  private transition(from: readonly OutcomePhase[], to: OutcomePhase): OutcomeState {
    if (!from.includes(this.stateValue.phase)) throw new Error(`invalid outcome transition ${this.stateValue.phase} -> ${to}`)
    this.stateValue = Object.freeze({ phase: to, revision: this.stateValue.revision + 1 })
    return this.stateValue
  }
}
