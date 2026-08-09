import { describe, expect, test } from "bun:test"
import { estimateFork, FORK_BUDGET_HARD_LIMITS } from "@/session/fork-budget"
import { MessageID, PartID, SessionID } from "@/session/schema"
import type { MessageV2 } from "@/session/message-v2"

const sessionID = SessionID.make("ses_fork_budget")
const messageID = MessageID.make("msg_fork_budget")

const message = (part: MessageV2.Part): MessageV2.WithParts => ({
  info: {
    id: messageID,
    sessionID,
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "p", modelID: "m" },
  } as unknown as MessageV2.WithParts["info"],
  parts: [part],
})

describe("fork budget", () => {
  test("shared blob references do not count as new physical bytes", () => {
    const part = {
      id: PartID.make("prt_fork_budget"),
      sessionID,
      messageID,
      type: "file",
      mime: "image/png",
      url: `blob:sha256:${"a".repeat(64)}`,
    } as MessageV2.FilePart
    const result = estimateFork([message(part), message({ ...part, id: PartID.make("prt_fork_budget_2") })])
    expect(result.physicalBlobBytesAdded).toBe(0)
    expect(result.allowed).toBe(true)
  })

  test("large inline attachments are counted once and fail closed", () => {
    const bytes = Buffer.alloc(FORK_BUDGET_HARD_LIMITS.maxPhysicalBlobBytes + 1, 1)
    const part = {
      id: PartID.make("prt_fork_budget_data"),
      sessionID,
      messageID,
      type: "file",
      mime: "application/octet-stream",
      url: `data:application/octet-stream;base64,${bytes.toString("base64")}`,
    } as MessageV2.FilePart
    const result = estimateFork([message(part), message({ ...part, id: PartID.make("prt_fork_budget_data_2") })])
    expect(result.physicalBlobBytesAdded).toBe(bytes.byteLength)
    expect(result.reasons).toContain("physical-blob-bytes")
    expect(result.allowed).toBe(false)
  })
})
