import { describe, expect, it } from "vitest"
import type { Part } from "@jyycode-ai/sdk/v2/client"
import { limitComputerScreenshots, COMPUTER_SCREENSHOT_URL_BUDGET } from "./computer-screenshot-budget"
import { snapshotFromMessages, applyConversationEvent, type ConversationMessage } from "./conversation-state"

function entry(index: number, url = `data:image/png;base64,${index}`): ConversationMessage {
  return {
    info: { id: `m${index}`, sessionID: "s", role: "assistant", time: { created: index } },
    parts: [
      {
        id: `p${index}`,
        messageID: `m${index}`,
        sessionID: "s",
        type: "tool",
        tool: "computer",
        callID: `c${index}`,
        state: {
          status: "completed",
          input: {},
          title: "Computer",
          output: "observation",
          metadata: {},
          time: { start: index, end: index },
          attachments: [
            { type: "file", id: `f${index}`, sessionID: "s", messageID: `m${index}`, mime: "image/png", url },
          ],
        },
      },
    ],
  } as ConversationMessage
}
function screenshots(messages: readonly ConversationMessage[]) {
  return messages
    .flatMap((m) => m.parts)
    .flatMap((p) => (p.type === "tool" && p.state.status === "completed" ? (p.state.attachments ?? []) : []))
    .filter((a) => a.mime.startsWith("image/"))
}

describe("desktop screenshot memory budget", () => {
  it("bounds a long game history on load and on each live result even if prune events never arrive", () => {
    const messages = Array.from({ length: 1000 }, (_, i) => entry(i))
    let snapshot = snapshotFromMessages("s", messages)
    expect(screenshots(snapshot.messages)).toHaveLength(3)
    expect(screenshots(messages)).toHaveLength(1000)
    for (let i = 0; i < 100; i++) {
      const updated = entry(i).parts[0]!
      snapshot = applyConversationEvent(snapshot, {
        directory: "d",
        payload: { id: `e${i}`, type: "message.part.updated", properties: { sessionID: "s", part: updated, time: i } },
      })
      expect(screenshots(snapshot.messages).length).toBeLessThanOrEqual(3)
    }
    expect(snapshot.messages).toHaveLength(1000)
    expect(snapshot.messages[0]!.parts[0]).toMatchObject({ state: { output: "observation" } })
  })

  it("caps bytes as well as count, preserves uploads and unrelated tools, and reuses unchanged messages", () => {
    const oversized = entry(0, "x".repeat(COMPUTER_SCREENSHOT_URL_BUDGET / 2 + 1))
    const upload = { ...entry(1), parts: [{ type: "file", mime: "image/png", url: "user-image" } as Part] }
    const other = entry(2)
    ;(other.parts[0] as { tool: string }).tool = "read"
    const result = limitComputerScreenshots([oversized, upload, other])
    expect(result[0]).not.toBe(oversized)
    expect(result[1]).toBe(upload)
    expect(result[2]).toBe(other)
    expect(screenshots(result).map((a) => a.url)).toEqual(["data:image/png;base64,2"])
    expect(limitComputerScreenshots(result)).toBe(result)
  })
})
