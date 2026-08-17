import { expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { DEFAULT_CONFIG_DEPENDENCY_WAIT_TIMEOUT_MS, waitForDependencyFibers } from "../../src/config/config"

test("config dependency wait returns degraded after its budget", async () => {
  const fiber = Effect.runFork(Effect.never.pipe(Effect.asVoid))

  try {
    const started = performance.now()
    const result = await Effect.runPromise(waitForDependencyFibers([fiber], 20))

    expect(result).toBe(false)
    expect(performance.now() - started).toBeLessThan(DEFAULT_CONFIG_DEPENDENCY_WAIT_TIMEOUT_MS)
  } finally {
    await Effect.runPromise(Fiber.interrupt(fiber))
  }
})
