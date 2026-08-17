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
    messages: input.messages,
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
