import { expect, test } from "bun:test"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { pruneToolPart } from "../../src/session/payload-pruner"
import { BlobStore } from "../../src/storage/blob"

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
  expect(pruned.state.output).toContain("[tool output truncated")
  expect(pruned.state.output).toContain("blob:sha256:")
  expect(pruned.state.time.compacted).toBe(99)
  const blobRef = pruned.state.compactedPayload?.blobRef
  expect(typeof blobRef).toBe("string")
  if (typeof blobRef !== "string") return
  expect(blobRef).toMatch(/^blob:sha256:[a-f0-9]{64}$/)
  const compacted = pruned.state.compactedPayload
  expect(compacted?.version).toBe(1)
  expect(compacted?.input.bytes).toBeTypeOf("number")
  expect(compacted?.input.sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(compacted?.output.bytes).toBe(Buffer.byteLength(output))
  expect(compacted?.output.sha256).toMatch(/^[a-f0-9]{64}$/)
  expect(compacted?.attachments.count).toBe(1)
  expect(compacted?.attachments.bytes).toBe(attachmentBytes.byteLength)
  expect(typeof compacted?.preview).toBe("string")
  expect(JSON.stringify(pruned).length).toBeLessThan(20_000)
  expect(Buffer.from(await new BlobStore().readURL(blobRef)).toString("utf8")).toBe(output)
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
