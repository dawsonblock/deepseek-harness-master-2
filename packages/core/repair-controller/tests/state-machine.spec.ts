/**
 * State machine invariant tests for the repair controller.
 *
 * @module @deepseek-ai/dsh-repair-controller/tests/state-machine.spec
 */

import { describe, expect, it } from 'vitest'
import { assertLegalTransition, isLegalTransition, stateFromDecision } from '../src/state-machine.ts'
import type { RepairState } from '../src/state-machine.ts'

describe('repair state machine — legal transitions', () => {
  it('INITIAL → FLASH_RUNNING is legal', () => {
    expect(isLegalTransition('INITIAL', 'FLASH_RUNNING')).toBe(true)
  })

  it('FLASH_RUNNING → VERIFYING is legal', () => {
    expect(isLegalTransition('FLASH_RUNNING', 'VERIFYING')).toBe(true)
  })

  it('PRO_RUNNING → VERIFYING is legal', () => {
    expect(isLegalTransition('PRO_RUNNING', 'VERIFYING')).toBe(true)
  })

  it('VERIFYING → COMPLETE is legal', () => {
    expect(isLegalTransition('VERIFYING', 'COMPLETE')).toBe(true)
  })

  it('VERIFYING → REPAIR_DECISION is legal', () => {
    expect(isLegalTransition('VERIFYING', 'REPAIR_DECISION')).toBe(true)
  })

  it('REPAIR_DECISION → FLASH_RUNNING is legal', () => {
    expect(isLegalTransition('REPAIR_DECISION', 'FLASH_RUNNING')).toBe(true)
  })

  it('REPAIR_DECISION → PRO_RUNNING is legal', () => {
    expect(isLegalTransition('REPAIR_DECISION', 'PRO_RUNNING')).toBe(true)
  })

  it('REPAIR_DECISION → STOP is legal', () => {
    expect(isLegalTransition('REPAIR_DECISION', 'STOP')).toBe(true)
  })
})

describe('repair state machine — illegal transitions', () => {
  it('COMPLETE → FLASH_RUNNING is illegal', () => {
    expect(isLegalTransition('COMPLETE', 'FLASH_RUNNING')).toBe(false)
  })

  it('STOP → PRO_RUNNING is illegal', () => {
    expect(isLegalTransition('STOP', 'PRO_RUNNING')).toBe(false)
  })

  it('VERIFYING → VERIFYING is illegal', () => {
    expect(isLegalTransition('VERIFYING', 'VERIFYING')).toBe(false)
  })

  it('INITIAL → PRO_RUNNING is illegal', () => {
    expect(isLegalTransition('INITIAL', 'PRO_RUNNING')).toBe(false)
  })

  it('COMPLETE → STOP is illegal', () => {
    expect(isLegalTransition('COMPLETE', 'STOP')).toBe(false)
  })

  it('STOP → COMPLETE is illegal', () => {
    expect(isLegalTransition('STOP', 'COMPLETE')).toBe(false)
  })

  it('FLASH_RUNNING → PRO_RUNNING is illegal (must go through VERIFYING)', () => {
    expect(isLegalTransition('FLASH_RUNNING', 'PRO_RUNNING')).toBe(false)
  })
})

describe('assertLegalTransition', () => {
  it('does not throw for legal transitions', () => {
    expect(() => assertLegalTransition('INITIAL', 'FLASH_RUNNING')).not.toThrow()
  })

  it('throws for illegal transitions', () => {
    expect(() => assertLegalTransition('COMPLETE', 'FLASH_RUNNING')).toThrow(
      'Illegal repair state transition: COMPLETE → FLASH_RUNNING',
    )
  })
})

describe('stateFromDecision', () => {
  it('complete → COMPLETE', () => {
    expect(stateFromDecision('complete')).toBe('COMPLETE')
  })

  it('flash-repair → FLASH_RUNNING', () => {
    expect(stateFromDecision('flash-repair')).toBe('FLASH_RUNNING')
  })

  it('pro-escalate → PRO_RUNNING', () => {
    expect(stateFromDecision('pro-escalate')).toBe('PRO_RUNNING')
  })

  it('stop → STOP', () => {
    expect(stateFromDecision('stop')).toBe('STOP')
  })
})

describe('full state machine trajectory', () => {
  it('Flash pass trajectory: INITIAL → FLASH → VERIFY → COMPLETE', () => {
    const states: RepairState[] = ['INITIAL', 'FLASH_RUNNING', 'VERIFYING', 'COMPLETE']
    for (let i = 0; i < states.length - 1; i++) {
      expect(isLegalTransition(states[i]!, states[i + 1]!)).toBe(true)
    }
  })

  it('Flash fail → Pro trajectory: INITIAL → FLASH → VERIFY → DECISION → PRO → VERIFY → COMPLETE', () => {
    const states: RepairState[] = [
      'INITIAL', 'FLASH_RUNNING', 'VERIFYING', 'REPAIR_DECISION',
      'PRO_RUNNING', 'VERIFYING', 'COMPLETE',
    ]
    for (let i = 0; i < states.length - 1; i++) {
      expect(isLegalTransition(states[i]!, states[i + 1]!)).toBe(true)
    }
  })

  it('Stop trajectory: INITIAL → FLASH → VERIFY → DECISION → STOP', () => {
    const states: RepairState[] = [
      'INITIAL', 'FLASH_RUNNING', 'VERIFYING', 'REPAIR_DECISION', 'STOP',
    ]
    for (let i = 0; i < states.length - 1; i++) {
      expect(isLegalTransition(states[i]!, states[i + 1]!)).toBe(true)
    }
  })
})
