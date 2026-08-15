import crypto from "node:crypto"
import type { MessageV2 } from "./message-v2"
import { BlobStore } from "@/storage/blob"
import { DEFAULT_OUTPUT_PREVIEW_BYTES, modelOutputSummary, retainOutput } from "@jyycode-ai/core/output-retention"

export const DEFAULT_TOOL_PREVIEW_BYTES = DEFAULT_OUTPUT_PREVIEW_BYTES
export const MAX_TOOL_PREVIEW_BYTES = DEFAULT_OUTPUT_PREVIEW_BYTES

export type PayloadPruneOptions = {
  readonly previewBytes?: number
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
  const previewBytes = Math.max(
    0,
    Math.min(
      MAX_TOOL_PREVIEW_BYTES,
      Math.floor(options.previewBytes ?? DEFAULT_TOOL_PREVIEW_BYTES),
    ),
  )
  const inputJSON = stableJSON(part.state.input)
  const output = part.state.output
  const blobStore = options.blobStore ?? new BlobStore()
  const attachments = await Promise.all(
    (part.state.attachments ?? []).map((attachment) => blobStore.describeURL(attachment.url, attachment.mime)),
  )
  const compactedAt = options.now ?? Date.now()
  const retained = await retainOutput([output], {
    maxBytes: previewBytes,
    strategy: "head_tail",
    ...(Buffer.byteLength(output, "utf8") > previewBytes
      ? {
          blob: {
            write: async (source: AsyncIterable<Uint8Array>) => {
              const record = await blobStore.put({ source, mime: "text/plain; charset=utf-8", persistMetadata: true })
              return { ref: record.url }
            },
          },
        }
      : {}),
  })
  const preview = retained.preview
  const modelOutput = modelOutputSummary(retained)

  return {
    ...part,
    state: {
      status: "completed",
      input: { __compacted: true },
      output: modelOutput,
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
        ...(retained.blobRef ? { blobRef: retained.blobRef } : {}),
        ...(retained.blobError ? { blobError: retained.blobError } : {}),
      },
    },
  }
}
