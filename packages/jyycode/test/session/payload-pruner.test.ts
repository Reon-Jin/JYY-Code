import { expect, test } from "bun:test"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { pruneToolPart } from "../../src/session/payload-pruner"

test("prunes completed tool payloads to bounded metadata and preview", async () => {
  const output = "x".repeat(5 * 1024 * 1024)
  const attachmentBytes = Buffer.alloc(10 * 1024, 7)
  const part = {
    id: PartID.make("prt_prune_payload"),
    messageID: MessageID.make("msg_prune_payload"),
    sessionID: SessionID.make("ses_prune_payload"),
    type: "tool" as const,
    callID: "call_prune_payload",
    tool: "lookup",
    state: {
      status: "completed" as const,
      input: { query: "x".repeat(1024 * 1024) },
      output,
      title: "Lookup",
      metadata: { raw: "y".repeat(1024 * 1024) },
      time: { start: 1, end: 2 },
      attachments: [
        {
          id: PartID.make("prt_prune_attachment"),
          messageID: MessageID.make("msg_prune_payload"),
          sessionID: SessionID.make("ses_prune_payload"),
          type: "file" as const,
          mime: "application/octet-stream",
          url: `data:application/octet-stream;base64,${attachmentBytes.toString("base64")}`,
        },
      ],
    },
  }

  const pruned = await pruneToolPart(part, { now: 99, previewChars: 128 })
  expect(pruned.state.status).toBe("completed")
  if (pruned.state.status !== "completed") return
  expect(pruned.state.input).toEqual({ __compacted: true })
  expect(pruned.state.metadata).toEqual({})
  expect(pruned.state.attachments).toBeUndefined()
  expect(pruned.state.output).toHaveLength(128)
  expect(pruned.state.time.compacted).toBe(99)
  expect(pruned.state.compactedPayload).toMatchObject({
    version: 1,
    input: { bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    output: { bytes: Buffer.byteLength(output), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    attachments: { count: 1, bytes: attachmentBytes.byteLength },
    preview: output.slice(0, 128),
  })
  expect(JSON.stringify(pruned).length).toBeLessThan(20_000)
})

test("does not rewrite active or non-completed tool states", async () => {
  const part = {
    id: PartID.make("prt_prune_running"),
    messageID: MessageID.make("msg_prune_running"),
    sessionID: SessionID.make("ses_prune_running"),
    type: "tool" as const,
    callID: "call_prune_running",
    tool: "lookup",
    state: { status: "running" as const, input: {}, time: { start: 1 } },
  }
  expect(await pruneToolPart(part)).toBe(part)
})
