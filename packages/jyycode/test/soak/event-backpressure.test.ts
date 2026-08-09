import { expect, test } from "bun:test"
import { ReliableHub } from "../../src/bus/reliable-hub"
import { eventPolicy } from "../../src/bus/policy"

test("slow consumers remain bounded and receive an explicit gap/close signal", async () => {
  const result = await Promise.race([
    Promise.resolve().then(() => {
      const hub = new ReliableHub<{ session: string; value: number }>()
      const coalescible = hub.subscribe(
        "slow-delta",
        eventPolicy("coalescible", { capacity: 8, key: (event: unknown) => (event as { session: string }).session }),
      )
      const lossless = hub.subscribe("slow-durable", eventPolicy("lossless-bounded", { capacity: 8 }))
      for (let index = 0; index < 10_000; index++) hub.publish({ session: `s${index % 32}`, value: index })
      return { coalescible, lossless, hub }
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("backpressure watchdog expired")), 5_000)),
  ])

  expect(result.coalescible.pending()).toBeLessThanOrEqual(8)
  expect(result.coalescible.drain()[0]?.gap).toBe(true)
  expect(result.lossless.isClosed()).toBe(true)
  expect(result.hub.subscriberCount()).toBe(1)
})
