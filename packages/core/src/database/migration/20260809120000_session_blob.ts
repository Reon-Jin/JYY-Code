import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

const statements = [
  sql`CREATE TABLE IF NOT EXISTS blob (
    digest TEXT PRIMARY KEY NOT NULL,
    size INTEGER NOT NULL,
    mime TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    verified_at INTEGER NOT NULL,
    last_ref_removed_at INTEGER
  )`,
  sql`CREATE TABLE IF NOT EXISTS blob_ref (
    part_id TEXT NOT NULL,
    slot TEXT NOT NULL,
    digest TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (part_id, slot),
    FOREIGN KEY (part_id) REFERENCES part(id) ON DELETE CASCADE,
    FOREIGN KEY (digest) REFERENCES blob(digest) ON DELETE RESTRICT
  )`,
  sql`CREATE INDEX IF NOT EXISTS blob_verified_idx ON blob (verified_at)`,
  sql`CREATE INDEX IF NOT EXISTS blob_ref_digest_idx ON blob_ref (digest)`,
] as const

export default {
  id: "20260809120000_session_blob",
  up(tx) {
    return Effect.forEach(statements, (statement) => tx.run(statement), { discard: true })
  },
} satisfies DatabaseMigration.Migration
