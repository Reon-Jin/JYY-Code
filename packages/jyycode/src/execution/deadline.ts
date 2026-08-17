/**
 * Monotonic deadlines shared by tools, subprocesses, and child agents.
 *
 * `performance.now()` is intentionally used instead of Date.now(): wall-clock
 * changes must not extend an operation that is already running.
 */
export type MonotonicClock = () => number

const monotonicNow: MonotonicClock = () =>
  typeof globalThis.performance?.now === "function"
    ? globalThis.performance.now()
    : Number(process.hrtime.bigint()) / 1_000_000

export class DeadlineError extends Error {
  readonly code = "INVALID_DEADLINE"

  constructor(message: string) {
    super(message)
    this.name = "DeadlineError"
  }
}

export type DeadlineOptions = {
  readonly now?: MonotonicClock
  /** Parent absolute expiry. A child can never outlive it. */
  readonly parentExpiresAt?: number
}

export class Deadline {
  readonly expiresAt: number
  readonly now: MonotonicClock

  constructor(expiresAt: number, now: MonotonicClock = monotonicNow) {
    if (!Number.isFinite(expiresAt)) throw new DeadlineError("deadline expiry must be finite")
    this.expiresAt = expiresAt
    this.now = now
  }

  static fromDuration(durationMs: number, options: DeadlineOptions = {}): Deadline {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new DeadlineError("deadline duration must be a finite non-negative number")
    }
    const now = options.now ?? monotonicNow
    const candidate = now() + durationMs
    const expiresAt = options.parentExpiresAt === undefined ? candidate : Math.min(candidate, options.parentExpiresAt)
    return new Deadline(expiresAt, now)
  }

  static at(expiresAt: number, now: MonotonicClock = monotonicNow): Deadline {
    return new Deadline(expiresAt, now)
  }

  remaining(now = this.now()): number {
    return Math.max(0, this.expiresAt - now)
  }

  expired(now = this.now()): boolean {
    return this.remaining(now) <= 0
  }

  child(maxDurationMs: number): Deadline {
    return Deadline.fromDuration(maxDurationMs, { now: this.now, parentExpiresAt: this.expiresAt })
  }

  /**
   * Return a fresh signal that aborts at this deadline and when the parent
   * signal aborts. The timer is unref'd where supported so it cannot keep the
   * process alive after the caller has released the signal.
   */
  signal(parent?: AbortSignal): AbortSignal {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = (reason: unknown) => {
      if (controller.signal.aborted) return
      controller.abort(reason instanceof Error ? reason : new Error(String(reason ?? "deadline exceeded")))
    }
    if (parent) {
      if (parent.aborted) abort(parent.reason)
      else parent.addEventListener("abort", () => abort(parent.reason), { once: true })
    }
    const remaining = this.remaining()
    if (remaining <= 0) abort(new Error("deadline exceeded"))
    else {
      timer = setTimeout(() => abort(new Error("deadline exceeded")), remaining)
      const maybeTimer = timer as ReturnType<typeof setTimeout> & { unref?: () => void }
      maybeTimer.unref?.()
    }
    return controller.signal
  }
}

export function combineAbortSignals(...signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController()
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason)
  }
  for (const signal of signals) {
    if (!signal) continue
    if (signal.aborted) abort(signal)
    else signal.addEventListener("abort", () => abort(signal), { once: true })
  }
  return controller.signal
}

export function monotonicMilliseconds(): number {
  return monotonicNow()
}
