import { createHash } from "node:crypto"
import type { Tool } from "ai"
import type { LLMRequestPrep } from "./llm/request"
import type { Provider } from "@/provider/provider"

export type RequestRuntime = "ai-sdk" | "native"

export type RequestEnvelopeInput = {
  readonly sessionID: string
  readonly stepID: string
  readonly runtime: RequestRuntime
  readonly model: Provider.Model
  readonly variant?: string
  readonly prepared: LLMRequestPrep.Prepared
  readonly messages: unknown[]
}

export type RequestEnvelope = {
  readonly version: 1
  readonly sessionID: string
  readonly stepID: string
  readonly runtime: RequestRuntime
  readonly model: {
    readonly providerID: string
    readonly id: string
    readonly variant?: string
  }
  readonly system: string[]
  readonly messages: unknown[]
  readonly tools: Record<string, unknown>
  readonly params: {
    readonly temperature?: number
    readonly topP?: number
    readonly topK?: number
    readonly maxOutputTokens?: number
    readonly options: unknown
  }
  readonly headers: Record<string, string>
}

export type RequestEnvelopeArtifact = {
  readonly envelope: RequestEnvelope
  readonly bytes: Uint8Array
  readonly sha256: string
  readonly configHash: string
  readonly toolCatalogHash: string
}

const SECRET_KEY =
  /(?:authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|private[-_]?key)/i

// A computer turn can contain a fresh screenshot on every step. The request
// envelope is an audit artifact, not the request sent to the provider, so keep
// media identity here without copying the pixels into another durable blob.
const MAX_AUDIT_STRING_BYTES = 32 * 1024
const DATA_URL = /data:[a-z\d.+/-]+(?:;[a-z\d=.+/-]+)*,[^\s"'<>]+/gi

function mediaMime(bytes: Uint8Array, fallback?: string) {
  if (fallback) return fallback
  if (bytes.length >= 8 && bytes.subarray(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index]))
    return "image/png"
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg"
  if (bytes.length >= 6 && Buffer.from(bytes.subarray(0, 6)).toString("ascii").startsWith("GIF8")) return "image/gif"
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP") return "image/webp"
  return "application/octet-stream"
}

function mediaRecord(bytes: Uint8Array, mime?: string) {
  return { omitted: "request-envelope-media", mime: mediaMime(bytes, mime), bytes: bytes.byteLength, sha256: sha256(bytes) }
}

function dataURLRecord(value: string) {
  const comma = value.indexOf(",")
  if (!value.startsWith("data:") || comma < 0) return undefined
  const header = value.slice(5, comma)
  const mime = header.split(";")[0] || "text/plain"
  const payload = value.slice(comma + 1)
  let bytes: Uint8Array
  if (header.split(";").some((item) => item.toLowerCase() === "base64")) bytes = Buffer.from(payload, "base64")
  else {
    try { bytes = Buffer.from(decodeURIComponent(payload), "utf8") }
    catch { bytes = Buffer.from(payload, "utf8") }
  }
  return mediaRecord(bytes, mime)
}

function mediaString(value: string, mime?: string, encoded = false): unknown {
  const data = dataURLRecord(value)
  if (data) return data
  if (encoded || (value.length >= 4096 && value.length % 4 === 0 &&
    /^(?:iVBORw0KGgo|\/9j\/|R0lGOD|UklGR)/.test(value) && /^[A-Za-z0-9+/]+={0,2}$/.test(value)))
    return mediaRecord(Buffer.from(value, "base64"), mime)
  if (value.includes("data:")) {
    const replaced = value.replace(DATA_URL, (match) => JSON.stringify(dataURLRecord(match) ?? match))
    if (replaced !== value) return replaced
  }
  if (Buffer.byteLength(value, "utf8") > MAX_AUDIT_STRING_BYTES)
    return mediaRecord(Buffer.from(value, "utf8"), mime ?? "text/plain; charset=utf-8")
  return value
}

function auditMessages(value: unknown, mime?: string, encoded = false, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return mediaString(value, mime, encoded)
  if (value instanceof ArrayBuffer) return mediaRecord(new Uint8Array(value), mime)
  if (ArrayBuffer.isView(value)) return mediaRecord(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), mime)
  if (value instanceof URL) return mediaString(value.toString(), mime)
  if (!value || typeof value !== "object") return value
  if (seen.has(value)) return "[Circular]"
  seen.add(value)
  if (Array.isArray(value)) return value.map((child) => auditMessages(child, mime, false, seen))
  const object = value as Record<string, unknown>
  const mediaType = [object.mediaType, object.mimeType, object.mime].find((item): item is string => typeof item === "string")
  const ownMime = mediaType ?? mime
  const isMedia = object.type === "media" || object.type === "image" || ownMime?.startsWith("image/") === true
  return Object.fromEntries(Object.entries(object).map(([key, child]) => [
    key,
    auditMessages(child, ownMime, isMedia && key === "data", seen),
  ]))
}

function isComputerRequest(input: RequestEnvelopeInput) {
  if ("computer" in input.prepared.tools) return true
  return input.messages.some((message) => {
    if (!message || typeof message !== "object") return false
    const content = (message as { content?: unknown }).content
    return Array.isArray(content) && content.some((part) =>
      part && typeof part === "object" &&
      ((part as { toolName?: unknown; name?: unknown }).toolName === "computer" ||
        (part as { name?: unknown }).name === "computer"))
  })
}

function safeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value
  if (value instanceof Date) return value.toISOString()
  if (typeof value !== "object") return String(value)
  if (seen.has(value)) return "[Circular]"
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => safeValue(item, seen))
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue
    const normalized = safeValue(child, seen)
    if (normalized !== undefined) result[key] = normalized
  }
  return result
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, stableValue(v)]),
  )
}

export function stableJSON(value: unknown) {
  return JSON.stringify(stableValue(safeValue(value)))
}

export function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

export function stripTransportHeaders(headers: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(headers)
      .filter(([key]) => !SECRET_KEY.test(key))
      .map(([key, value]) => [key, value]),
  )
}

function modelTool(tool: Tool) {
  const value = tool as Tool & { parameters?: unknown; jsonSchema?: unknown }
  return {
    ...(value.description ? { description: value.description } : {}),
    schema: safeValue(value.inputSchema ?? value.parameters ?? value.jsonSchema),
  }
}

export function modelToolCatalog(tools: Record<string, Tool>) {
  return Object.fromEntries(
    Object.entries(tools)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, tool]) => [name, modelTool(tool)]),
  )
}

export function createRequestEnvelope(input: RequestEnvelopeInput): RequestEnvelopeArtifact {
  const tools = modelToolCatalog(input.prepared.tools)
  const envelope: RequestEnvelope = {
    version: 1,
    sessionID: input.sessionID,
    stepID: input.stepID,
    runtime: input.runtime,
    model: {
      providerID: input.model.providerID,
      id: input.model.id,
      ...(input.variant ? { variant: input.variant } : {}),
    },
    system: input.prepared.system,
    messages: isComputerRequest(input) ? auditMessages(input.messages) as unknown[] : input.messages,
    tools,
    params: input.prepared.params,
    headers: stripTransportHeaders(input.prepared.headers),
  }
  const serialized = stableJSON(envelope)
  const bytes = new TextEncoder().encode(serialized)
  return {
    envelope,
    bytes,
    sha256: sha256(bytes),
    configHash: sha256(
      stableJSON({
        runtime: input.runtime,
        model: envelope.model,
        params: envelope.params,
        headers: envelope.headers,
      }),
    ),
    toolCatalogHash: sha256(stableJSON(tools)),
  }
}
