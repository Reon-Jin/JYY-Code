import type { DesktopClient } from "../../data/sdk"
import { describe, expect, it, vi } from "vitest"
import { loadConversation } from "./conversation-query"
import { snapshotFromMessages, type ConversationMessage } from "./conversation-state"
import { createDesktopQueryClient } from "../../data/query-client"
import { keys } from "../../data/query-keys"

describe("loadConversation", () => {
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
