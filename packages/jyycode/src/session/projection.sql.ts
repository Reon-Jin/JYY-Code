import { integer, index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Durable progress for a projection over one aggregate. The event log is
 * still the source of truth; this table only records how far a named,
 * versioned projection has consumed it.
 */
export const SessionProjectionTable = sqliteTable(
  "session_projection",
  {
    aggregate_id: text().notNull(),
    projector: text().notNull(),
    projector_version: integer().notNull(),
    seq: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.aggregate_id, table.projector] }),
    index("session_projection_aggregate_seq_idx").on(table.aggregate_id, table.seq),
  ],
)
