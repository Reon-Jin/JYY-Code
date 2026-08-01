import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260801090000_remove_agent_cluster",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(sql`DROP TABLE IF EXISTS agent_cluster_event`)
      yield* tx.run(sql`DROP TABLE IF EXISTS agent_cluster_task`)
    })
  },
} satisfies DatabaseMigration.Migration
