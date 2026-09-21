import { Effect, Semaphore } from "effect"

export const DEFAULT_MAX_RUNNING_CHILDREN = 4

/** One admission queue per backend process, shared by all project instances. */
export function makeChildExecutionLimiter() {
  const semaphore = Semaphore.makeUnsafe(DEFAULT_MAX_RUNNING_CHILDREN)
  return {
    run<A, E, R>(work: Effect.Effect<A, E, R>, limit = DEFAULT_MAX_RUNNING_CHILDREN): Effect.Effect<A, E, R> {
      return Effect.gen(function* () {
        yield* semaphore.resize(limit)
        return yield* semaphore.withPermits(1)(work)
      })
    },
  }
}

export const childExecutionLimiter = makeChildExecutionLimiter()
