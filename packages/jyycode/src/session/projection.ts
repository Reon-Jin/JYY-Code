import { and, eq, sql } from "@/storage/db"
import { Database } from "@/storage/db"
import type { Database as DatabaseTypes } from "@/storage/db"
import { Effect } from "effect"
import { EventV2 } from "@jyycode-ai/core/event"
import "@jyycode-ai/core/session-event"
import { SessionProjectionTable } from "./projection.sql"

export const SESSION_PROJECTOR = "session-message"
export const SESSION_PROJECTOR_VERSION = 1

export type ProjectionWatermark = {
  readonly aggregateID: string
  readonly projector: string
  readonly projectorVersion: number
  readonly seq: number
  readonly updatedAt: number
}

type LegacyDatabase = DatabaseTypes.TxOrDb

function ensureSchema(db: LegacyDatabase) {
  db.run(
    sql.raw(
      "CREATE TABLE IF NOT EXISTS session_projection (aggregate_id TEXT NOT NULL, projector TEXT NOT NULL, projector_version INTEGER NOT NULL, seq INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (aggregate_id, projector))",
    ),
  )
  db.run(
    sql.raw(
      "CREATE INDEX IF NOT EXISTS session_projection_aggregate_seq_idx ON session_projection (aggregate_id, seq)",
    ),
  )
  const columns = db.all<{ name: string }>(sql.raw("PRAGMA table_info(event)"))
  if (!columns.some((column) => column.name === "ignorable")) {
    db.run(sql.raw("ALTER TABLE event ADD COLUMN ignorable INTEGER NOT NULL DEFAULT 0"))
  }
}

/** Compatibility bootstrap for databases created before this migration. */
export function ensureProjectionSchema() {
  Database.legacyQuery((db) => ensureSchema(db))
}

export type ProjectionEvent = {
  readonly aggregateID: string
  readonly seq: number
  readonly type: string
  readonly version?: number
  readonly ignorable?: boolean
}

export type ProjectionDecision =
  | { readonly _tag: "apply"; readonly seq: number }
  | { readonly _tag: "skip"; readonly seq: number; readonly reason: "ignorable" }

export class ProjectionSequenceError extends Error {
  readonly code = "SESSION_PROJECTION_SEQUENCE_MISMATCH"

  constructor(message: string) {
    super(message)
    this.name = "ProjectionSequenceError"
  }
}

export class UnknownRequiredProjectionEventError extends Error {
  readonly code = "SESSION_PROJECTION_UNKNOWN_REQUIRED_EVENT"

  constructor(event: Pick<ProjectionEvent, "type" | "version" | "seq">) {
    super(`projection ${SESSION_PROJECTOR} cannot apply required event ${event.type}/${event.version ?? "unversioned"}`)
    this.name = "UnknownRequiredProjectionEventError"
  }
}

/**
 * Static registry: projection ownership is compiled into the product kernel.
 * EventV2 definitions are registered when session-event is imported, so this
 * list remains deterministic and does not depend on plugin discovery.
 */
export const SessionProjection = {
  name: SESSION_PROJECTOR,
  version: SESSION_PROJECTOR_VERSION,
  accepted: new Set(
    EventV2.definitions()
      .filter((definition) => definition.aggregate === "sessionID" && definition.version !== undefined)
      .map((definition) => versionedEventType(definition.type, definition.version)),
  ) as ReadonlySet<string>,
}

export const ProjectionRegistry = [SessionProjection] as const

export function versionedEventType(type: string, version?: number) {
  return version === undefined ? type : `${type}.${version}`
}

export function projectionKey(input: { aggregateID: string; projector?: string }) {
  return {
    aggregateID: input.aggregateID,
    projector: input.projector ?? SESSION_PROJECTOR,
  }
}

export function readWatermark(
  db: Database.TxOrDb,
  input: { aggregateID: string; projector?: string } = { aggregateID: "" },
): ProjectionWatermark | undefined {
  ensureSchema(db)
  const key = projectionKey(input)
  const row = db
    .select()
    .from(SessionProjectionTable)
    .where(
      and(
        eq(SessionProjectionTable.aggregate_id, key.aggregateID),
        eq(SessionProjectionTable.projector, key.projector),
      ),
    )
    .get()
  if (!row) return undefined
  return {
    aggregateID: row.aggregate_id,
    projector: row.projector,
    projectorVersion: row.projector_version,
    seq: row.seq,
    updatedAt: row.updated_at,
  }
}

export function readWatermarkEffect(db: Database.EffectTxOrDb, input: { aggregateID: string; projector?: string }) {
  const key = projectionKey(input)
  return db
    .select()
    .from(SessionProjectionTable)
    .where(
      and(
        eq(SessionProjectionTable.aggregate_id, key.aggregateID),
        eq(SessionProjectionTable.projector, key.projector),
      ),
    )
    .get()
    .pipe(
      Effect.map((row) =>
        row
          ? {
              aggregateID: row.aggregate_id,
              projector: row.projector,
              projectorVersion: row.projector_version,
              seq: row.seq,
              updatedAt: row.updated_at,
            }
          : undefined,
      ),
    )
}

export function needsRebuild(watermark: ProjectionWatermark | undefined, projectorVersion = SESSION_PROJECTOR_VERSION) {
  return watermark !== undefined && watermark.projectorVersion !== projectorVersion
}

export function decide(input: {
  readonly watermark?: ProjectionWatermark
  readonly event: ProjectionEvent
  readonly accepted?: ReadonlySet<string>
}): ProjectionDecision {
  const expected = (input.watermark?.seq ?? -1) + 1
  if (input.event.seq !== expected) {
    throw new ProjectionSequenceError(
      `projection ${SESSION_PROJECTOR} expected seq ${expected}, got ${input.event.seq}`,
    )
  }

  const accepted = input.accepted ?? SessionProjection.accepted
  const key = versionedEventType(input.event.type, input.event.version)
  if (accepted.has(key) || accepted.has(input.event.type)) return { _tag: "apply", seq: input.event.seq }
  if (input.event.ignorable === true) return { _tag: "skip", seq: input.event.seq, reason: "ignorable" }
  throw new UnknownRequiredProjectionEventError(input.event)
}

export function writeWatermark(
  db: Database.TxOrDb,
  input: {
    readonly aggregateID: string
    readonly seq: number
    readonly projector?: string
    readonly projectorVersion?: number
    readonly updatedAt?: number
  },
) {
  ensureSchema(db)
  const key = projectionKey(input)
  db.insert(SessionProjectionTable)
    .values({
      aggregate_id: key.aggregateID,
      projector: key.projector,
      projector_version: input.projectorVersion ?? SESSION_PROJECTOR_VERSION,
      seq: input.seq,
      updated_at: input.updatedAt ?? Date.now(),
    })
    .onConflictDoUpdate({
      target: [SessionProjectionTable.aggregate_id, SessionProjectionTable.projector],
      set: {
        projector_version: input.projectorVersion ?? SESSION_PROJECTOR_VERSION,
        seq: input.seq,
        updated_at: input.updatedAt ?? Date.now(),
      },
    })
    .run()
}

export function writeWatermarkEffect(
  db: Database.EffectTxOrDb,
  input: {
    readonly aggregateID: string
    readonly seq: number
    readonly projector?: string
    readonly projectorVersion?: number
    readonly updatedAt?: number
  },
) {
  const key = projectionKey(input)
  const updatedAt = input.updatedAt ?? Date.now()
  return db
    .insert(SessionProjectionTable)
    .values({
      aggregate_id: key.aggregateID,
      projector: key.projector,
      projector_version: input.projectorVersion ?? SESSION_PROJECTOR_VERSION,
      seq: input.seq,
      updated_at: updatedAt,
    })
    .onConflictDoUpdate({
      target: [SessionProjectionTable.aggregate_id, SessionProjectionTable.projector],
      set: {
        projector_version: input.projectorVersion ?? SESSION_PROJECTOR_VERSION,
        seq: input.seq,
        updated_at: updatedAt,
      },
    })
    .run()
    .pipe(Effect.asVoid)
}

export function clearProjection(db: Database.TxOrDb, input: { aggregateID: string; projector?: string }) {
  const key = projectionKey(input)
  db.delete(SessionProjectionTable)
    .where(
      and(
        eq(SessionProjectionTable.aggregate_id, key.aggregateID),
        eq(SessionProjectionTable.projector, key.projector),
      ),
    )
    .run()
}
