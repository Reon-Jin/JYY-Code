export * as AgentClusterEvent from "./event"

import { BusEvent } from "@/bus/bus-event"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { RunID, RunStatus, TaskID, TaskStatus } from "./schema"

export const Event = BusEvent.define(
  "agent_cluster.event",
  Schema.Struct({
    sessionID: SessionID,
    runID: RunID,
    taskID: Schema.optional(TaskID),
    type: Schema.Literals(["run", "task", "review", "artifact", "intervention"]),
    status: Schema.optional(Schema.Union([RunStatus, TaskStatus])),
    message: Schema.String,
    metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    version: Schema.Number,
    createdAt: Schema.Number,
  }),
)

export type Event = Schema.Schema.Type<typeof Event.properties>
