export * as WorkflowEvent from "./event"

import { Schema } from "effect"
import { SessionID } from "@/session/schema"
import { NodeID, RunPlanID, WorkflowID, WorkflowVersion } from "./schema"

export const EventType = Schema.Literals([
  "WorkflowSelected",
  "RunPlanCreated",
  "RunPlanPatched",
  "RunPlanConflict",
  "ModeSwitchRequested",
  "CheckpointStarted",
  "ModeSwitched",
  "TaskAssigned",
  "TaskStarted",
  "ArtifactSubmitted",
  "ReviewRequested",
  "ReviewFindingCreated",
  "RevisionRequested",
  "TaskAccepted",
  "BlackboardPublished",
  "BlackboardAccepted",
  "ToolAccessRequested",
  "ToolAccessGranted",
  "DeliverableReady",
  "SessionCompleted",
])
export type EventType = Schema.Schema.Type<typeof EventType>

export const Event = Schema.Struct({
  id: Schema.String,
  sessionID: SessionID,
  type: EventType,
  workflowID: Schema.optional(WorkflowID),
  workflowVersion: Schema.optional(WorkflowVersion),
  runPlanID: Schema.optional(RunPlanID),
  nodeID: Schema.optional(NodeID),
  payload: Schema.Record(Schema.String, Schema.Unknown),
  createdAt: Schema.Number,
})
export type Event = Schema.Schema.Type<typeof Event>
