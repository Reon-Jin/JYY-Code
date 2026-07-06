import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

const columns = [
  ["step", "ALTER TABLE `agent_cluster_task` ADD `step` integer DEFAULT 1 NOT NULL"],
  ["dependencies", "ALTER TABLE `agent_cluster_task` ADD `dependencies` text DEFAULT '[]' NOT NULL"],
  ["result_summary", "ALTER TABLE `agent_cluster_task` ADD `result_summary` text"],
  ["review_issues", "ALTER TABLE `agent_cluster_task` ADD `review_issues` text DEFAULT '[]' NOT NULL"],
] as const

export default {
  id: "20260706090000_agent_cluster_pipeline_context",
  up(tx) {
    return Effect.gen(function* () {
      const existing = new Set(
        (yield* tx.all<{ name: string }>(sql`PRAGMA table_info(agent_cluster_task)`)).map((column) => column.name),
      )
      yield* Effect.forEach(
        columns,
        ([name, statement]) => (existing.has(name) ? Effect.void : tx.run(sql.raw(statement))),
        { discard: true },
      )
    })
  },
} satisfies DatabaseMigration.Migration
