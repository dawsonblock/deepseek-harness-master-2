/**
 * Root-scoped resource-governor integration.
 *
 * The hardening package owns the pure accounting state machine. This plugin
 * connects it to subagent admission and session telemetry without claiming a
 * distributed quota: process-local counters can be rebuilt/seeded by a host
 * after restart, while durable `subagent/resource` events retain diagnostics.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentAdmissionGuard, SubagentAdmissionRequest } from '@deepseek-ai/dsh-subagent'
import {
  BackpressureRejectedError,
  BoundedBackpressureGate,
  ResourceBudgetExceededError,
  RootResourceGovernor,
  type RootResourceBudget,
} from '@deepseek-ai/dsh-agent-kernel-hardening'

export const name = 'runtime-resource-governor'
export const inject = ['subagents', 'sessions']

export interface Config extends RootResourceBudget {
  /** Maximum queued one-shot starts once root child concurrency is saturated. */
  maxQueuedSubagentStarts?: number
  /** Optional deadline for a queued one-shot start. */
  subagentQueueTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  maxConcurrentOneShotChildren: z.number().min(0).optional(),
  maxDescendantsStarted: z.number().min(0).optional(),
  maxSubagentStartsPerMinute: z.number().min(0).optional(),
  maxModelCalls: z.number().min(0).optional(),
  maxReasoningTokens: z.number().min(0).optional(),
  maxEventBytes: z.number().min(0).optional(),
  maxWallTimeMs: z.number().min(0).optional(),
  maxQueuedSubagentStarts: z.number().min(0).optional(),
  subagentQueueTimeoutMs: z.number().min(1).optional(),
})

function rootSessionId(ctx: Context, subject: Session): SessionId {
  let current = subject
  const seen = new Set<string>()
  while (current.header.parentSession !== undefined) {
    const parentId = current.header.parentSession
    if (seen.has(String(parentId))) return current.id
    seen.add(String(parentId))
    const parent = ctx.sessions.get(parentId)
    // A cold ancestor may not be resident. Use its durable id as the best
    // conservative process-local root key rather than resetting to the child.
    if (parent === undefined) return parentId
    current = parent
  }
  return current.id
}

function appendResourceEvent(
  parent: Agent,
  data: Parameters<Agent['session']['append']>[1] & Record<string, unknown>,
): void {
  parent.session.append('subagent/resource', data as never, { ignorable: true })
}

export function apply(ctx: Context, config: Config = {}): void {
  const budget = Config(config) as RootResourceBudget
  const governor = new RootResourceGovernor(budget)
  const maxConcurrent = budget.maxConcurrentOneShotChildren
  const subagentBackpressure = maxConcurrent !== undefined && maxConcurrent > 0
    && config.maxQueuedSubagentStarts !== undefined
    ? new BoundedBackpressureGate({
        maxConcurrent,
        maxQueued: config.maxQueuedSubagentStarts,
        ...config.subagentQueueTimeoutMs === undefined ? {} : { queueTimeoutMs: config.subagentQueueTimeoutMs },
      })
    : undefined
  const blockedRoots = new Map<string, ResourceBudgetExceededError>()
  const turnStarts = new Map<string, number>()

  const guard: SubagentAdmissionGuard = {
    name: 'runtime-resource-governor',
    async admit(request: SubagentAdmissionRequest) {
      const rootId = String(rootSessionId(ctx, request.parent.session))
      const prior = blockedRoots.get(rootId)
      if (prior !== undefined) {
        appendResourceEvent(request.parent, {
          version: 1, rootId, action: 'budget-exceeded', kind: request.kind, provider: request.provider,
          dimension: prior.dimension, limit: prior.limit, actual: prior.actual,
        })
        throw prior
      }
      let queueLease: Awaited<ReturnType<BoundedBackpressureGate['acquire']>> | undefined
      try {
        if (request.kind === 'one-shot' && subagentBackpressure !== undefined) {
          queueLease = await subagentBackpressure.acquire(Date.now(), request.signal)
          if (queueLease.waitedMs > 0) {
            request.parent.session.append('runtime/backpressure', {
              version: 1, scope: 'subagent-start', waitMs: queueLease.waitedMs, dropped: false,
            }, { ignorable: true })
          }
        }
        const admission = governor.admitSubagent(rootId, request.kind)
        appendResourceEvent(request.parent, {
          version: 1, rootId, action: 'admit', kind: request.kind, provider: request.provider,
        })
        let committed = false
        let closed = false
        return {
          commit() {
            admission.commit()
            committed = true
            appendResourceEvent(request.parent, {
              version: 1, rootId, action: 'commit', kind: request.kind, provider: request.provider,
            })
          },
          rollback() {
            if (closed || committed) return
            closed = true
            admission.rollback()
            queueLease?.release()
            appendResourceEvent(request.parent, {
              version: 1, rootId, action: 'rollback', kind: request.kind, provider: request.provider,
            })
          },
          release() {
            if (closed) return
            closed = true
            admission.release()
            queueLease?.release()
            appendResourceEvent(request.parent, {
              version: 1, rootId, action: 'release', kind: request.kind, provider: request.provider,
            })
          },
        }
      } catch (error: unknown) {
        queueLease?.release()
        if (error instanceof BackpressureRejectedError) {
          request.parent.session.append('runtime/backpressure', {
            version: 1, scope: 'subagent-start', waitMs: 0, dropped: true, reason: error.reason,
          }, { ignorable: true })
        }
        if (error instanceof ResourceBudgetExceededError) {
          appendResourceEvent(request.parent, {
            version: 1,
            rootId,
            action: 'reject',
            kind: request.kind,
            provider: request.provider,
            dimension: error.dimension,
            limit: error.limit,
            actual: error.actual,
          })
        }
        throw error
      }
    },
  }

  ctx.subagents.registerAdmissionGuard(guard)

  // Hard pre-model admission. v0.14 only observed model/request after the
  // dispatch boundary, which meant call 201 could still reach the provider
  // when maxModelCalls was 200. Charging here is intentionally conservative:
  // a later request-construction failure still consumes one admission, but a
  // configured model-call ceiling is never exceeded by a provider dispatch.
  ctx.on('agent/request', async ({ agent }, next) => {
    const rootId = String(rootSessionId(ctx, agent.session))
    const prior = blockedRoots.get(rootId)
    if (prior !== undefined) {
      appendResourceEvent(agent, {
        version: 1, rootId, action: 'budget-exceeded',
        dimension: prior.dimension, limit: prior.limit, actual: prior.actual,
      })
      throw prior
    }
    try {
      governor.recordModelUsage(rootId, 1, 0)
      appendResourceEvent(agent, { version: 1, rootId, action: 'model-admit' })
    } catch (error: unknown) {
      if (error instanceof ResourceBudgetExceededError) {
        blockedRoots.set(rootId, error)
        appendResourceEvent(agent, {
          version: 1, rootId, action: 'budget-exceeded',
          dimension: error.dimension, limit: error.limit, actual: error.actual,
        })
      }
      throw error
    }
    return next()
  })

  ctx.on('session/event', (session, event) => {
    if (event.type === 'subagent/resource') return
    const rootId = String(rootSessionId(ctx, session))
    const recordExceeded = (error: unknown): void => {
      if (!(error instanceof ResourceBudgetExceededError)) return
      blockedRoots.set(rootId, error)
      // Do not append from inside session/event: Session forbids append
      // reentrancy. The next admission reports the rejection durably.
    }
    try {
      const encoded = JSON.stringify(event)
      governor.recordEventBytes(rootId, new TextEncoder().encode(encoded).byteLength)
      if (event.type === 'assistant/message') {
        const usage = event.data.usage
        governor.recordModelUsage(rootId, 0, usage?.reasoningTokens ?? 0)
      }
      if (event.type === 'turn/start') turnStarts.set(`${session.id}:${event.data.turn}`, event.time)
      if (event.type === 'turn/end') {
        const key = `${session.id}:${event.data.turn}`
        const started = turnStarts.get(key)
        turnStarts.delete(key)
        if (started !== undefined && event.time >= started) governor.recordWallTime(rootId, event.time - started)
      }
    } catch (error: unknown) {
      recordExceeded(error)
    }
  })
}
