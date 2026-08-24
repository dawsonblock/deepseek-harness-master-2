export interface BackpressureGateOptions {
  readonly maxConcurrent: number
  readonly maxQueued: number
  readonly queueTimeoutMs?: number
}

export interface BackpressureSnapshot {
  readonly active: number
  readonly queued: number
  readonly admitted: number
  readonly rejected: number
  readonly timedOut: number
  readonly totalWaitMs: number
}

export interface BackpressureLease {
  readonly waitedMs: number
  release(): void
}

export class BackpressureRejectedError extends Error {
  constructor(public readonly reason: 'queue-full' | 'queue-timeout') {
    super(`backpressure admission rejected: ${reason}`)
    this.name = 'BackpressureRejectedError'
  }
}

interface Waiter {
  readonly enqueuedAt: number
  readonly signal?: AbortSignal
  resolve(lease: BackpressureLease): void
  reject(error: unknown): void
  timer?: ReturnType<typeof setTimeout>
  onAbort?: () => void
}

/**
 * Small fail-closed FIFO concurrency gate for event/IPC/tool integrations.
 * It never drops accepted work silently: overload rejects before admission.
 */
export class BoundedBackpressureGate {
  private active = 0
  private readonly queue: Waiter[] = []
  private admitted = 0
  private rejected = 0
  private timedOut = 0
  private totalWaitMs = 0

  constructor(public readonly options: BackpressureGateOptions) {
    if (!Number.isSafeInteger(options.maxConcurrent) || options.maxConcurrent <= 0) {
      throw new TypeError('maxConcurrent must be a positive safe integer')
    }
    if (!Number.isSafeInteger(options.maxQueued) || options.maxQueued < 0) {
      throw new TypeError('maxQueued must be a non-negative safe integer')
    }
    if (options.queueTimeoutMs !== undefined
      && (!Number.isFinite(options.queueTimeoutMs) || options.queueTimeoutMs <= 0)) {
      throw new TypeError('queueTimeoutMs must be finite and positive')
    }
  }

  acquire(now = Date.now(), signal?: AbortSignal): Promise<BackpressureLease> {
    signal?.throwIfAborted()
    if (this.active < this.options.maxConcurrent) {
      this.active += 1
      this.admitted += 1
      return Promise.resolve(this.lease(0))
    }
    if (this.queue.length >= this.options.maxQueued) {
      this.rejected += 1
      return Promise.reject(new BackpressureRejectedError('queue-full'))
    }
    return new Promise<BackpressureLease>((resolve, reject) => {
      const waiter: Waiter = { enqueuedAt: now, ...signal === undefined ? {} : { signal }, resolve, reject }
      if (signal !== undefined) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter)
          if (index < 0) return
          this.queue.splice(index, 1)
          this.clearWaiter(waiter)
          reject(signal.reason ?? new Error('backpressure admission aborted'))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      const timeout = this.options.queueTimeoutMs
      if (timeout !== undefined) {
        waiter.timer = setTimeout(() => {
          const index = this.queue.indexOf(waiter)
          if (index < 0) return
          this.queue.splice(index, 1)
          this.clearWaiter(waiter)
          this.rejected += 1
          this.timedOut += 1
          reject(new BackpressureRejectedError('queue-timeout'))
        }, timeout)
      }
      this.queue.push(waiter)
    })
  }

  snapshot(): BackpressureSnapshot {
    return {
      active: this.active,
      queued: this.queue.length,
      admitted: this.admitted,
      rejected: this.rejected,
      timedOut: this.timedOut,
      totalWaitMs: this.totalWaitMs,
    }
  }

  private lease(waitedMs: number): BackpressureLease {
    let released = false
    return {
      waitedMs,
      release: () => {
        if (released) return
        released = true
        this.releaseOne()
      },
    }
  }

  private clearWaiter(waiter: Waiter): void {
    if (waiter.timer !== undefined) clearTimeout(waiter.timer)
    if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
  }

  private releaseOne(): void {
    if (this.active > 0) this.active -= 1
    const waiter = this.queue.shift()
    if (waiter === undefined) return
    this.clearWaiter(waiter)
    const waitedMs = Math.max(0, Date.now() - waiter.enqueuedAt)
    this.totalWaitMs += waitedMs
    this.active += 1
    this.admitted += 1
    waiter.resolve(this.lease(waitedMs))
  }
}
