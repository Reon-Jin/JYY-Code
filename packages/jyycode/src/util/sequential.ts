/**
 * Sequential execution wrapper for async functions to prevent race conditions.
 * Ensures that concurrent calls to the wrapped function are executed one at a
 * time in FIFO order, while preserving correct return values.
 *
 * Useful for operations that must be performed sequentially, such as
 * file writes or database updates that could cause conflicts if executed
 * concurrently.
 *
 * Ported from claudecode's src/utils/sequential.ts.
 */

type QueueItem<T extends unknown[], R> = {
  args: T
  resolve: (value: R) => void
  reject: (reason?: unknown) => void
  context: unknown
}

export function sequential<T extends unknown[], R>(
  fn: (...args: T) => Promise<R>,
): (...args: T) => Promise<R> {
  const queue: QueueItem<T, R>[] = []
  let processing = false

  async function processQueue(): Promise<void> {
    if (processing) return
    if (queue.length === 0) return

    processing = true

    while (queue.length > 0) {
      const { args, resolve, reject, context } = queue.shift()!

      try {
        const result = await fn.apply(context, args)
        resolve(result)
      } catch (error) {
        reject(error)
      }
    }

    processing = false

    // Check if new items were added while processing
    if (queue.length > 0) {
      void processQueue()
    }
  }

  return function (this: unknown, ...args: T): Promise<R> {
    return new Promise((resolve, reject) => {
      queue.push({ args, resolve, reject, context: this })
      void processQueue()
    })
  }
}

/**
 * Convert an async generator to an array.
 * Ported from claudecode's src/utils/generators.ts.
 */
export async function generatorToArray<A>(
  generator: AsyncGenerator<A, void>,
): Promise<A[]> {
  const result: A[] = []
  for await (const a of generator) {
    result.push(a)
  }
  return result
}

/**
 * Run async generators concurrently up to a concurrency cap, yielding
 * values as they arrive. Uses Promise.race for fairness.
 *
 * Ported from claudecode's src/utils/generators.ts all().
 */
export async function* generatorsAll<A>(
  generators: AsyncGenerator<A, void>[],
  concurrencyCap = Infinity,
): AsyncGenerator<A, void> {
  type Queued = {
    done: boolean | void
    value: A | void
    generator: AsyncGenerator<A, void>
    promise: Promise<Queued>
  }

  const next = (generator: AsyncGenerator<A, void>): Promise<Queued> => {
    const promise = generator.next().then(({ done, value }) => ({
      done,
      value,
      generator,
      promise,
    }))
    return promise
  }

  const waiting = [...generators]
  const promises = new Set<Promise<Queued>>()

  while (promises.size < concurrencyCap && waiting.length > 0) {
    const gen = waiting.shift()!
    promises.add(next(gen))
  }

  while (promises.size > 0) {
    const { done, value, generator, promise } = await Promise.race(promises)
    promises.delete(promise)

    if (!done) {
      promises.add(next(generator))
      if (value !== undefined) {
        yield value as Awaited<A>
      }
    } else if (waiting.length > 0) {
      const nextGen = waiting.shift()!
      promises.add(next(nextGen))
    }
  }
}
