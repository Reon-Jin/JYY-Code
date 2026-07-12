import { Cause, Effect, Schema } from "effect"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Permission } from "@/permission"
import type { Tool } from "./tool"

const OptionalString = Schema.optional(Schema.String)
const OptionalNumber = Schema.optional(Schema.Number)

export const Event = {
  CatalogResolved: BusEvent.define(
    "tool.catalog.resolved",
    Schema.Struct({
      sessionID: OptionalString,
      messageID: OptionalString,
      providerID: Schema.String,
      modelID: Schema.String,
      agent: Schema.String,
      toolCount: Schema.Number,
      schemaBytes: Schema.Number,
      toolIDs: Schema.Array(Schema.String),
    }),
  ),
  SearchExecuted: BusEvent.define(
    "tool.search.executed",
    Schema.Struct({
      sessionID: OptionalString,
      messageID: OptionalString,
      callID: OptionalString,
      query: Schema.String,
      detail: Schema.String,
      category: OptionalString,
      matches: Schema.Number,
      resultIDs: Schema.Array(Schema.String),
    }),
  ),
  ExecutionCompleted: BusEvent.define(
    "tool.execution.completed",
    Schema.Struct({
      sessionID: OptionalString,
      messageID: OptionalString,
      callID: OptionalString,
      tool: Schema.String,
      success: Schema.Boolean,
      status: Schema.Literals(["success", "error", "permission_rejected"]),
      durationMs: OptionalNumber,
      error: OptionalString,
      delegatedTool: OptionalString,
    }),
  ),
}

export type SearchDetail = "summary" | "schema" | "full"

export function approximateSchemaBytes(schema: unknown) {
  try {
    return JSON.stringify(schema).length
  } catch {
    return 0
  }
}

export function catalogResolved(
  bus: Bus.Interface,
  input: {
    sessionID?: string
    messageID?: string
    providerID: string
    modelID: string
    agent: string
    toolIDs: string[]
    schemaBytes: number
  },
) {
  return bus
    .publish(Event.CatalogResolved, {
      ...input,
      toolCount: input.toolIDs.length,
    })
    .pipe(Effect.ignore)
}

export function searchExecuted(
  bus: Bus.Interface,
  input: {
    sessionID?: string
    messageID?: string
    callID?: string
    query: string
    detail: SearchDetail
    category?: string
    resultIDs: string[]
  },
) {
  return bus
    .publish(Event.SearchExecuted, {
      ...input,
      matches: input.resultIDs.length,
    })
    .pipe(Effect.ignore)
}

export function executionCompleted(
  bus: Bus.Interface,
  input: {
    sessionID?: string
    messageID?: string
    callID?: string
    tool: string
    success: boolean
    status: "success" | "error" | "permission_rejected"
    durationMs?: number
    error?: string
    delegatedTool?: string
  },
) {
  return bus.publish(Event.ExecutionCompleted, input).pipe(Effect.ignore)
}

export function executionFailure(cause: Cause.Cause<unknown>) {
  const error = Cause.squash(cause)
  return {
    status: error instanceof Permission.RejectedError ? ("permission_rejected" as const) : ("error" as const),
    error: error instanceof Error ? error.message : String(error),
  }
}

export * as ToolTelemetry from "./telemetry"
