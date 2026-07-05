export * as AgentClusterIntervention from "./intervention"

import { AgentClusterInterventionTable } from "./cluster.sql"
import type { RunID, TaskID } from "./schema"
import type { SessionID } from "@/session/schema"
import * as Database from "@/storage/db"
import { and, eq } from "@/storage/db"
import { Effect } from "effect"
import { ulid } from "ulid"

export type InterventionMode = "next_checkpoint" | "interrupt" | "parent_only"
export type InterventionSource = "user" | "primary" | "reviewer"
export type InterventionStatus = "queued" | "delivered" | "acknowledged" | "rejected" | "cancelled"

export const enqueue = Effect.fn("AgentClusterIntervention.enqueue")(function* (input: {
  runID: RunID
  taskID: TaskID
  childSessionID: SessionID
  source: InterventionSource
  mode: InterventionMode
  content: string
}) {
  return yield* Database.withTransaction((tx) =>
    Effect.gen(function* () {
      // Get next sequence for this child session
      const last = yield* tx
        .select({ sequence: AgentClusterInterventionTable.sequence })
        .from(AgentClusterInterventionTable)
        .where(eq(AgentClusterInterventionTable.child_session_id, input.childSessionID))
        .orderBy(Database.desc(AgentClusterInterventionTable.sequence))
        .limit(1)
        .get()

      const sequence = (last?.sequence ?? 0) + 1
      const now = Date.now()
      const id = ulid()

      yield* tx
        .insert(AgentClusterInterventionTable)
        .values({
          id,
          run_id: input.runID,
          task_id: input.taskID,
          child_session_id: input.childSessionID,
          source: input.source,
          mode: input.mode,
          content: input.content,
          status: "queued",
          sequence,
          time_created: now,
          time_updated: now,
        })
        .run()

      return { id, sequence }
    }),
  )
})

export const pending = Effect.fn("AgentClusterIntervention.pending")(function* (childSessionID: SessionID) {
  return yield* Database.query((db) =>
    db
      .select()
      .from(AgentClusterInterventionTable)
      .where(
        and(
          eq(AgentClusterInterventionTable.child_session_id, childSessionID),
          eq(AgentClusterInterventionTable.status, "queued"),
        ),
      )
      .orderBy(AgentClusterInterventionTable.sequence)
      .all(),
  )
})

export const deliverNext = Effect.fn("AgentClusterIntervention.deliverNext")(function* (childSessionID: SessionID) {
  return yield* Database.withTransaction((tx) =>
    Effect.gen(function* () {
      const next = yield* tx
        .select()
        .from(AgentClusterInterventionTable)
        .where(
          and(
            eq(AgentClusterInterventionTable.child_session_id, childSessionID),
            eq(AgentClusterInterventionTable.status, "queued"),
          ),
        )
        .orderBy(AgentClusterInterventionTable.sequence)
        .limit(1)
        .get()

      if (!next) return undefined

      const now = Date.now()
      yield* tx
        .update(AgentClusterInterventionTable)
        .set({
          status: "delivered",
          delivered_at: now,
          time_updated: now,
        })
        .where(eq(AgentClusterInterventionTable.id, next.id))
        .run()

      return next
    }),
  )
})

export const acknowledge = Effect.fn("AgentClusterIntervention.acknowledge")(function* (id: string) {
  const now = Date.now()
  yield* Database.query((db) =>
    db
      .update(AgentClusterInterventionTable)
      .set({
        status: "acknowledged",
        acknowledged_at: now,
        time_updated: now,
      })
      .where(eq(AgentClusterInterventionTable.id, id))
      .run(),
  )
})

export const cancel = Effect.fn("AgentClusterIntervention.cancel")(function* (id: string) {
  const now = Date.now()
  yield* Database.query((db) =>
    db
      .update(AgentClusterInterventionTable)
      .set({
        status: "cancelled",
        time_updated: now,
      })
      .where(
        and(
          eq(AgentClusterInterventionTable.id, id),
          eq(AgentClusterInterventionTable.status, "queued"),
        ),
      )
      .run(),
  )
})

export function interventionText(intervention: {
  source: string
  mode: string
  sequence: number
  content: string
  id: string
}): string {
  const label = intervention.mode === "parent_only" ? "Coordinator note" : "User guidance"
  return [
    `<intervention id="${intervention.id}" source="${intervention.source}" mode="${intervention.mode}" sequence="${intervention.sequence}">`,
    `**${label}:** ${intervention.content}`,
    `</intervention>`,
  ].join("\n")
}
