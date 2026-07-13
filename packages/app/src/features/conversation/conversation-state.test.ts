import type { GlobalEvent, Message, TextPart } from "@jyycode-ai/sdk/v2/client"
import { describe, expect, it, vi } from "vitest"
import {
  applyConversationEvent,
  applyConversationEvents,
  emptyConversationSnapshot,
  snapshotFromMessages,
} from "./conversation-state"
import { conversationQueryOptions, loadConversation } from "./conversation-query"
import { createDesktopQueryClient } from "../../data/query-client"
import { keys } from "../../data/query-keys"

const sessionID = "ses_1"
const message: Message = {
  id: "msg_1",
  sessionID,
  role: "user",
  time: { created: 1 },
  agent: "build",
  model: { providerID: "openai", modelID: "gpt-5" },
}
const part: TextPart = {
  id: "part_1",
  sessionID,
  messageID: message.id,
  type: "text",
  text: "",
}

function event(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "C:\\work\\demo", payload }
}

function delta(text: string, id: string) {
  return event({
    id,
    type: "message.part.delta",
    properties: {
      sessionID,
      messageID: message.id,
      partID: part.id,
      field: "text",
      delta: text,
    },
  })
}

function textOf(snapshot: ReturnType<typeof emptyConversationSnapshot>, partID: string) {
  const found = snapshot.messages.flatMap((item) => item.parts).find((item) => item.id === partID)
  return found?.type === "text" ? found.text : undefined
}

describe("conversation state", () => {
  it("appends a delta exactly once", () => {
    const snapshot = snapshotFromMessages(sessionID, [{ info: message, parts: [part] }])
    const once = applyConversationEvent(snapshot, delta("hello", "evt_1"))
    const twice = applyConversationEvent(once, delta("hello", "evt_1"))

    expect(textOf(twice, part.id)).toBe("hello")
  })

  it("inserts messages and parts in ID order even when a batch arrives out of order", () => {
    const messageEvent = event({
      id: "evt_message",
      type: "message.updated",
      properties: { sessionID, info: message },
    })
    const partEvent = event({
      id: "evt_part",
      type: "message.part.updated",
      properties: { sessionID, part, time: 1 },
    })

    const next = applyConversationEvents(emptyConversationSnapshot(sessionID), [partEvent, messageEvent])

    expect(next.messages[0]?.info.id).toBe(message.id)
    expect(next.messages[0]?.parts[0]?.id).toBe(part.id)
    expect(next.needsRefetch).toBe(false)
  })

  it("requests a refetch when a delta has no base part", () => {
    const next = applyConversationEvent(emptyConversationSnapshot(sessionID), delta("x", "evt_2"))

    expect(next.needsRefetch).toBe(true)
    expect(next.messages).toEqual([])
  })

  it("leaves the snapshot unchanged when a delta targets a non-string field", () => {
    const snapshot = snapshotFromMessages(sessionID, [{ info: message, parts: [part] }])
    const invalid = event({
      id: "evt_invalid",
      type: "message.part.delta",
      properties: {
        sessionID,
        messageID: message.id,
        partID: part.id,
        field: "metadata",
        delta: "x",
      },
    })

    const next = applyConversationEvent(snapshot, invalid)

    expect(next.messages).toEqual(snapshot.messages)
    expect(next.needsRefetch).toBe(true)
  })

  it("loads the latest 100 SDK messages without changing their domain shape", async () => {
    const messages = [{ info: message, parts: [part] }]
    const client = {
      session: { messages: vi.fn(async () => ({ data: messages })) },
    }

    const snapshot = await loadConversation({ client: client as never, directory: "C:\\work\\demo", sessionID })

    expect(client.session.messages).toHaveBeenCalledWith(
      { directory: "C:\\work\\demo", sessionID, limit: 100 },
      { throwOnError: true },
    )
    expect(snapshot.messages).toEqual(messages)
  })

  it("forwards the query abort signal to the SDK request", async () => {
    const client = {
      session: { messages: vi.fn(async () => ({ data: [] })) },
    }
    const signal = new AbortController().signal
    const options = conversationQueryOptions({
      client: client as never,
      directory: "C:\\work\\demo",
      sessionID,
    })

    await options.queryFn({ signal })

    expect(client.session.messages).toHaveBeenCalledWith(
      { directory: "C:\\work\\demo", sessionID, limit: 100 },
      { throwOnError: true, signal },
    )
  })

  it("preserves processed event IDs when a snapshot refetch completes", async () => {
    const directory = "C:\\work\\demo"
    const queryClient = createDesktopQueryClient()
    const current = applyConversationEvent(
      snapshotFromMessages(sessionID, [{ info: message, parts: [part] }]),
      delta("hello", "evt_kept"),
    )
    queryClient.setQueryData(keys.messages(directory, sessionID), current)
    const client = {
      session: { messages: vi.fn(async () => ({ data: current.messages })) },
    }

    const snapshot = await loadConversation({ client: client as never, directory, sessionID, queryClient })

    expect(snapshot.processedEventIDs).toContain("evt_kept")
  })
})
