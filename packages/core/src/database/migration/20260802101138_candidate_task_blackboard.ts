import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260802101138_candidate_task_blackboard",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(sql`ALTER TABLE blackboard_message ADD COLUMN purpose text DEFAULT 'general' NOT NULL`)
    })
  },
} satisfies DatabaseMigration.Migration
