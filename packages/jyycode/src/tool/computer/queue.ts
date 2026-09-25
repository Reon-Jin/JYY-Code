/** Serializes desktop transactions while allowing a waiting caller to cancel promptly. */
export function createComputerQueue() {
  let tail: Promise<void> = Promise.resolve()
  return function enqueue<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = tail
    let release!: () => void
    tail = new Promise<void>((resolve) => { release = resolve })
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const interrupted = () => {
        if (settled) return
        settled = true
        reject(new Error("Computer operation interrupted"))
      }
      signal?.addEventListener("abort", interrupted, { once: true })
      if (signal?.aborted) interrupted()
      void previous.then(async () => {
        if (settled) {
          signal?.removeEventListener("abort", interrupted)
          release()
          return
        }
        try {
          const value = await work()
          if (!settled) { settled = true; resolve(value) }
        } catch (error) {
          if (!settled) { settled = true; reject(error) }
        } finally {
          signal?.removeEventListener("abort", interrupted)
          release()
        }
      })
    })
  }
}
