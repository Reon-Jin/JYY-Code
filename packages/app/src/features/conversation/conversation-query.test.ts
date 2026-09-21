import type { DesktopClient } from "../../data/sdk"
import { describe, expect, it, vi } from "vitest"
import { loadConversation } from "./conversation-query"

describe("loadConversation", () => {
  it("rejects a missing message response instead of replacing history with an empty snapshot", async () => {
    const client = {
      session: { messages: vi.fn(async () => ({ data: undefined })) },
    } as unknown as DesktopClient

    await expect(loadConversation({ client, directory: "C:\\work", sessionID: "ses_1" })).rejects.toThrow()
  })
})
