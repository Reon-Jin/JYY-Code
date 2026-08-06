import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260806031414_session_goal",
  up(tx) {
    return Effect.gen(function* () {
      const columns = yield* tx.all<{ name: string }>(sql`PRAGMA table_info(session)`)
      if (!columns.some((column) => column.name === "goal")) {
        yield* tx.run(sql`ALTER TABLE session ADD COLUMN goal text`)
      }
    })
  },
} satisfies DatabaseMigration.Migration
