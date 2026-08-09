import crypto from "node:crypto"
import type { MessageV2 } from "./message-v2"
import { BlobStore } from "@/storage/blob"

export const DEFAULT_TOOL_PREVIEW_CHARS = 4 * 1024
export const MAX_TOOL_PREVIEW_CHARS = 4 * 1024

export type PayloadPruneOptions = {
  readonly previewChars?: number
  readonly now?: number
  readonly blobStore?: BlobStore
}

function stableJSON(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(",")}]`
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJSON((value as Record<string, unknown>)[key])}`)
    .join(",")}}`
}

function digest(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex")
}

function bytes(value: string) {
  return Buffer.byteLength(value, "utf8")
}

export async function pruneToolPart(
  part: MessageV2.ToolPart,
  options: PayloadPruneOptions = {},
): Promise<MessageV2.ToolPart> {
  if (part.state.status !== "completed") return part
  const previewChars = Math.max(
    0,
    Math.min(MAX_TOOL_PREVIEW_CHARS, Math.floor(options.previewChars ?? DEFAULT_TOOL_PREVIEW_CHARS)),
  )
  const inputJSON = stableJSON(part.state.input)
  const output = part.state.output
  const blobStore = options.blobStore ?? new BlobStore()
  const attachments = await Promise.all(
    (part.state.attachments ?? []).map((attachment) => blobStore.describeURL(attachment.url, attachment.mime)),
  )
  const compactedAt = options.now ?? Date.now()
  const preview = output.slice(0, previewChars)

  return {
    ...part,
    state: {
      status: "completed",
      input: { __compacted: true },
      output: preview,
      title: part.state.title,
      metadata: {},
      time: { start: part.state.time.start, end: part.state.time.end, compacted: compactedAt },
      compactedPayload: {
        version: 1,
        input: { sha256: digest(inputJSON), bytes: bytes(inputJSON) },
        output: { sha256: digest(output), bytes: bytes(output) },
        attachments: {
          count: attachments.length,
          bytes: attachments.reduce((total, attachment) => total + attachment.size, 0),
          sha256: attachments.map((attachment) => attachment.digest),
        },
        preview,
      },
    },
  }
}
