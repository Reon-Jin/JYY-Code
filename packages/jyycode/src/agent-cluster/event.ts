export * as AgentClusterEvent from "./event"

import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { TaskID, TaskStatus } from "./schema"

export const Event = BusEvent.define(
  "agent_cluster.event",
  Schema.Struct({
    sessionID: SessionID,
    originMessageID: Schema.optional(Schema.String),
    taskID: Schema.optional(TaskID),
    type: Schema.Literals(["run", "task", "review", "artifact"]),
    status: Schema.optional(TaskStatus),
    message: Schema.String,
    metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    createdAt: Schema.Number,
  }),
)

export type Event = Schema.Schema.Type<typeof Event.properties>
