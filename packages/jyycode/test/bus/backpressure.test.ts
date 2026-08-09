import { describe, expect, test } from "bun:test"
import { ReliableHub } from "@/bus/reliable-hub"
import { eventPolicy } from "@/bus/policy"

describe("reliable event hub", () => {
  test("coalesces unconsumed deltas and reports a gap", () => {
    const hub = new ReliableHub<{ key: string; value: number }>()
    const subscriber = hub.subscribe(
      "slow",
      eventPolicy("coalescible", { capacity: 2, key: (event) => (event as { key: string }).key }),
    )
    hub.publish({ key: "a", value: 1 })
    hub.publish({ key: "a", value: 2 })
    hub.publish({ key: "b", value: 3 })
    hub.publish({ key: "c", value: 4 })
    expect(subscriber.pending()).toBe(2)
    expect(subscriber.drain()).toEqual([{ event: { key: "b", value: 3 }, gap: true }, { event: { key: "c", value: 4 } }])
  })

  test("closes a subscriber that cannot keep up with bounded lossless events", () => {
    const hub = new ReliableHub<number>()
    const subscriber = hub.subscribe("slow", eventPolicy("lossless-bounded", { capacity: 2 }))
    expect(hub.publish(1).closed).toBe(0)
    expect(hub.publish(2).closed).toBe(0)
    expect(hub.publish(3).closed).toBe(1)
    expect(subscriber.isClosed()).toBe(true)
    expect(hub.subscriberCount()).toBe(0)
  })
})
