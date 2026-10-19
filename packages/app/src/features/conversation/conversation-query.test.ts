import type { DesktopClient } from "../../data/sdk"
import { describe, expect, it, vi } from "vitest"
import { conversationQueryOptions, loadConversation } from "./conversation-query"
import { snapshotFromMessages, type ConversationMessage } from "./conversation-state"
import { createDesktopQueryClient } from "../../data/query-client"
import { keys } from "../../data/query-keys"
import { QueryObserver } from "@tanstack/solid-query"

function userMessage(id: string, sessionID: string, created: number): ConversationMessage {
  return {
    info: { id, sessionID, role: "user", time: { created }, agent: "build", model: { providerID: "test", modelID: "test" } },
    parts: [{ id: `part_${id}`, messageID: id, sessionID, type: "text", text: id }],
  }
}

describe("loadConversation", () => {
  it.each([false, true])("loads full history from a fresh event-only cache (switching=%s)", async (switching) => {
    const directory = "C:\\work"
    const sessionID = "ses_history"
    const queryClient = createDesktopQueryClient()
    const earlier = userMessage("earlier", sessionID, 1)
    const recent = userMessage("recent", sessionID, 2)
    const key = keys.messages(directory, sessionID)
    const partial = snapshotFromMessages(sessionID, [recent])
    queryClient.setQueryData(key, partial)
    // An inactive stream cache is initially invalidated; subsequent SSE writes
    // mark it fresh again even though it has never loaded persisted history.
    await queryClient.invalidateQueries({ queryKey: key, exact: true })
    queryClient.setQueryData(key, { ...partial })
    const client = {
      session: { messages: vi.fn(async () => ({ data: [earlier, recent] })) },
    } as unknown as DesktopClient
    const options = conversationQueryOptions({ client, directory, sessionID, queryClient })
    const observer = new QueryObserver(
      queryClient,
      switching ? { ...options, queryKey: keys.messages(directory, "ses_other"), enabled: false } : options,
    )
    const unsubscribe = observer.subscribe(() => {})
    try {
      if (switching) observer.setOptions(options)
      await vi.waitFor(() => expect(client.session.messages).toHaveBeenCalledTimes(1))
      await vi.waitFor(() =>
        expect(observer.getCurrentResult().data?.messages.map((message) => message.info.id)).toEqual(["earlier", "recent"]),
      )
    } finally {
      unsubscribe()
      queryClient.clear()
    }
  })

  it("accepts authoritative screenshot removal instead of treating every cached tool as newer", async () => {
    const message = { info: { id: "m", sessionID: "s", role: "assistant", time: { created: 1 } },
      parts: [{ id: "p", messageID: "m", sessionID: "s", type: "tool", tool: "computer", callID: "c",
        state: { status: "completed", input: {}, output: "done", title: "Computer", metadata: {}, time: { start: 1, end: 2 },
          attachments: [{ type: "file", mime: "image/png", url: "data:image/png;base64,old" }] } }],
    } as ConversationMessage
    const queryClient = createDesktopQueryClient()
    queryClient.setQueryData(keys.messages("d", "s"), snapshotFromMessages("s", [message]))
    const fetched = structuredClone(message)
    const tool = fetched.parts[0]!
    if (tool.type === "tool" && tool.state.status === "completed") tool.state.attachments = undefined
    const client = { session: { messages: vi.fn(async () => ({ data: [fetched] })) } } as unknown as DesktopClient
    try {
      const result = await loadConversation({ client, directory: "d", sessionID: "s", queryClient })
      expect(result.messages[0]!.parts[0]).toMatchObject({ state: { output: "done", attachments: undefined } })
    } finally { queryClient.clear() }
  })

  it("rejects a missing message response instead of replacing history with an empty snapshot", async () => {
    const client = {
      session: { messages: vi.fn(async () => ({ data: undefined })) },
    } as unknown as DesktopClient

    await expect(loadConversation({ client, directory: "C:\\work", sessionID: "ses_1" })).rejects.toThrow()
  })
})
