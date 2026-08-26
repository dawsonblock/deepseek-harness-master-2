/**
 * Repair state machine: defines legal states and transitions for the
 * v0.18 repair sequence. Disallows impossible transitions such as
 * COMPLETE → FLASH_REPAIR, STOP → PRO, or VERIFYING → VERIFYING.
 *
 * @module @deepseek-ai/dsh-repair-controller/state-machine
 */

/** Legal states in the repair state machine. */
export type RepairState =
  | 'INITIAL'
  | 'FLASH_RUNNING'
  | 'PRO_RUNNING'
  | 'VERIFYING'
  | 'REPAIR_DECISION'
  | 'COMPLETE'
  | 'STOP'

/** Legal state transitions. Keys are source states; values are allowed targets. */
const LEGAL_TRANSITIONS: Readonly<Record<RepairState, readonly RepairState[]>> = {
  INITIAL: ['FLASH_RUNNING'],
  FLASH_RUNNING: ['VERIFYING'],
  PRO_RUNNING: ['VERIFYING'],
  VERIFYING: ['COMPLETE', 'REPAIR_DECISION'],
  REPAIR_DECISION: ['FLASH_RUNNING', 'PRO_RUNNING', 'STOP'],
  COMPLETE: [],
  STOP: [],
}

/**
 * Check whether a transition from one state to another is legal.
 * @param from - the source state.
 * @param to - the target state.
 * @returns true if the transition is allowed by the state machine.
 */
export function isLegalTransition(from: RepairState, to: RepairState): boolean {
  const allowed = LEGAL_TRANSITIONS[from]
  return allowed !== undefined && allowed.includes(to)
}

/**
 * Assert a state transition is legal. Throws if the transition is not
 * allowed by the state machine.
 * @param from - the source state.
 * @param to - the target state.
 */
export function assertLegalTransition(from: RepairState, to: RepairState): void {
  if (!isLegalTransition(from, to)) {
    throw new Error(`Illegal repair state transition: ${from} → ${to}`)
  }
}

/**
 * Derive the next state from a repair decision action.
 * @param action - the decision action from RepairController.decide().
 * @returns the state the machine should transition to.
 */
export function stateFromDecision(action: 'complete' | 'flash-repair' | 'pro-escalate' | 'stop'): RepairState {
  switch (action) {
    case 'complete': return 'COMPLETE'
    case 'flash-repair': return 'FLASH_RUNNING'
    case 'pro-escalate': return 'PRO_RUNNING'
    case 'stop': return 'STOP'
  }
}
