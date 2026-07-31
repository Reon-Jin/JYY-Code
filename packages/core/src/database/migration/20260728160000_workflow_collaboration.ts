import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

const statements = [
  `CREATE TABLE \`workflow_blackboard_card\` (\`id\` text PRIMARY KEY NOT NULL, \`session_id\` text NOT NULL, \`type\` text NOT NULL, \`title\` text NOT NULL, \`status\` text NOT NULL, \`version\` integer NOT NULL, \`author_agent_id\` text NOT NULL, \`approved_by\` text, \`summary\` text NOT NULL, \`related_tasks\` text NOT NULL, \`replaces\` text NOT NULL, \`impact_scope\` text NOT NULL, \`artifacts\` text NOT NULL, \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL, FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE)`,
  `CREATE TABLE \`workflow_review_finding\` (\`id\` text PRIMARY KEY NOT NULL, \`session_id\` text NOT NULL, \`run_plan_id\` text, \`node_id\` text, \`author_agent_id\` text NOT NULL, \`severity\` text NOT NULL, \`status\` text NOT NULL, \`summary\` text NOT NULL, \`evidence\` text NOT NULL, \`suggestion\` text NOT NULL, \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL, FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE, FOREIGN KEY (\`run_plan_id\`) REFERENCES \`run_plan\`(\`id\`) ON DELETE CASCADE)`,
  `CREATE INDEX \`workflow_blackboard_session_idx\` ON \`workflow_blackboard_card\` (\`session_id\`, \`status\`, \`time_updated\`)`,
  `CREATE INDEX \`workflow_review_session_idx\` ON \`workflow_review_finding\` (\`session_id\`, \`status\`, \`time_updated\`)`,
] as const

export default {
  id: "20260728160000_workflow_collaboration",
  up(tx) {
    return Effect.forEach(statements, (statement) => tx.run(sql.raw(statement)), { discard: true })
  },
} satisfies DatabaseMigration.Migration
