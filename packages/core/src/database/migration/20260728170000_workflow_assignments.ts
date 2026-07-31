import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

const statements = [
  `CREATE TABLE \`workflow_agent_assignment\` (\`id\` text PRIMARY KEY NOT NULL, \`session_id\` text NOT NULL, \`run_plan_id\` text NOT NULL, \`node_id\` text NOT NULL, \`agent_id\` text NOT NULL, \`role\` text NOT NULL, \`workspace_id\` text NOT NULL, \`child_session_id\` text, \`status\` text NOT NULL, \`checkpoint\` text, \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL, FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE, FOREIGN KEY (\`run_plan_id\`) REFERENCES \`run_plan\`(\`id\`) ON DELETE CASCADE, FOREIGN KEY (\`child_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE SET NULL)`,
  `CREATE INDEX \`workflow_assignment_session_idx\` ON \`workflow_agent_assignment\` (\`session_id\`, \`status\`)`,
  `CREATE INDEX \`workflow_assignment_node_idx\` ON \`workflow_agent_assignment\` (\`run_plan_id\`, \`node_id\`)`,
] as const

export default { id: "20260728170000_workflow_assignments", up(tx) { return Effect.forEach(statements, (statement) => tx.run(sql.raw(statement)), { discard: true }) } } satisfies DatabaseMigration.Migration
