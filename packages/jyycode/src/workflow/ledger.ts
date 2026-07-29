export * as WorkflowLedger from "./ledger"

import { and, desc, eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { ulid } from "ulid"
import * as Database from "@/storage/db"
import type { SessionID } from "@/session/schema"
import type { Artifact, ContextBlock, ContextPriority, ContextSource, ModelCall, NodeID, RunPlanID } from "./schema"
import { Artifact as ArtifactSchema, ContextBlock as ContextBlockSchema, ModelCall as ModelCallSchema } from "./schema"
import { WorkflowArtifactTable, WorkflowBlackboardCardTable, WorkflowContextBlockTable, WorkflowModelCallTable } from "./workflow.sql"

const priorityRank: Record<ContextPriority, number> = { critical: 0, high: 1, normal: 2, low: 3 }

function tokenEstimate(content: string) {
  return Math.max(1, Math.ceil(content.length / 4))
}

export const addContext = Effect.fn("WorkflowLedger.addContext")(function* (input: Omit<ContextBlock, "id" | "createdAt" | "tokenEstimate"> & { tokenEstimate?: number }) {
  const value: ContextBlock = {
    ...input,
    id: ulid(),
    tokenEstimate: input.tokenEstimate ?? tokenEstimate(input.content),
    createdAt: Date.now(),
  }
  yield* Database.query((db) =>
    db
      .insert(WorkflowContextBlockTable)
      .values({
        id: value.id,
        session_id: value.sessionID,
        ...(value.runPlanID ? { run_plan_id: value.runPlanID } : {}),
        ...(value.nodeID ? { node_id: value.nodeID } : {}),
        source: value.source,
        priority: value.priority,
        token_estimate: value.tokenEstimate,
        provenance: value.provenance,
        retention: value.retention,
        cache_policy: value.cachePolicy,
        scope: value.scope,
        content: value.content,
        time_created: value.createdAt,
      })
      .run(),
  )
  return value
})

export const searchContext = Effect.fn("WorkflowLedger.searchContext")(function* (input: {
  sessionID: SessionID
  query?: string
  source?: ContextSource
  limit?: number
}) {
  const rows = yield* Database.query((db) =>
    db
      .select()
      .from(WorkflowContextBlockTable)
      .where(eq(WorkflowContextBlockTable.session_id, input.sessionID))
      .orderBy(desc(WorkflowContextBlockTable.time_created))
      .all(),
  )
  const query = input.query?.trim().toLocaleLowerCase()
  const values = rows
    .map((row) =>
      Schema.decodeUnknownSync(ContextBlockSchema)({
        id: row.id,
        sessionID: row.session_id,
        ...(row.run_plan_id ? { runPlanID: row.run_plan_id } : {}),
        ...(row.node_id ? { nodeID: row.node_id } : {}),
        source: row.source,
        priority: row.priority,
        tokenEstimate: row.token_estimate,
        provenance: row.provenance,
        retention: row.retention,
        cachePolicy: row.cache_policy,
        scope: row.scope,
        content: row.content,
        createdAt: row.time_created,
      }),
    )
    .filter((block) => !input.source || block.source === input.source)
    .filter((block) => !query || `${block.content}\n${block.provenance}`.toLocaleLowerCase().includes(query))
  return values.slice(0, input.limit ?? 20)
})

export const buildContext = Effect.fn("WorkflowLedger.buildContext")(function* (input: {
  sessionID: SessionID
  nodeID?: NodeID
  budget: number
}) {
  const blocks = yield* searchContext({ sessionID: input.sessionID, limit: 500 })
  const acceptedCards = new Set(
    (
      yield* Database.query((db) =>
        db
          .select({ id: WorkflowBlackboardCardTable.id })
          .from(WorkflowBlackboardCardTable)
          .where(and(eq(WorkflowBlackboardCardTable.session_id, input.sessionID), eq(WorkflowBlackboardCardTable.status, "accepted")))
          .all(),
      )
    ).map((card) => card.id),
  )
  const applicable = blocks
    .filter((block) =>
      block.source !== "blackboard" ||
      (typeof block.scope.blackboardCardID === "string" && acceptedCards.has(block.scope.blackboardCardID)),
    )
    .filter((block) => !block.nodeID || block.nodeID === input.nodeID)
    .sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || a.createdAt - b.createdAt)
  const selected: ContextBlock[] = []
  let used = 0
  for (const block of applicable) {
    // User constraints are mandatory even when they exceed the requested budget.
    if (block.source === "user_constraint" || used + block.tokenEstimate <= input.budget) {
      selected.push(block)
      used += block.tokenEstimate
    }
  }
  return { blocks: selected, tokenEstimate: used }
})

export const getContext = Effect.fn("WorkflowLedger.getContext")(function* (id: string) {
  const row = yield* Database.query((db) =>
    db.select().from(WorkflowContextBlockTable).where(eq(WorkflowContextBlockTable.id, id)).get(),
  )
  if (!row) return yield* Effect.fail(new Error(`Context block not found: ${id}`))
  return Schema.decodeUnknownSync(ContextBlockSchema)({
    id: row.id,
    sessionID: row.session_id,
    ...(row.run_plan_id ? { runPlanID: row.run_plan_id } : {}),
    ...(row.node_id ? { nodeID: row.node_id } : {}),
    source: row.source,
    priority: row.priority,
    tokenEstimate: row.token_estimate,
    provenance: row.provenance,
    retention: row.retention,
    cachePolicy: row.cache_policy,
    scope: row.scope,
    content: row.content,
    createdAt: row.time_created,
  })
})

export const putArtifact = Effect.fn("WorkflowLedger.putArtifact")(function* (input: Omit<Artifact, "id" | "uri" | "createdAt"> & { id?: string; uri?: string }) {
  const id = input.id ?? ulid()
  const value: Artifact = {
    ...input,
    id,
    uri: input.uri ?? `artifact://${id}`,
    createdAt: Date.now(),
  }
  yield* Database.query((db) =>
    db
      .insert(WorkflowArtifactTable)
      .values({
        id: value.id,
        session_id: value.sessionID,
        ...(value.runPlanID ? { run_plan_id: value.runPlanID } : {}),
        ...(value.nodeID ? { node_id: value.nodeID } : {}),
        name: value.name,
        media_type: value.mediaType,
        uri: value.uri,
        ...(value.content === undefined ? {} : { content: value.content }),
        summary: value.summary,
        metadata: value.metadata,
        time_created: value.createdAt,
      })
      .run(),
  )
  return value
})

export const getArtifact = Effect.fn("WorkflowLedger.getArtifact")(function* (uri: string) {
  const row = yield* Database.query((db) =>
    db.select().from(WorkflowArtifactTable).where(eq(WorkflowArtifactTable.uri, uri)).get(),
  )
  if (!row) return yield* Effect.fail(new Error(`Artifact not found: ${uri}`))
  return Schema.decodeUnknownSync(ArtifactSchema)({
    id: row.id,
    sessionID: row.session_id,
    ...(row.run_plan_id ? { runPlanID: row.run_plan_id } : {}),
    ...(row.node_id ? { nodeID: row.node_id } : {}),
    name: row.name,
    mediaType: row.media_type,
    uri: row.uri,
    ...(row.content === null ? {} : { content: row.content }),
    summary: row.summary,
    metadata: row.metadata,
    createdAt: row.time_created,
  })
})

export const getArtifactByID = Effect.fn("WorkflowLedger.getArtifactByID")(function* (id: string) {
  const row = yield* Database.query((db) =>
    db.select().from(WorkflowArtifactTable).where(eq(WorkflowArtifactTable.id, id)).get(),
  )
  if (!row) return yield* Effect.fail(new Error(`Artifact not found: ${id}`))
  return Schema.decodeUnknownSync(ArtifactSchema)({
    id: row.id,
    sessionID: row.session_id,
    ...(row.run_plan_id ? { runPlanID: row.run_plan_id } : {}),
    ...(row.node_id ? { nodeID: row.node_id } : {}),
    name: row.name,
    mediaType: row.media_type,
    uri: row.uri,
    ...(row.content === null ? {} : { content: row.content }),
    summary: row.summary,
    metadata: row.metadata,
    createdAt: row.time_created,
  })
})

export const listArtifacts = Effect.fn("WorkflowLedger.listArtifacts")(function* (sessionID: SessionID) {
  const rows = yield* Database.query((db) =>
    db.select().from(WorkflowArtifactTable).where(eq(WorkflowArtifactTable.session_id, sessionID)).orderBy(desc(WorkflowArtifactTable.time_created)).all(),
  )
  return rows.map((row) =>
    Schema.decodeUnknownSync(ArtifactSchema)({
      id: row.id,
      sessionID: row.session_id,
      ...(row.run_plan_id ? { runPlanID: row.run_plan_id } : {}),
      ...(row.node_id ? { nodeID: row.node_id } : {}),
      name: row.name,
      mediaType: row.media_type,
      uri: row.uri,
      ...(row.content === null ? {} : { content: row.content }),
      summary: row.summary,
      metadata: row.metadata,
      createdAt: row.time_created,
    }),
  )
})

export const recordModelCall = Effect.fn("WorkflowLedger.recordModelCall")(function* (input: Omit<ModelCall, "id" | "createdAt"> & { id?: string; createdAt?: number }) {
  const value: ModelCall = { ...input, id: input.id ?? ulid(), createdAt: input.createdAt ?? Date.now() }
  yield* Database.query((db) =>
    db
      .insert(WorkflowModelCallTable)
      .values({
        id: value.id,
        session_id: value.sessionID,
        ...(value.runPlanID ? { run_plan_id: value.runPlanID } : {}),
        ...(value.nodeID ? { node_id: value.nodeID } : {}),
        role: value.role,
        model: value.model,
        context_block_ids: [...value.contextBlockIDs],
        input_tokens: value.inputTokens,
        output_tokens: value.outputTokens,
        status: value.status,
        time_created: value.createdAt,
        ...(value.completedAt ? { time_completed: value.completedAt } : {}),
      })
      .run(),
  )
  return value
})
