import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

const statements = [
  `CREATE TABLE \`workflow_context_block\` (\`id\` text PRIMARY KEY NOT NULL, \`session_id\` text NOT NULL, \`run_plan_id\` text, \`node_id\` text, \`source\` text NOT NULL, \`priority\` text NOT NULL, \`token_estimate\` integer NOT NULL, \`provenance\` text NOT NULL, \`retention\` text NOT NULL, \`cache_policy\` text NOT NULL, \`scope\` text NOT NULL, \`content\` text NOT NULL, \`time_created\` integer NOT NULL, FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE, FOREIGN KEY (\`run_plan_id\`) REFERENCES \`run_plan\`(\`id\`) ON DELETE CASCADE)`,
  `CREATE TABLE \`workflow_artifact\` (\`id\` text PRIMARY KEY NOT NULL, \`session_id\` text NOT NULL, \`run_plan_id\` text, \`node_id\` text, \`name\` text NOT NULL, \`media_type\` text NOT NULL, \`uri\` text NOT NULL, \`content\` text, \`summary\` text NOT NULL, \`metadata\` text NOT NULL, \`time_created\` integer NOT NULL, FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE, FOREIGN KEY (\`run_plan_id\`) REFERENCES \`run_plan\`(\`id\`) ON DELETE CASCADE)`,
  `CREATE TABLE \`workflow_model_call\` (\`id\` text PRIMARY KEY NOT NULL, \`session_id\` text NOT NULL, \`run_plan_id\` text, \`node_id\` text, \`role\` text NOT NULL, \`model\` text NOT NULL, \`context_block_ids\` text NOT NULL, \`input_tokens\` integer NOT NULL, \`output_tokens\` integer NOT NULL, \`status\` text NOT NULL, \`time_created\` integer NOT NULL, \`time_completed\` integer, FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE, FOREIGN KEY (\`run_plan_id\`) REFERENCES \`run_plan\`(\`id\`) ON DELETE CASCADE)`,
  `CREATE INDEX \`workflow_context_block_session_idx\` ON \`workflow_context_block\` (\`session_id\`, \`priority\`, \`time_created\`)`,
  `CREATE INDEX \`workflow_artifact_session_idx\` ON \`workflow_artifact\` (\`session_id\`, \`time_created\`)`,
  `CREATE UNIQUE INDEX \`workflow_artifact_uri_unique\` ON \`workflow_artifact\` (\`uri\`)`,
  `CREATE INDEX \`workflow_model_call_session_idx\` ON \`workflow_model_call\` (\`session_id\`, \`time_created\`)`,
] as const

export default {
  id: "20260728150000_workflow_context_ledger",
  up(tx) {
    return Effect.forEach(statements, (statement) => tx.run(sql.raw(statement)), { discard: true })
  },
} satisfies DatabaseMigration.Migration
