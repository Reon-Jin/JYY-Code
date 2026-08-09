import { describe, expect, test } from "bun:test"
import { classifyEvent, DEFAULT_EVENT_POLICIES } from "@/bus/policy"

describe("event replay policy", () => {
  test("classifies durable interactions separately from coalescible deltas", () => {
    expect(classifyEvent("message.part.delta")).toBe("coalescible")
    expect(classifyEvent("permission.asked")).toBe("durable")
    expect(DEFAULT_EVENT_POLICIES.durable.capacity).toBe(1024)
  })
})
