import crypto from "node:crypto"
import { describe, expect, it } from "bun:test"
import { SqlitePlanInboxStore } from "../../src/plan/inbox-store"

describe("SqlitePlanInboxStore", () => {
  it("persists pending entries and scopes resolution to the owning session", () => {
    const sessionId = `inbox-${crypto.randomUUID()}`
    const otherSessionId = `inbox-${crypto.randomUUID()}`
    const store = new SqlitePlanInboxStore()
    const entry = store.add({
      session_id: sessionId,
      task_id: "s1_t1",
      kind: "runtime_error",
      message: "child stopped",
      suggested_actions: ["inspect the run"],
    })
    store.add({ session_id: otherSessionId, kind: "runtime_error", message: "other session" })

    expect(store.pending(sessionId)).toHaveLength(1)
    expect(store.resolve(otherSessionId, entry.id)).toBeUndefined()
    const resolved = store.resolve(sessionId, entry.id)
    expect(resolved?.resolved_at).toEqual(expect.any(String))
    expect(store.pending(sessionId)).toHaveLength(0)
    expect(store.list(otherSessionId)).toHaveLength(1)
  })
})
