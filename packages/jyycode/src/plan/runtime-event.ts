import { BusEvent } from "@/bus/bus-event"
import { Schema } from "effect"

export const RuntimeEvent = BusEvent.define(
  "plan.runtime.event",
  Schema.Struct({
    seq: Schema.Number,
    type: Schema.Literals([
      "plan.updated",
      "child.activity",
      "report_arrived",
      "check_point",
      "user_message",
      "runtime.metric",
    ]),
    session_id: Schema.String,
    revision: Schema.optional(Schema.Number),
    at: Schema.String,
    payload: Schema.Record(Schema.String, Schema.Unknown),
  }),
)

export type RuntimeEvent = Schema.Schema.Type<typeof RuntimeEvent.properties>

export type RuntimeMetricInput = {
  metric: string
  phase: string
  outcome: string
  duration_ms?: number
  count?: number
  savings_chars?: number
  retry_count?: number
}

/**
 * Keep runtime telemetry deliberately scalar and bounded. Callers must not
 * pass prompts, memory contents, tool output, or provider errors here.
 */
export function runtimeMetricPayload(input: RuntimeMetricInput) {
  const payload: Record<string, string | number> = {
    metric: input.metric,
    phase: input.phase,
    outcome: input.outcome,
  }
  for (const [key, value] of Object.entries(input)) {
    if (key === "metric" || key === "phase" || key === "outcome") continue
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) payload[key] = value
  }
  return payload
}

export * as PlanRuntimeEvent from "./runtime-event"
