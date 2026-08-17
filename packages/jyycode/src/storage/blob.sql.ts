import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { PartTable } from "@/session/session.sql"

export const BlobTable = sqliteTable(
  "blob",
  {
    digest: text().primaryKey(),
    size: integer().notNull(),
    mime: text().notNull(),
    created_at: integer().notNull(),
    verified_at: integer().notNull(),
    last_ref_removed_at: integer(),
  },
  (table) => [index("blob_verified_idx").on(table.verified_at)],
)

export const BlobRefTable = sqliteTable(
  "blob_ref",
  {
    part_id: text()
      .notNull()
      .references(() => PartTable.id, { onDelete: "cascade" }),
    slot: text().notNull(),
    digest: text()
      .notNull()
      .references(() => BlobTable.digest, { onDelete: "restrict" }),
    created_at: integer().notNull(),
  },
  (table) => [primaryKey({ columns: [table.part_id, table.slot] }), index("blob_ref_digest_idx").on(table.digest)],
)
