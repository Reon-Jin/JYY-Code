import { expect, test } from "bun:test"
import { disposeInstance, registerDisposer } from "../../src/effect/instance-registry"

test("instance disposal does not wait forever for one disposer", async () => {
  let called = false
  const off = registerDisposer(async () => {
    called = true
    await new Promise<void>(() => undefined)
  })

  try {
    const started = performance.now()
    await disposeInstance("instance-registry-timeout-test", 20)

    expect(called).toBe(true)
    expect(performance.now() - started).toBeLessThan(500)
  } finally {
    off()
  }
})
