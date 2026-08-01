import { BusEvent } from "@/bus/bus-event"
import { Schema } from "effect"

export const RuntimeEvent = BusEvent.define(
  "plan.runtime.event",
  Schema.Struct({
    seq: Schema.Number,
    type: Schema.Literals(["plan.updated", "child.activity", "report_arrived", "check_point", "user_message"]),
    session_id: Schema.String,
    revision: Schema.optional(Schema.Number),
    at: Schema.String,
    payload: Schema.Record(Schema.String, Schema.Unknown),
  }),
)

export type RuntimeEvent = Schema.Schema.Type<typeof RuntimeEvent.properties>

export * as PlanRuntimeEvent from "./runtime-event"
