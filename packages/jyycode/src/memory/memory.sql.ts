import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { SessionID } from "../session/schema"

export const ObservationTable = sqliteTable(
  "observation",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    memory_session_id: text().$type<SessionID>().notNull(),
    kind: text().notNull().default("observation"),
    type: text().notNull(),
    title: text(),
    subtitle: text(),
    text: text(),
    narrative: text(),
    facts: text({ mode: "json" }).$type<string[]>().default([]),
    concepts: text({ mode: "json" }).$type<string[]>().default([]),
    files_read: text({ mode: "json" }).$type<string[]>().default([]),
    files_modified: text({ mode: "json" }).$type<string[]>().default([]),
    content_hash: text().notNull(),
    discovery_tokens: integer().default(0),
    generated_by_model: text(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>().default({}),
    time_created: integer().notNull().$default(() => Date.now()),
    time_updated: integer().notNull().$default(() => Date.now()),
  },
  (table) => [
    index("obs_session_idx").on(table.memory_session_id),
    index("obs_type_idx").on(table.type),
    index("obs_created_idx").on(table.time_created),
    index("obs_hash_lookup_idx").on(table.content_hash, table.time_created),
    uniqueIndex("obs_dedup_idx").on(table.memory_session_id, table.content_hash),
  ],
)

export const SessionSummaryTable = sqliteTable(
  "session_summary",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    memory_session_id: text().$type<SessionID>().notNull(),
    project: text().notNull(),
    request: text(),
    investigated: text(),
    learned: text(),
    completed: text(),
    next_steps: text(),
    notes: text(),
    discovery_tokens: integer().default(0),
    time_created: integer().notNull().$default(() => Date.now()),
    time_updated: integer().notNull().$default(() => Date.now()),
  },
  (table) => [
    index("summary_session_idx").on(table.memory_session_id),
    index("summary_project_idx").on(table.project),
    index("summary_created_idx").on(table.time_created),
  ],
)
