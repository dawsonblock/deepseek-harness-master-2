import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { CallId, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { clearExplicitModelSelection, installModelSelection, markExplicitModelSelection } from '@deepseek-ai/dsh-agent'
import type { Fiber } from '@deepseek-ai/cordis'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, LlmCallConfig, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { claimModelSelection, reconstructSelectionState, releaseToAuto } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as router from '../src/index.ts'

const FAST = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
const HEAVY = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }

function resolvedConfig(overrides: Partial<router.ModelRouterConfig> = {}): router.ModelRouterConfig {
  return {
    fastRoute: FAST,
    heavyRoute: HEAVY,
    escalationThreshold: 4,
    ...overrides,
  }
}

/** Recording adapter: answers text and records every request's provider/model. */
class RecordingAdapter extends LlmAdapter {
  readonly requests: Array<{ provider: string; model: string }> = []
  private readonly scripts: Array<StreamChunk[] | 'tool-call'> = []

  constructor(scripts: Array<StreamChunk[] | 'tool-call'> = []) {
    super()
    this.scripts.push(...scripts)
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push({ provider: options.provider, model: options.model })
    const script = this.scripts.shift() ?? [
      { type: 'block-start' as const, index: 0, blockType: 'text' as const },
      { type: 'text-delta' as const, index: 0, text: 'ok' },
      { type: 'block-end' as const, index: 0, block: { type: 'text' as const, text: 'ok' } },
      { type: 'finish' as const, reason: { kind: 'stop' as const } },
    ]
    if (script === 'tool-call') {
      const id = CallId('call-1')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'probe', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'probe', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield* script
  }
}

async function harness(
  adapter: RecordingAdapter,
  config: router.ModelRouterConfig = resolvedConfig(),
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  routerFiber = await ctx.plugin(Object.assign((inner: Context) => {
    router.apply(inner, config)
  }, { inject: router.inject }))
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['deepseek-official', 'other'], adapter)
  return ctx
}

let context: Context | undefined
let routerFiber: Fiber | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  routerFiber = undefined
})

describe('scoreComplexity calibration', () => {
  it('keeps every family cap strictly below the default threshold', () => {
    expect(router.noFamilyAloneReaches(router.DEFAULT_ESCALATION_THRESHOLD)).toBe(true)
  })

  it('scores an empty or trivial prompt at zero', () => {
    expect(router.scoreComplexity('').score).toBe(0)
    expect(router.scoreComplexity('list the files here').score).toBe(0)
  })

  it('the audit table: no single family escalates alone', () => {
    // Every row the external audit executed against the v0.15.0 scorer.
    expect(router.scoreComplexity('Fix the race condition in the scheduler.').score).toBe(0)
    expect(router.scoreComplexity('Refactor the distributed architecture.').score).toBe(3)
    expect(router.scoreComplexity('Prove the theorem.').score).toBe(2)
    expect(router.scoreComplexity('Think step by step about this.').score).toBe(3)
    expect(router.scoreComplexity('x'.repeat(1600)).score).toBe(2)
    expect(router.scoreComplexity('复杂并发请求，请修复调度器竞态').score).toBe(2)
  })

  it('corroboration across families escalates', () => {
    expect(router.scoreComplexity('Prove the theorem. Think step by step.').score).toBe(5)
    expect(router.scoreComplexity('深入思考，证明这个定理').score).toBe(5)
    expect(router.scoreComplexity('Refactor the distributed architecture. Think step by step.').score).toBe(6)
  })

  it('caps every signal family', () => {
    const spam = 'prove '.repeat(45).trim()
    const reading = router.scoreComplexity(spam)
    expect(reading.signals.mathMarkers).toBe(45)
    expect(reading.score).toBe(3)
  })

  it('counts multilingual markers and honors configured vocabulary', () => {
    const zh = router.scoreComplexity('请一步步深入思考，证明该定理并推导公式')
    expect(zh.signals.explicitReasoningRequests).toBeGreaterThanOrEqual(2)
    expect(zh.signals.mathMarkers).toBeGreaterThanOrEqual(2)
    const custom = router.scoreComplexity('bewijs deze stelling', { math: ['bewijs', 'stelling'] })
    expect(custom.signals.mathMarkers).toBe(2)
  })

  it('long trivial input cannot escalate: length cap alone stays below threshold', () => {
    expect(router.scoreComplexity('x'.repeat(10_000)).score).toBe(2)
  })
})

describe('turnUserText', () => {
  function turnEvent(turn: number): SessionEvent {
    return { type: 'turn/start', seq: turn * 10, time: 0, data: { turn } }
  }

  function userEvent(
    seq: number,
    text: string,
    source:
      | { kind: 'user' }
      | { kind: 'plugin'; plugin: string }
      | { kind: 'coordinator'; form: 'relay'; senderSessionId: SessionId },
  ): SessionEvent {
    return {
      type: 'user/message',
      seq,
      time: 0,
      data: createUserMessage({ content: [{ type: 'text', text }], source }),
      surfaceOp: 'append',
    }
  }

  it('collects user and coordinator requests, excluding plugin injections and other turns', () => {
    const events: SessionEvent[] = [
      turnEvent(1),
      userEvent(1, 'first human line', { kind: 'user' }),
      userEvent(2, 'plugin injection', { kind: 'plugin', plugin: 'time-context' }),
      userEvent(3, 'parent delegation', { kind: 'coordinator', form: 'relay', senderSessionId: SessionId('parent') }),
      turnEvent(2),
      userEvent(4, 'second turn text', { kind: 'user' }),
    ]
    expect(router.turnUserText(events, 1)).toBe('first human line\nparent delegation')
    expect(router.turnUserText(events, 2)).toBe('second turn text')
    expect(router.turnUserText(events, 3)).toBe('')
  })
})

describe('turnDiscoveredFacts', () => {
  it('counts tool calls and tool-result volume inside one turn only', () => {
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } },
      { type: 'tool/call', seq: 2, time: 0, data: { turn: 1, step: 1, callId: CallId('a'), name: 'a', arguments: '{}' } },
      {
        type: 'tool/result',
        seq: 3,
        time: 0,
        data: { turn: 1, step: 1, message: { role: 'tool', id: 'x', content: [{ type: 'text', text: 'x'.repeat(30) }], source: { kind: 'tool', callId: CallId('a') } } },
        surfaceOp: 'append',
      },
      { type: 'turn/start', seq: 4, time: 0, data: { turn: 2 } },
      { type: 'tool/call', seq: 5, time: 0, data: { turn: 2, step: 1, callId: CallId('b'), name: 'b', arguments: '{}' } },
    ]
    expect(router.turnDiscoveredFacts(events, 1)).toEqual({ toolCalls: 1, toolResultChars: 30 })
    expect(router.turnDiscoveredFacts(events, 2)).toEqual({ toolCalls: 1, toolResultChars: 0 })
  })
})

describe('resolveConfig', () => {
  it('rejects identical tiers, empty fields, and bad thresholds', () => {
    expect(() => router.resolveConfig({ fastRoute: FAST, heavyRoute: FAST })).toThrow('different provider/model')
    expect(() => router.resolveConfig({
      fastRoute: { provider: '', model: 'm' },
      heavyRoute: HEAVY,
    })).toThrow('non-empty')
    expect(() => router.resolveConfig({ ...resolvedConfig(), escalationThreshold: 0 })).toThrow('positive safe integer')
    expect(() => router.resolveConfig({ ...resolvedConfig(), escalationThreshold: 1.5 })).toThrow('positive safe integer')
  })

  it('defaults the threshold, subagent policy, and discovered escalation', () => {
    const resolved = router.resolveConfig({ fastRoute: FAST, heavyRoute: HEAVY })
    expect(resolved.escalationThreshold).toBe(router.DEFAULT_ESCALATION_THRESHOLD)
    expect(resolved.routeSubagents).toBe(false)
    expect(resolved.discoveredEscalation).toEqual({ minToolCalls: router.DEFAULT_MIN_TOOL_CALLS, minToolResultChars: router.DEFAULT_MIN_TOOL_RESULT_CHARS })
    expect(resolved.recordAllDecisions).toBe(false)
  })

  it('rejects empty configured markers and non-positive discovered bounds', () => {
    expect(() => router.resolveConfig({ ...resolvedConfig(), extraMarkers: { math: [''] } })).toThrow('empty markers')
    expect(() => router.resolveConfig({ ...resolvedConfig(), discoveredEscalation: { minToolCalls: 0 } })).toThrow('positive safe integer')
  })

  it('rejects thresholds that let one signal family escalate alone (audit Phase 5)', () => {
    for (const threshold of [1, 2, 3]) {
      expect(() => router.resolveConfig({ ...resolvedConfig(), escalationThreshold: threshold }))
        .toThrow('cross-family corroboration policy')
    }
    for (const threshold of [4, 5, 9]) {
      expect(router.resolveConfig({ ...resolvedConfig(), escalationThreshold: threshold }).escalationThreshold).toBe(threshold)
    }
  })

  it('rejects configured markers that fake signal independence (audit Phase 6)', () => {
    // Cross-family duplicate among configured markers — including after
    // normalization (trim + case + NFC).
    expect(() => router.resolveConfig({
      ...resolvedConfig(),
      extraMarkers: { reasoning: ['difficult'], math: ['difficult'] },
    })).toThrow('fake evidence')
    expect(() => router.resolveConfig({
      ...resolvedConfig(),
      extraMarkers: { reasoning: ['Difficult '], math: ['  DIFFICULT'] },
    })).toThrow('fake evidence')
    // Intra-family duplicate after normalization double-counts one marker.
    expect(() => router.resolveConfig({
      ...resolvedConfig(),
      extraMarkers: { math: ['stelling', 'Stelling'] },
    })).toThrow('counts once')
    // A configured marker colliding with a built-in vocabulary in ANOTHER
    // family fakes cross-family corroboration.
    expect(() => router.resolveConfig({
      ...resolvedConfig(),
      extraMarkers: { reasoning: ['架构'] },
    })).toThrow('built-in architecture')
    // A configured marker colliding with its OWN family's built-ins
    // double-counts beside them.
    expect(() => router.resolveConfig({
      ...resolvedConfig(),
      extraMarkers: { math: ['prove'] },
    })).toThrow('double-count')
    expect(() => router.resolveConfig({
      ...resolvedConfig(),
      extraMarkers: { reasoning: ['深入思考'] },
    })).toThrow('double-count')
    // Genuinely new markers still pass.
    expect(() => router.resolveConfig({
      ...resolvedConfig(),
      extraMarkers: { math: ['bewijs'], architecture: ['systeem'] },
    })).not.toThrow()
  })
})

describe('decideRoute', () => {
  const config = router.resolveConfig(resolvedConfig())
  const proposal = (model: string, extra: Partial<LlmCallConfig> = {}): LlmCallConfig => ({
    provider: 'deepseek-official',
    model,
    ...extra,
  })
  const factsOf = (userText: string, discovered: router.DiscoveredFacts = { toolCalls: 0, toolResultChars: 0 }) => ({
    userText: () => userText,
    discovered: () => discovered,
  })

  it('an explicit selection mark owns the session in both directions', () => {
    const flashKept = router.decideRoute({
      proposed: proposal('deepseek-v4-flash'),
      explicitSelection: true,
      isSubagent: false,
      turn: 1,
      step: 1,
      facts: factsOf('Prove the theorem. Think step by step.'),
      memory: undefined,
      config,
    })
    expect(flashKept.reason).toBe('explicit-selection-passthrough')
    expect(flashKept.config.model).toBe('deepseek-v4-flash')
    const heavyKept = router.decideRoute({
      proposed: proposal('deepseek-v4-pro'),
      explicitSelection: true,
      isSubagent: false,
      turn: 1,
      step: 1,
      facts: factsOf('hi'),
      memory: undefined,
      config,
    })
    expect(heavyKept.reason).toBe('explicit-selection-passthrough')
    expect(heavyKept.config.model).toBe('deepseek-v4-pro')
  })

  it('THE AUDIT BUG: explicit heavy after router-owned heavy is never downgraded', () => {
    // Turn 1: router escalates a complex prompt and owns the decision.
    const escalated = router.decideRoute({
      proposed: proposal('deepseek-v4-flash'),
      explicitSelection: false,
      isSubagent: false,
      turn: 1,
      step: 1,
      facts: factsOf('Prove the theorem. Think step by step.'),
      memory: undefined,
      config,
    })
    expect(escalated.config.model).toBe('deepseek-v4-pro')

    // Turn 2: the operator EXPLICITLY selects Pro (a live mark exists).
    const explicit = router.decideRoute({
      proposed: proposal('deepseek-v4-pro'),
      explicitSelection: true,
      isSubagent: false,
      turn: 2,
      step: 1,
      facts: factsOf('thanks — just list the files'),
      memory: escalated.memory,
      config,
    })
    expect(explicit.config.model).toBe('deepseek-v4-pro')
    expect(explicit.reason).toBe('explicit-selection-passthrough')

    // Turn 2 without a live mark but with a field-changed proposal (a
    // selection mechanism rewrote the config): still never downgraded.
    const rewritten = router.decideRoute({
      proposed: proposal('deepseek-v4-pro', { temperature: 0.2 }),
      explicitSelection: false,
      isSubagent: false,
      turn: 2,
      step: 1,
      facts: factsOf('thanks — just list the files'),
      memory: escalated.memory,
      config,
    })
    expect(rewritten.config.model).toBe('deepseek-v4-pro')
    expect(rewritten.reason).toBe('explicit-heavy-retained')
  })

  it('a router-owned heavy continuation IS re-scored on the next turn', () => {
    const escalated = router.decideRoute({
      proposed: proposal('deepseek-v4-flash'),
      explicitSelection: false,
      isSubagent: false,
      turn: 1,
      step: 1,
      facts: factsOf('Prove the theorem. Think step by step.'),
      memory: undefined,
      config,
    })
    const next = router.decideRoute({
      proposed: escalated.config,
      explicitSelection: false,
      isSubagent: false,
      turn: 2,
      step: 1,
      facts: factsOf('thanks — just list the files'),
      memory: escalated.memory,
      config,
    })
    expect(next.config.model).toBe('deepseek-v4-flash')
    expect(next.reason).toBe('routed-fast')
  })

  it('subagents pass through unless configured; coordinator text scores when routed', () => {
    const passthrough = router.decideRoute({
      proposed: proposal('deepseek-v4-flash'),
      explicitSelection: false,
      isSubagent: true,
      turn: 1,
      step: 1,
      facts: factsOf('prove the theorem'),
      memory: undefined,
      config,
    })
    expect(passthrough.reason).toBe('subagent-passthrough')
    const routed = router.decideRoute({
      proposed: proposal('deepseek-v4-flash'),
      explicitSelection: false,
      isSubagent: true,
      turn: 1,
      step: 1,
      facts: factsOf('深入思考，证明该定理并推导公式'),
      memory: undefined,
      config: router.resolveConfig(resolvedConfig({ routeSubagents: true })),
    })
    expect(routed.config.model).toBe('deepseek-v4-pro')
  })

  it('mid-turn: heavy is never downgraded; fast escalates once on discovered complexity', () => {
    const fastTurn = router.decideRoute({
      proposed: proposal('deepseek-v4-flash'),
      explicitSelection: false,
      isSubagent: false,
      turn: 1,
      step: 1,
      facts: factsOf('Fix the race condition in the scheduler.'),
      memory: undefined,
      config,
    })
    expect(fastTurn.config.model).toBe('deepseek-v4-flash')

    // Quiet later step: route retained, facts not even needed for heavy.
    const quiet = router.decideRoute({
      proposed: proposal('deepseek-v4-flash'),
      explicitSelection: false,
      isSubagent: false,
      turn: 1,
      step: 2,
      facts: factsOf('', { toolCalls: 1, toolResultChars: 100 }),
      memory: fastTurn.memory,
      config,
    })
    expect(quiet.reason).toBe('turn-route-retained')

    // Discovered complexity mid-turn: one-way escalation to heavy.
    const discovered = router.decideRoute({
      proposed: proposal('deepseek-v4-flash'),
      explicitSelection: false,
      isSubagent: false,
      turn: 1,
      step: 3,
      facts: factsOf('', { toolCalls: router.DEFAULT_MIN_TOOL_CALLS, toolResultChars: 0 }),
      memory: fastTurn.memory,
      config,
    })
    expect(discovered.config.model).toBe('deepseek-v4-pro')
    expect(discovered.reason).toBe('mid-turn-escalated')

    // After escalation the turn stays heavy regardless of later facts.
    const staysHeavy = router.decideRoute({
      proposed: proposal('deepseek-v4-pro'),
      explicitSelection: false,
      isSubagent: false,
      turn: 1,
      step: 4,
      facts: factsOf('', { toolCalls: 0, toolResultChars: 0 }),
      memory: discovered.memory,
      config,
    })
    expect(staysHeavy.config.model).toBe('deepseek-v4-pro')
  })

  it('mid-turn escalation can be disabled', () => {
    const fastTurn = router.decideRoute({
      proposed: proposal('deepseek-v4-flash'),
      explicitSelection: false,
      isSubagent: false,
      turn: 1,
      step: 1,
      facts: factsOf('list files'),
      memory: undefined,
      config,
    })
    const off = router.resolveConfig(resolvedConfig({ discoveredEscalation: false }))
    const retained = router.decideRoute({
      proposed: proposal('deepseek-v4-flash'),
      explicitSelection: false,
      isSubagent: false,
      turn: 1,
      step: 3,
      facts: factsOf('', { toolCalls: 50, toolResultChars: 100_000 }),
      memory: fastTurn.memory,
      config: off,
    })
    expect(retained.config.model).toBe('deepseek-v4-flash')
    expect(retained.reason).toBe('turn-route-retained')
  })

  it('facts are lazy: request text is never read by passthrough or retention', () => {
    const explode: () => string = () => { throw new Error('facts must stay lazy') }
    const noText = { userText: explode, discovered: () => ({ toolCalls: 0, toolResultChars: 0 }) }
    const foreign = proposal('other-model')
    expect(router.decideRoute({
      proposed: foreign,
      explicitSelection: false,
      isSubagent: false,
      turn: 1,
      step: 1,
      facts: noText,
      memory: undefined,
      config,
    }).config).toBe(foreign)
    const fastTurn = router.decideRoute({
      proposed: proposal('deepseek-v4-flash'),
      explicitSelection: false,
      isSubagent: false,
      turn: 1,
      step: 1,
      facts: factsOf('hi'),
      memory: undefined,
      config,
    })
    // Retention measures discovered facts (that is how mid-turn escalation
    // works) but never re-reads the turn's request text.
    expect(router.decideRoute({
      proposed: proposal('deepseek-v4-flash'),
      explicitSelection: false,
      isSubagent: false,
      turn: 1,
      step: 5,
      facts: noText,
      memory: fastTurn.memory,
      config,
    }).reason).toBe('turn-route-retained')
  })

  it('applies the tier reasoning effort and drops the previous model effort', () => {
    const withEffort = router.resolveConfig(resolvedConfig({
      heavyRoute: { ...HEAVY, reasoningEffort: 'max' },
    }))
    const decision = router.decideRoute({
      proposed: proposal('deepseek-v4-flash', { reasoningEffort: 'low' as never, temperature: 0.7 }),
      explicitSelection: false,
      isSubagent: false,
      turn: 1,
      step: 1,
      facts: factsOf('Prove the theorem. Think step by step.'),
      memory: undefined,
      config: withEffort,
    })
    expect(decision.config.model).toBe('deepseek-v4-pro')
    expect(decision.config.reasoningEffort).toBe('max')
    expect(decision.config.temperature).toBe(0.7)
  })

  it('emits durable records for ownership changes but stays lean by default', () => {
    const fast = router.decideRoute({
      proposed: proposal('deepseek-v4-flash'),
      explicitSelection: false,
      isSubagent: false,
      turn: 1,
      step: 1,
      facts: factsOf('hi'),
      memory: undefined,
      config,
    })
    expect(fast.record).toBeUndefined()
    const escalated = router.decideRoute({
      proposed: proposal('deepseek-v4-flash'),
      explicitSelection: false,
      isSubagent: false,
      turn: 2,
      step: 1,
      facts: factsOf('Prove the theorem. Think step by step.'),
      memory: fast.memory,
      config,
    })
    expect(escalated.record).toMatchObject({
      turn: 2,
      step: 1,
      authority: 'router',
      reason: 'escalated-to-heavy',
      score: 5,
      threshold: 4,
      policyVersion: router.POLICY_VERSION,
    })
    const telemetry = router.resolveConfig(resolvedConfig({ recordAllDecisions: true }))
    const every = router.decideRoute({
      proposed: proposal('deepseek-v4-flash'),
      explicitSelection: false,
      isSubagent: false,
      turn: 1,
      step: 1,
      facts: factsOf('hi'),
      memory: undefined,
      config: telemetry,
    })
    expect(every.record?.reason).toBe('routed-fast')
  })

  it('recordAllDecisions literally records every branch (audit Phase 8)', () => {
    const telemetry = router.resolveConfig(resolvedConfig({ recordAllDecisions: true }))
    const decide = (overrides: Partial<Parameters<typeof router.decideRoute>[0]>) =>
      router.decideRoute({
        proposed: proposal('deepseek-v4-flash'),
        explicitSelection: false,
        isSubagent: false,
        turn: 1,
        step: 1,
        facts: factsOf('hi'),
        memory: undefined,
        config: telemetry,
        ...overrides,
      })

    // Subagent passthrough, foreign-route passthrough, and quiet retention all
    // record in telemetry mode — no branch is exempt from the option's name.
    expect(decide({ isSubagent: true }).record).toMatchObject({
      authority: 'subagent-owner',
      reason: 'subagent-passthrough',
    })
    expect(decide({ proposed: proposal('other-model') }).record).toMatchObject({
      authority: 'foreign-route',
      reason: 'foreign-route-passthrough',
    })
    const retained = decide({ step: 3, memory: { turn: 1, decided: proposal('deepseek-v4-flash'), source: 'direct', explicit: false, epoch: 1 } })
    expect(retained.record).toMatchObject({ authority: 'router', reason: 'turn-route-retained' })

    // Lean mode records none of these — the option keeps its meaning both ways.
    expect(router.decideRoute({
      proposed: proposal('deepseek-v4-flash'),
      explicitSelection: false,
      isSubagent: true,
      turn: 1,
      step: 1,
      facts: factsOf('prove it'),
      memory: undefined,
      config,
    }).record).toBeUndefined()
    expect(router.decideRoute({
      proposed: proposal('other-model'),
      explicitSelection: false,
      isSubagent: false,
      turn: 1,
      step: 1,
      facts: factsOf('prove it'),
      memory: undefined,
      config,
    }).record).toBeUndefined()
  })

  it('mid-turn escalation records the measured facts and trigger (audit Phase 9)', () => {
    const fastTurn = router.decideRoute({
      proposed: proposal('deepseek-v4-flash'),
      explicitSelection: false,
      isSubagent: false,
      turn: 1,
      step: 1,
      facts: factsOf('list files'),
      memory: undefined,
      config,
    })
    const byCalls = router.decideRoute({
      proposed: proposal('deepseek-v4-flash'),
      explicitSelection: false,
      isSubagent: false,
      turn: 1,
      step: 3,
      facts: factsOf('', { toolCalls: 9, toolResultChars: 1_000 }),
      memory: fastTurn.memory,
      config,
    })
    expect(byCalls.record).toMatchObject({
      reason: 'mid-turn-escalated',
      discovered: { toolCalls: 9, toolResultChars: 1_000, trigger: 'tool-calls' },
    })
    const byVolume = router.decideRoute({
      proposed: proposal('deepseek-v4-flash'),
      explicitSelection: false,
      isSubagent: false,
      turn: 1,
      step: 3,
      facts: factsOf('', { toolCalls: 2, toolResultChars: 30_000 }),
      memory: fastTurn.memory,
      config,
    })
    expect(byVolume.record?.discovered).toMatchObject({ trigger: 'tool-result-volume' })
    const byBoth = router.decideRoute({
      proposed: proposal('deepseek-v4-flash'),
      explicitSelection: false,
      isSubagent: false,
      turn: 1,
      step: 3,
      facts: factsOf('', { toolCalls: 12, toolResultChars: 30_000 }),
      memory: fastTurn.memory,
      config,
    })
    expect(byBoth.record?.discovered).toMatchObject({ trigger: 'composite' })
  })

  it('routing records carry a correlation id and the active session authority (v0.15.3)', () => {
    // Epoch 1: the router escalates — record carries routerPolicy-era fields.
    const escalated = router.decideRoute({
      proposed: proposal('deepseek-v4-flash'),
      explicitSelection: false,
      activeAuthority: 'router',
      isSubagent: false,
      turn: 1,
      step: 1,
      facts: factsOf('Prove the theorem. Think step by step.'),
      memory: undefined,
      config,
    })
    expect(escalated.record).toMatchObject({
      authority: 'router',
      activeAuthority: 'router',
      policyVersion: router.POLICY_VERSION,
    })
    expect(escalated.record?.routingDecisionId).toEqual(expect.any(String))
    expect(escalated.record?.authorityEpoch).toBeUndefined()
    // An explicit passthrough stamps the session authority in force.
    const explicit = router.decideRoute({
      proposed: escalated.config,
      explicitSelection: true,
      activeAuthority: 'sdk',
      isSubagent: false,
      turn: 2,
      step: 1,
      facts: factsOf('hi'),
      memory: escalated.memory,
      config,
    })
    expect(explicit.record).toMatchObject({
      authority: 'explicit-selection',
      activeAuthority: 'sdk',
      reason: 'explicit-selection-passthrough',
    })
  })

  it('a first-ever explicit selection records the routing-stream claim (the durable authority is the authority event)', () => {
    // No prior memory, no prior events: the explicit claim reaches the routing
    // stream so the corpus stays complete; the AUTHORITATIVE durable record is
    // the model/selection-authority event the selection surface wrote.
    const first = router.decideRoute({
      proposed: proposal('deepseek-v4-flash'),
      explicitSelection: true,
      activeAuthority: 'user',
      isSubagent: false,
      turn: 1,
      step: 1,
      facts: factsOf('anything'),
      memory: undefined,
      config,
    })
    expect(first.record).toMatchObject({
      authority: 'explicit-selection',
      reason: 'explicit-selection-passthrough',
      selected: { model: 'deepseek-v4-flash' },
    })
    // A reconstructed explicit state suppresses re-recording.
    const restarted = router.decideRoute({
      proposed: proposal('deepseek-v4-flash'),
      explicitSelection: true,
      activeAuthority: 'user',
      isSubagent: false,
      turn: 2,
      step: 1,
      facts: factsOf('anything'),
      memory: { turn: 0, decided: undefined, source: 'reconstructed', explicit: true, authority: 'user' },
      config,
    })
    expect(restarted.record).toBeUndefined()
  })

  it('foreign and subagent passthroughs record when they END prior router ownership (lean mode)', () => {
    const owned = router.decideRoute({
      proposed: proposal('deepseek-v4-flash'),
      explicitSelection: false,
      activeAuthority: 'router',
      isSubagent: false,
      turn: 1,
      step: 1,
      facts: factsOf('Prove the theorem. Think step by step.'),
      memory: undefined,
      config,
    })
    expect(owned.config.model).toBe('deepseek-v4-pro')
    // Lean mode: a foreign proposal now ends router ownership -> durable record.
    const foreign = router.decideRoute({
      proposed: proposal('other-model'),
      explicitSelection: false,
      activeAuthority: 'default',
      isSubagent: false,
      turn: 2,
      step: 1,
      facts: factsOf('anything'),
      memory: owned.memory,
      config,
    })
    expect(foreign.record).toMatchObject({
      authority: 'foreign-route',
      activeAuthority: 'default',
      reason: 'foreign-route-passthrough',
    })
    // Sustained foreign sessions (nothing transitioned) record nothing.
    const sustained = router.decideRoute({
      proposed: proposal('other-model'),
      explicitSelection: false,
      activeAuthority: 'default',
      isSubagent: false,
      turn: 3,
      step: 1,
      facts: factsOf('anything'),
      memory: foreign.memory,
      config,
    })
    expect(sustained.record).toBeUndefined()
  })
})

describe('reconstructRoutingState', () => {
  const config = router.resolveConfig(resolvedConfig())

  /** Durable routing-decision event factory with the v0.15.2 legacy shape. */
  function routingEvent(seq: number, data: Partial<router.ModelRoutingDecisionEventData> & {
    turn: number
    authority: router.RoutingAuthority
    selected: { provider: string; model: string }
  }): SessionEvent {
    return {
      type: 'model/routing-decision',
      seq,
      time: 0,
      data: {
        turn: data.turn,
        step: 1,
        proposed: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        selected: data.selected,
        authority: data.authority,
        authorityEpoch: data.authorityEpoch ?? 1,
        reason: 'escalated-to-heavy',
        threshold: 4,
        policyVersion: data.policyVersion ?? router.POLICY_VERSION,
        ...data.score === undefined ? {} : { score: data.score },
      },
    }
  }

  /** Durable authority event factory. */
  function authorityEvent(seq: number, data: {
    authority: 'user' | 'sdk' | 'policy' | 'router' | 'subagent-owner' | 'default'
    authorityEpoch: number
    source?: string
  }): SessionEvent {
    return {
      type: 'model/selection-authority',
      seq,
      time: 0,
      data: {
        authority: data.authority,
        authorityEpoch: data.authorityEpoch,
        source: (data.source ?? 'web') as never,
        authoritySchemaVersion: 1,
      },
    }
  }

  it('restores router-owned heavy after a restart and re-scores it', () => {
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
      routingEvent(1, {
        turn: 1,
        authority: 'router',
        selected: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
        score: 5,
      }),
    ]
    const memory = router.reconstructRoutingState(events)
    expect(memory).toMatchObject({ source: 'reconstructed', explicit: false, authority: 'router' })
    expect(memory?.decided?.model).toBe('deepseek-v4-pro')

    // Turn 2 after restart, simple text: router-owned heavy is re-scored down.
    const next = router.decideRoute({
      proposed: { provider: 'deepseek-official', model: 'deepseek-v4-pro', temperature: 0.3 },
      explicitSelection: false,
      activeAuthority: 'router',
      isSubagent: false,
      turn: 2,
      step: 1,
      facts: { userText: () => 'thanks — just list the files', discovered: () => ({ toolCalls: 0, toolResultChars: 0 }) },
      memory,
      config,
    })
    expect(next.config.model).toBe('deepseek-v4-flash')
  })

  it('THE AUDIT RESTART BUG (legacy barrier): a newer explicit record terminates older router ownership', () => {
    // v0.15.2-era session: router escalation, then an explicit selection, then restart.
    const events: SessionEvent[] = [
      routingEvent(1, {
        turn: 1,
        authority: 'router',
        selected: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
        authorityEpoch: 1,
        score: 5,
      }),
      routingEvent(2, {
        turn: 2,
        authority: 'explicit-selection',
        selected: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
        authorityEpoch: 2,
      }),
    ]
    const memory = router.reconstructRoutingState(events)
    expect(memory).toMatchObject({ explicit: true, decided: undefined, authority: 'user' })

    const passthrough = router.decideRoute({
      proposed: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      explicitSelection: true,
      activeAuthority: 'user',
      isSubagent: false,
      turn: 3,
      step: 1,
      facts: { userText: () => 'thanks — just list the files', discovered: () => ({ toolCalls: 0, toolResultChars: 0 }) },
      memory,
      config,
    })
    expect(passthrough.config.model).toBe('deepseek-v4-pro')
    expect(passthrough.reason).toBe('explicit-selection-passthrough')
  })

  it('v0.15.3 authority events are the authoritative record, at ANY router policy version', () => {
    // A user claim recorded by the selection surface: explicit survives, with
    // the precise authority label (user vs sdk) intact.
    for (const authority of ['user', 'sdk', 'policy'] as const) {
      const memory = router.reconstructRoutingState([authorityEvent(1, { authority, authorityEpoch: 3 })])
      expect(memory).toMatchObject({ explicit: true, authority })
    }
    // Auto: the router owns routing again.
    expect(router.reconstructRoutingState([authorityEvent(1, { authority: 'router', authorityEpoch: 4 })]))
      .toMatchObject({ explicit: false, authority: 'router', decided: undefined })
    // Subagent owner: defer.
    expect(router.reconstructRoutingState([authorityEvent(1, { authority: 'subagent-owner', authorityEpoch: 2 })]))
      .toMatchObject({ explicit: false, authority: 'subagent-owner' })
    // Newer authority events outrank older router-owned routing records.
    const events: SessionEvent[] = [
      routingEvent(1, { turn: 1, authority: 'router', selected: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } }),
      authorityEvent(2, { authority: 'user', authorityEpoch: 2 }),
    ]
    expect(router.reconstructRoutingState(events)).toMatchObject({ explicit: true, authority: 'user' })
    // A newer current-policy router decision outranks an older Auto event.
    const autoThenRouted: SessionEvent[] = [
      authorityEvent(1, { authority: 'router', authorityEpoch: 2 }),
      routingEvent(2, { turn: 3, authority: 'router', selected: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } }),
    ]
    expect(router.reconstructRoutingState(autoThenRouted)).toMatchObject({
      explicit: false,
      authority: 'router',
      decided: { model: 'deepseek-v4-pro' },
    })
  })

  it('POLICY-VERSION INDEPENDENCE: legacy explicit barriers survive a router policy upgrade', () => {
    // The scenario the audit flagged: a future router (policy v3) reading a
    // v0.15.2 log must NOT lose the user's explicit choice. Stale-policy
    // router ownership is ignored; stale-policy explicit barriers are honored.
    const events: SessionEvent[] = [
      routingEvent(1, {
        turn: 1,
        authority: 'router',
        selected: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
        policyVersion: router.POLICY_VERSION,
      }),
      routingEvent(2, {
        turn: 2,
        authority: 'explicit-selection',
        selected: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
        policyVersion: 1, // "written by an older router policy"
      }),
      routingEvent(3, {
        turn: 3,
        authority: 'router',
        selected: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
        policyVersion: 1, // stale router era after the explicit claim
      }),
    ]
    const memory = router.reconstructRoutingState(events)
    expect(memory).toMatchObject({ explicit: true, authority: 'user', decided: undefined })
  })

  it('foreign-route and subagent-owner records end router ownership', () => {
    for (const authority of ['foreign-route', 'subagent-owner'] as const) {
      const memory = router.reconstructRoutingState([routingEvent(1, {
        turn: 1,
        authority,
        selected: { provider: 'other', model: 'm' },
      })])
      expect(memory).toMatchObject({ explicit: false, decided: undefined })
    }
  })

  it('stale-policy records with no barrier below them yield no router ownership', () => {
    const stale = [routingEvent(1, {
      turn: 1,
      authority: 'router',
      selected: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    })].map(event => ({ ...event, data: { ...event.data, policyVersion: 1 } }))
    expect(router.reconstructRoutingState(stale)).toBeUndefined()
  })
})

describe('agent-loop integration', () => {
  it('keeps a simple turn on the fast route', async () => {
    const adapter = new RecordingAdapter()
    context = await harness(adapter)
    const agent = context.agentLoop.create(SessionId('router-simple'), FAST)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'List the files in this directory.' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(adapter.requests).toEqual([{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }])
  })

  it('keeps the audit\'s concise hard-sounding coding prompt on Flash', async () => {
    const adapter = new RecordingAdapter()
    context = await harness(adapter)
    const agent = context.agentLoop.create(SessionId('router-race'), FAST)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Fix the race condition in the scheduler.' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(adapter.requests).toEqual([{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }])
  })

  it('escalates a corroborated complex turn and records the durable decision', async () => {
    const adapter = new RecordingAdapter()
    context = await harness(adapter)
    const agent = context.agentLoop.create(SessionId('router-complex'), FAST)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Prove the theorem by induction. Think step by step.' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(adapter.requests).toEqual([{ provider: 'deepseek-official', model: 'deepseek-v4-pro' }])
    const decisions = agent.session.events.filter(event => event.type === 'model/routing-decision')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]?.data).toMatchObject({
      authority: 'router',
      reason: 'escalated-to-heavy',
      score: 6,
    })
  })

  it('re-routes each turn by its own complexity', async () => {
    const adapter = new RecordingAdapter()
    context = await harness(adapter)
    const agent = context.agentLoop.create(SessionId('router-multi'), FAST)
    const send = async (text: string): Promise<void> => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    }
    await send('Prove the theorem by induction. Think step by step.')
    await send('thanks — now just list the files')
    await send('Now derive the equation and prove the lemma thoroughly. Think step by step.')
    expect(adapter.requests.map(request => request.model)).toEqual([
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ])
  })

  it('keeps the heavy route across the steps of one escalated turn', async () => {
    const adapter = new RecordingAdapter(['tool-call'])
    context = await harness(adapter)
    context.tools.register(defineContentToolFixture({
      name: 'probe',
      description: 'routing probe',
      parameters: {},
      async execute() {
        return [{ type: 'text', text: 'probed' }]
      },
    }))
    const agent = context.agentLoop.create(SessionId('router-steps'), FAST)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Prove the theorem by induction. Think step by step.' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(adapter.requests.length).toBe(2)
    expect(adapter.requests.every(request => request.model === 'deepseek-v4-pro')).toBe(true)
  })

  it('escalates mid-turn when a tool loop uncovers heavy work', async () => {
    // Step 1 answers with a tool call; steps 2..9 keep calling until the
    // discovered-escalation bound (8 tool calls) flips the turn to Pro.
    const adapter = new RecordingAdapter(Array.from({ length: 12 }, () => 'tool-call' as const))
    context = await harness(adapter)
    let executions = 0
    context.tools.register(defineContentToolFixture({
      name: 'probe',
      description: 'routing probe',
      parameters: {},
      async execute() {
        executions += 1
        return [{ type: 'text', text: `probe ${String(executions)}` }]
      },
    }))
    const agent = context.agentLoop.create(SessionId('router-midturn'), FAST)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Fix the race condition in the scheduler.' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    const models = adapter.requests.map(request => request.model)
    // Flash until the 8th in-turn tool call, then heavy for the rest.
    const firstHeavy = models.indexOf('deepseek-v4-pro')
    expect(firstHeavy).toBeGreaterThan(0)
    expect(models.slice(0, firstHeavy).every(model => model === 'deepseek-v4-flash')).toBe(true)
    expect(models.slice(firstHeavy).every(model => model === 'deepseek-v4-pro')).toBe(true)
    const decisions = agent.session.events.filter(event => event.type === 'model/routing-decision')
    expect(decisions.some(event => event.data.reason === 'mid-turn-escalated')).toBe(true)
  })

  it('leaves an agent on a foreign model untouched', async () => {
    const adapter = new RecordingAdapter()
    context = await harness(adapter)
    const agent = context.agentLoop.create(SessionId('router-foreign'), {
      provider: 'other',
      model: 'custom-model',
    })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Prove the theorem by induction. Think step by step.' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(adapter.requests).toEqual([{ provider: 'other', model: 'custom-model' }])
  })

  it('an explicit live selection mark disables routing for the session', async () => {
    const adapter = new RecordingAdapter()
    context = await harness(adapter)
    const agent = context.agentLoop.create(SessionId('router-explicit'), FAST)
    // Turn 1: no mark, complex prompt — the router escalates and owns it.
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Prove the theorem by induction. Think step by step.' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(adapter.requests[0]?.model).toBe('deepseek-v4-pro')
    // Turn 2: the operator makes a live selection. From here the session is
    // not router-managed: an easy prompt neither downgrades the explicit
    // choice nor re-escalates a suppressed one.
    markExplicitModelSelection(agent.session, 'web', HEAVY)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'thanks — just list the files' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(adapter.requests[1]?.model).toBe('deepseek-v4-pro')
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Prove the theorem by induction. Think step by step.' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(adapter.requests[2]?.model).toBe('deepseek-v4-pro')
    // Exactly one transition record: router ownership -> explicit selection.
    const decisions = agent.session.events.filter(event => event.type === 'model/routing-decision')
    expect(decisions.filter(event => event.data.reason === 'explicit-selection-passthrough')).toHaveLength(1)
    expect(decisions.filter(event => event.data.authority === 'router')).toHaveLength(1)
  })

  it('DoD 6: router Pro, then explicit Pro, then restart — still explicit Pro', async () => {
    const adapter = new RecordingAdapter()
    context = await harness(adapter)
    const agent = context.agentLoop.create(SessionId('router-restart-pro'), FAST)
    const send = async (text: string): Promise<void> => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    }
    // Turn 1: complex prompt — the router escalates to Pro (durable record, epoch 1).
    await send('Prove the theorem by induction. Think step by step.')
    expect(adapter.requests[0]?.model).toBe('deepseek-v4-pro')
    // Turn 2: the operator explicitly takes ownership of Pro.
    markExplicitModelSelection(agent.session, 'web', HEAVY)
    await send('thanks — just list the files')
    expect(adapter.requests[1]?.model).toBe('deepseek-v4-pro')

    // Restart the router: dispose the plugin fiber (its WeakMap dies with it)
    // and mount a fresh instance over the SAME session log.
    await routerFiber?.dispose()
    routerFiber = await context.plugin(Object.assign((inner: Context) => {
      router.apply(inner, resolvedConfig())
    }, { inject: router.inject }))

    // Turn 3 after restart: a simple prompt must keep Pro — the older router
    // record may not resurrect ownership over the newer explicit record.
    await send('list the files again')
    expect(adapter.requests[2]?.model).toBe('deepseek-v4-pro')
    const decisions = agent.session.events.filter(event => event.type === 'model/routing-decision')
    expect(decisions.at(-1)?.data).toMatchObject({ authority: 'explicit-selection' })
    // No new router-owned record appeared after the restart.
    expect(decisions.filter(event => event.data.authority === 'router')).toHaveLength(1)
  })

  it('DoD 7: router Pro, then explicit Flash, then restart — router must not reassert Pro', async () => {
    const adapter = new RecordingAdapter()
    context = await harness(adapter)
    const agent = context.agentLoop.create(SessionId('router-restart-flash'), FAST)
    // A mutable session-local selection, exactly like the API proxy installs:
    // the operator's picker writes it, and prompt assembly snapshots it.
    const selection: ModelSelectionRef = { current: { ...FAST }, assembled: undefined }
    installModelSelection(agent.ctx, selection)
    const send = async (text: string): Promise<void> => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    }
    // Turn 1: complex prompt — the router escalates the Flash proposal to Pro.
    await send('Prove the theorem by induction. Think step by step.')
    expect(adapter.requests[0]?.model).toBe('deepseek-v4-pro')
    // Turn 2: the operator explicitly picks Flash (live mark + selection).
    selection.current = { ...FAST }
    markExplicitModelSelection(agent.session, 'web', FAST)
    await send('one more thing')
    expect(adapter.requests[1]?.model).toBe('deepseek-v4-flash')

    // Restart: fresh router instance; the in-process selection ref is gone and
    // the proposal now derives from the logged Flash header.
    await routerFiber?.dispose()
    routerFiber = await context.plugin(Object.assign((inner: Context) => {
      router.apply(inner, resolvedConfig())
    }, { inject: router.inject }))

    // Turn 3 after restart: a COMPLEX prompt must stay on the explicit Flash —
    // the old router-owned Pro record may not reassert itself.
    await send('Prove the theorem by induction. Think step by step.')
    expect(adapter.requests[2]?.model).toBe('deepseek-v4-flash')
    const decisions = agent.session.events.filter(event => event.type === 'model/routing-decision')
    expect(decisions.at(-1)?.data).toMatchObject({
      authority: 'explicit-selection',
      reason: 'explicit-selection-passthrough',
    })
  })

  it('v0.15.3 Auto: releasing explicit authority restores router management', async () => {
    const adapter = new RecordingAdapter()
    context = await harness(adapter)
    const agent = context.agentLoop.create(SessionId('router-auto'), FAST)
    const send = async (text: string): Promise<void> => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    }
    // Turn 1: complex prompt — the router escalates to Pro.
    await send('Prove the theorem by induction. Think step by step.')
    expect(adapter.requests[0]?.model).toBe('deepseek-v4-pro')
    // Turn 2: the operator explicitly takes Pro (durable authority claim).
    markExplicitModelSelection(agent.session, 'web', HEAVY)
    await send('thanks — just list the files')
    expect(adapter.requests[1]?.model).toBe('deepseek-v4-pro')
    // Turn 3: the operator selects Auto — authority returns to the router.
    clearExplicitModelSelection(agent.session, 'web')
    await send('thanks — just list the files again')
    expect(adapter.requests[2]?.model).toBe('deepseek-v4-flash')
    // Turn 4: the router manages freely again (escalates on complexity).
    await send('Prove the theorem by induction. Think step by step.')
    expect(adapter.requests[3]?.model).toBe('deepseek-v4-pro')

    // Durable authority stream: user claim, then Auto (router), in order.
    const authorityEvents = agent.session.events.filter(event => event.type === 'model/selection-authority')
    expect(authorityEvents.map(event => event.data.authority)).toEqual(['user', 'router'])
    expect(authorityEvents.map(event => event.data.authorityEpoch)).toEqual([1, 2])

    // Restart: Auto is durable — the router keeps managing.
    await routerFiber?.dispose()
    routerFiber = await context.plugin(Object.assign((inner: Context) => {
      router.apply(inner, resolvedConfig())
    }, { inject: router.inject }))
    await send('list the files once more')
    expect(adapter.requests[4]?.model).toBe('deepseek-v4-flash')
  })

  it('v0.15.3 SDK authority: an sdk authority claim survives a router restart', async () => {
    const adapter = new RecordingAdapter()
    context = await harness(adapter)
    // The SDK server creates the agent with the caller's initialize model.
    const agent = context.agentLoop.create(SessionId('router-sdk-authority'), HEAVY)
    // ...and claims explicit authority with source 'sdk' in agent setup.
    markExplicitModelSelection(agent.session, 'sdk', HEAVY)
    const send = async (text: string): Promise<void> => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    }
    // Simple prompt on the explicitly claimed Pro: no downgrade.
    await send('just list the files')
    expect(adapter.requests[0]?.model).toBe('deepseek-v4-pro')

    // Restart: the sdk authority event outranks the router.
    await routerFiber?.dispose()
    routerFiber = await context.plugin(Object.assign((inner: Context) => {
      router.apply(inner, resolvedConfig())
    }, { inject: router.inject }))
    await send('just list the files again')
    expect(adapter.requests[1]?.model).toBe('deepseek-v4-pro')

    const authorityEvents = agent.session.events.filter(event => event.type === 'model/selection-authority')
    expect(authorityEvents.at(-1)?.data).toMatchObject({ authority: 'sdk', source: 'sdk' })
    // The routing record stamps the session authority in force.
    const decisions = agent.session.events.filter(event => event.type === 'model/routing-decision')
    expect(decisions.every(event => event.data.activeAuthority === 'sdk')).toBe(true)
  })

  it('v0.15.4 DETERMINISTIC IDENTITY: same coordinates reproduce the id; different turns differ', async () => {
    const adapter = new RecordingAdapter()
    context = await harness(adapter)
    const agent = context.agentLoop.create(SessionId('router-det-id'), FAST)
    const send = async (text: string): Promise<void> => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    }
    await send('Prove the theorem by induction. Think step by step.')
    await send('thanks — just list the files')
    await send('Prove the theorem by induction. Think step by step.')
    const decisions = agent.session.events.filter(event => event.type === 'model/routing-decision')
    const ids = decisions.map(event => event.data.routingDecisionId)
    // Identity is derived from execution coordinates: distinct turns get
    // distinct ids, and replaying the SAME coordinates (the pure helper)
    // reproduces the id exactly — no randomness in the policy path.
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids[0]).not.toBe(ids[1])
    // Telemetry stamps: every decision records its scorer and configuration.
    expect(decisions.every(event => event.data.scorerVersion === router.SCORER_VERSION
      && typeof event.data.configFingerprint === 'string'
      && event.data.configFingerprint!.length > 0)).toBe(true)
    // The pure helper is coordinate-stable.
    const configFingerprint = 'fp'
    expect(router.routingDecisionIdentity('s', 1, 1, router.POLICY_VERSION, configFingerprint))
      .toBe(router.routingDecisionIdentity('s', 1, 1, router.POLICY_VERSION, configFingerprint))
    expect(router.routingDecisionIdentity('s', 1, 1, router.POLICY_VERSION, configFingerprint))
      .not.toBe(router.routingDecisionIdentity('s', 1, 2, router.POLICY_VERSION, configFingerprint))
  })

  it('v0.15.4 AUDIT F1: Auto works after a REAL process restart (fresh Session object)', async () => {
    const adapter = new RecordingAdapter()
    context = await harness(adapter)
    const agent = context.agentLoop.create(SessionId('router-auto-restart'), FAST)
    claimModelSelection(agent.session, { authority: 'user', source: 'web', selection: HEAVY })
    // --- process dies: everything live is dropped; only the log survives ---
    const persisted = [...agent.session.events]
    const restarted = Session.create(SessionId('router-auto-restart'), persisted, agent.session.header)

    // The user selects Auto on the reconstructed session: the WeakMap is
    // empty, so the release must come from the DURABLE state.
    releaseToAuto(restarted, 'web')
    const authorityEvents = restarted.events.filter(event => event.type === 'model/selection-authority')
    expect(authorityEvents.map(event => event.data.authority)).toEqual(['user', 'router'])
    expect(authorityEvents.at(-1)?.data).toMatchObject({ mode: 'auto', authority: 'router' })

    // And the router, reading the same log, honors the release.
    const memory = router.reconstructRoutingState(restarted.events)
    expect(memory).toMatchObject({ explicit: false, authority: 'router', decided: undefined })
  })

  it('v0.15.4 AUDIT F3: a manual selection survives a crash before any request ran', async () => {
    const adapter = new RecordingAdapter()
    context = await harness(adapter)
    const agent = context.agentLoop.create(SessionId('router-crash-claim'), FAST)
    // User selects Pro; the process dies BEFORE a prompt updates the header.
    claimModelSelection(agent.session, { authority: 'user', source: 'web', selection: HEAVY })
    const persisted = [...agent.session.events]
    const restarted = Session.create(SessionId('router-crash-claim'), persisted, agent.session.header)

    // The durable state restores authority AND the complete selection.
    const state = reconstructSelectionState(restarted.events)
    expect(state).toMatchObject({
      mode: 'manual',
      authority: 'user',
      selection: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    })
    // The router defers to it: a heavy proposal is explicit, never re-scored.
    const memory = router.reconstructRoutingState(restarted.events)
    expect(memory).toMatchObject({ explicit: true, authority: 'user' })
    const decision = router.decideRoute({
      sessionId: 'router-crash-claim',
      proposed: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      explicitSelection: true,
      activeAuthority: 'user',
      isSubagent: false,
      turn: 1,
      step: 1,
      facts: { userText: () => 'anything', discovered: () => ({ toolCalls: 0, toolResultChars: 0 }) },
      memory,
      config: router.resolveConfig(resolvedConfig()),
    })
    expect(decision.config.model).toBe('deepseek-v4-pro')
    expect(decision.reason).toBe('explicit-selection-passthrough')
  })

  it('v0.15.4 AUDIT F4: same-authority Pro→Flash switch is durable across a crash', () => {
    const session = Session.create(SessionId('router-pro-flash-crash'))
    claimModelSelection(session, { authority: 'user', source: 'web', selection: HEAVY })
    claimModelSelection(session, { authority: 'user', source: 'web', selection: FAST })
    const restarted = Session.create(SessionId('router-pro-flash-crash'), [...session.events], session.header)
    const state = reconstructSelectionState(restarted.events)
    expect(state).toMatchObject({ mode: 'manual', selection: { model: 'deepseek-v4-flash' } })
    // The transition itself was recorded (not suppressed by authority equality).
    const authorityEvents = restarted.events.filter(event => event.type === 'model/selection-authority')
    expect(authorityEvents).toHaveLength(2)
    expect(authorityEvents.map(event => event.data.selection?.model))
      .toEqual(['deepseek-v4-pro', 'deepseek-v4-flash'])
  })

  it('v0.15.4 AUDIT F2/F6: Auto after a foreign manual model reclaims the default route; default authority is exhaustive', () => {
    const session = Session.create(SessionId('router-foreign-auto'))
    claimModelSelection(session, { authority: 'user', source: 'web', selection: { provider: 'other', model: 'custom' } })
    releaseToAuto(session, 'web')
    const memory = router.reconstructRoutingState(session.events)
    expect(memory).toMatchObject({ explicit: false, authority: 'router', decided: undefined })

    // A `default` authority state reconstructs (no zombie states in the machine).
    const defaulted = Session.create(SessionId('router-default-state'))
    defaulted.append('model/selection-authority', {
      mode: 'auto',
      authority: 'default',
      authorityEpoch: 1,
      source: 'system',
      authoritySchemaVersion: 2,
    })
    expect(router.reconstructRoutingState(defaulted.events))
      .toMatchObject({ explicit: false, authority: 'default', decided: undefined })
  })

  it('v0.15.4 AUDIT F7: a future-schema authority state fails CLOSED, never resurrects older history', () => {
    const session = Session.create(SessionId('router-future-schema'))
    claimModelSelection(session, { authority: 'user', source: 'web', selection: HEAVY })
    // A newer runtime writes a schema-99 state; this runtime must not skip it
    // and resurrect the schema-2 user claim underneath.
    session.append('model/selection-authority', {
      mode: 'auto',
      authority: 'router',
      authorityEpoch: 2,
      source: 'web',
      authoritySchemaVersion: 99,
    } as never)
    const state = reconstructSelectionState(session.events)
    expect(state).toEqual({ undecidable: true })
    const memory = router.reconstructRoutingState(session.events)
    expect(memory).toMatchObject({ explicit: true })
  })

  it('v0.15.3 lean mode: authority claims are durable without recordAllDecisions', async () => {
    const adapter = new RecordingAdapter()
    // recordAllDecisions stays false — authority events must not depend on it.
    context = await harness(adapter)
    const agent = context.agentLoop.create(SessionId('router-lean-authority'), FAST)
    markExplicitModelSelection(agent.session, 'web', FAST)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Prove the theorem by induction. Think step by step.' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    // The router deferred to the explicit Flash even on a complex prompt...
    expect(adapter.requests[0]?.model).toBe('deepseek-v4-flash')
    // ...and the authority claim reached the durable log regardless.
    const authorityEvents = agent.session.events.filter(event => event.type === 'model/selection-authority')
    expect(authorityEvents).toHaveLength(1)
    expect(authorityEvents[0]?.data).toMatchObject({
      mode: 'manual',
      authority: 'user',
      source: 'web',
      authoritySchemaVersion: 2,
      selection: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
  })

  it('v0.15.5: Manual ForeignModel → request/header → Auto → restart → stale foreign route never reaches llm/request', async () => {
    // P0-2 full waterfall: the user manually selects a foreign model, a
    // request runs (stamping the foreign route into request/header), then Auto
    // releases the claim. After a router restart, the stale foreign route must
    // NOT reach the LLM. The Host resolver returns the deployment default
    // (fast route) for durable Auto, and the router selects fast/heavy based
    // on complexity — never the foreign model.
    const adapter = new RecordingAdapter()
    context = await harness(adapter)
    const agent = context.agentLoop.create(SessionId('router-foreign-auto-restart'), FAST)
    // Manual foreign selection (durable).
    markExplicitModelSelection(agent.session, 'web', { provider: 'other', model: 'custom-model' })
    // A request runs, stamping the foreign route into the request header.
    agent.session.append('request/header', {
      header: { config: { provider: 'other', model: 'custom-model' } },
      reason: 'change',
    })
    // Auto releases the manual claim (durable).
    releaseToAuto(agent.session, 'web')
    // Restart the router: dispose the plugin fiber and mount a fresh instance.
    await routerFiber?.dispose()
    routerFiber = await context.plugin(Object.assign((inner: Context) => {
      router.apply(inner, resolvedConfig())
    }, { inject: router.inject }))
    // Send a simple prompt — the router must select the fast route, NOT the
    // stale foreign model from the request header.
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'list the files in this directory' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(adapter.requests).toEqual([{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }])
    // The foreign model must never appear in any LLM request.
    expect(adapter.requests.every(request => request.provider !== 'other')).toBe(true)
  })
})
