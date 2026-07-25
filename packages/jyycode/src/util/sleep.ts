/**
 * Abort-responsive sleep. Resolves after `ms` milliseconds, or immediately
 * when `signal` aborts (so backoff loops don't block shutdown).
 *
 * By default, abort resolves silently; the caller should check
 * `signal.aborted` after the await. Pass `throwOnAbort: true` to have
 * abort reject.
 *
 * Ported from claudecode's src/utils/sleep.ts.
 */
export function sleep(
  ms: number,
  signal?: AbortSignal,
  opts?: { throwOnAbort?: boolean; abortError?: () => Error; unref?: boolean },
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      if (opts?.throwOnAbort || opts?.abortError) {
        void reject(opts.abortError?.() ?? new Error("aborted"))
      } else {
        void resolve()
      }
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      if (opts?.throwOnAbort || opts?.abortError) {
        void reject(opts.abortError?.() ?? new Error("aborted"))
      } else {
        void resolve()
      }
    }
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      void resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
    if (opts?.unref) {
      timer.unref()
    }
  })
}

/**
 * Race a promise against a timeout. Rejects with `Error(message)` if the
 * promise doesn't settle within `ms`. The timeout timer is cleared when
 * the promise settles (no dangling timer) and unref'd so it doesn't
 * block process exit.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
    if (typeof timer === "object") timer.unref?.()
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/**
 * Create a stream watchdog that aborts hung streams after `timeoutMs` of
 * inactivity. Returns an `{ onActivity, destroy }` pair.
 *
 * - `onActivity()`: call whenever data arrives to reset the timer
 * - `destroy()`: clean up the watchdog
 *
 * If no activity occurs within `timeoutMs`, the `onTimeout` callback fires.
 *
 * Ported from claudecode's streaming watchdog in services/api/claude.ts.
 */
export function createStreamWatchdog(
  timeoutMs: number,
  onTimeout: () => void,
): { onActivity: () => void; destroy: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let destroyed = false

  const schedule = () => {
    if (destroyed) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      if (!destroyed) onTimeout()
    }, timeoutMs)
    timer.unref?.()
  }

  const onActivity = () => {
    if (destroyed) return
    schedule()
  }

  const destroy = () => {
    destroyed = true
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  // Start the initial timer
  schedule()

  return { onActivity, destroy }
}
