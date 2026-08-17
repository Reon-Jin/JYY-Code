import { describe, expect, test } from "bun:test"
import { normalizeEventPayload } from "../../../src/cli/cmd/tui/context/event"

describe("normalizeEventPayload", () => {
  test("独立 message.* 事件保持不变", () => {
    const payload = { id: "e1", type: "message.updated", properties: { sessionID: "s1", info: {} } }
    expect(normalizeEventPayload(payload)).toEqual(payload)
  })

  test("sync 信封解包 session.next.message.updated → message.updated", () => {
    const envelope = {
      type: "sync",
      syncEvent: {
        type: "session.next.message.updated.1",
        id: "evt1",
        data: { sessionID: "s1", info: { id: "m1" } },
      },
    }
    const normalized = normalizeEventPayload(envelope)
    expect(normalized.type).toBe("message.updated")
    expect(normalized.id).toBe("evt1")
    expect(normalized.properties).toEqual({ sessionID: "s1", info: { id: "m1" } })
  })

  test("sync 信封解包 session.next.message.part.updated → message.part.updated", () => {
    const envelope = {
      type: "sync",
      syncEvent: { type: "session.next.message.part.updated.3", id: "evt2", data: { sessionID: "s1", part: {} } },
    }
    const normalized = normalizeEventPayload(envelope)
    expect(normalized.type).toBe("message.part.updated")
    expect(normalized.properties).toEqual({ sessionID: "s1", part: {} })
  })

  test("非消息类 sync 信封保持原样（type 仍为 sync）", () => {
    const envelope = { type: "sync", syncEvent: { type: "session.next.plan.updated.1", data: {} } }
    expect(normalizeEventPayload(envelope).type).toBe("sync")
  })

  test("name 字段兜底", () => {
    const envelope = { type: "sync", syncEvent: { name: "session.next.message.removed.1", data: { messageID: "m1" } } }
    expect(normalizeEventPayload(envelope).type).toBe("message.removed")
  })
})
