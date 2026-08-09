import { describe, expect, test } from "bun:test"
import { deliver, reconcilePending, transition, type InteractionRecord } from "@/interaction/lifecycle"

const record: InteractionRecord = {
  id: "q1",
  sessionID: "ses1",
  sequence: 1,
  createdAt: 1,
  expiresAt: 100,
  deliveryCount: 0,
  state: "pending",
}

describe("interaction lifecycle", () => {
  test("reconnect delivery is observable and terminal transitions are idempotent", () => {
    const delivered = deliver(record, 2)
    expect(delivered.deliveryCount).toBe(1)
    const cancelled = transition(delivered, "cancel", 3)
    expect(transition(cancelled, "answer", 4)).toEqual(cancelled)
  })

  test("parked interactions expire without becoming running work", () => {
    const parked = transition(record, "park", 2)
    expect(reconcilePending([parked], 100)[0]?.state).toBe("expired")
  })
})
