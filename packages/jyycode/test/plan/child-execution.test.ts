import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { makeChildExecutionLimiter } from "../../src/plan/child-execution"

test("limits running children across callers and releases permits after failure", async () => {
  const limiter = makeChildExecutionLimiter()
  let active = 0
  let peak = 0
  await Effect.runPromise(
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const work = Effect.gen(function* () {
        active++
        peak = Math.max(peak, active)
        if (active === 2) yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
        return yield* Effect.fail("expected failure")
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            active--
          }),
        ),
      )
      const all = yield* Effect.forEach(Array.from({ length: 8 }), () => limiter.run(work, 2).pipe(Effect.exit), {
        concurrency: "unbounded",
      }).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      expect(active).toBe(2)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(all)
      expect(peak).toBe(2)
      expect(active).toBe(0)
      expect(yield* limiter.run(Effect.succeed("reused"), 2)).toBe("reused")
    }),
  )
})

test("interrupting a queued child prevents its work from starting", async () => {
  const limiter = makeChildExecutionLimiter()
  let queuedStarted = false
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const first = yield* limiter
        .run(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)), 1)
        .pipe(Effect.forkChild)
      yield* Deferred.await(started)
      const queued = yield* limiter
        .run(
          Effect.sync(() => {
            queuedStarted = true
          }),
          1,
        )
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(queued)
      yield* Fiber.interrupt(first)
      expect(yield* limiter.run(Effect.succeed("next"), 1)).toBe("next")
      expect(queuedStarted).toBe(false)
    }),
  )
})
