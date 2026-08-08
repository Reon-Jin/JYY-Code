import crypto from "node:crypto"
import { describe, expect, it } from "bun:test"
import { SqlitePlanEventStore } from "../../src/plan/event-store"

describe("SqlitePlanEventStore", () => {
  it("assigns per-session sequences and replays after a fresh store instance", () => {
    const sessionId = `event-${crypto.randomUUID()}`
    const first = new SqlitePlanEventStore()
    expect(first.append({ type: "plan.updated", session_id: sessionId, revision: 1, payload: { revision: 1 } })).toMatchObject({
      seq: 0,
      session_id: sessionId,
    })
    expect(first.append({ type: "report_arrived", session_id: sessionId, payload: { taskId: "s1_t1" } }).seq).toBe(1)

    const restarted = new SqlitePlanEventStore()
    expect(restarted.lastSequence(sessionId)).toBe(1)
    expect(restarted.readAfter(sessionId, 0).map((event) => event.type)).toEqual(["report_arrived"])
  })
})
