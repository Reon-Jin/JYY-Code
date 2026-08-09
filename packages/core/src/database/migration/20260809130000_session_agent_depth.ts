import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

const statements = [
  sql`ALTER TABLE session ADD COLUMN agent_depth INTEGER NOT NULL DEFAULT 0`,
  // Existing sessions predate the persisted field. The current hard cap is
  // one, so every legacy child is safely classified as depth one; any older
  // nested chain will fail closed when it next attempts another child.
  sql`UPDATE session SET agent_depth = 1 WHERE parent_id IS NOT NULL`,
] as const

export default {
  id: "20260809130000_session_agent_depth",
  up(tx) {
    return Effect.forEach(statements, (statement) => tx.run(statement), { discard: true })
  },
} satisfies DatabaseMigration.Migration
