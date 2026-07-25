import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

const statements = [
  `CREATE TABLE \`__agent_cluster_task_id_map\` (
    \`run_id\` text NOT NULL,
    \`id\` text NOT NULL,
    \`session_id\` text NOT NULL,
    \`new_id\` text NOT NULL,
    PRIMARY KEY (\`run_id\`, \`id\`)
  )`,
  `INSERT INTO \`__agent_cluster_task_id_map\` (\`run_id\`, \`id\`, \`session_id\`, \`new_id\`)
   SELECT task.\`run_id\`, task.\`id\`, run.\`session_id\`,
     CASE WHEN count(*) OVER (PARTITION BY run.\`session_id\`, task.\`id\`) > 1
       THEN task.\`id\` || '--legacy-' || task.\`run_id\` ELSE task.\`id\` END
   FROM \`agent_cluster_task\` task JOIN \`agent_cluster_run\` run ON run.\`id\` = task.\`run_id\``,
  `CREATE TABLE \`__new_agent_cluster_task\` (
    \`id\` text NOT NULL, \`session_id\` text NOT NULL, \`origin_message_id\` text,
    \`parent_task_id\` text, \`child_session_id\` text, \`role\` text NOT NULL, \`title\` text NOT NULL,
    \`prompt\` text NOT NULL, \`complexity\` text NOT NULL, \`model\` text NOT NULL, \`status\` text NOT NULL,
    \`step\` integer DEFAULT 1 NOT NULL, \`dependencies\` text DEFAULT '[]' NOT NULL,
    \`review_round\` integer DEFAULT 0 NOT NULL, \`acceptance_criteria\` text NOT NULL,
    \`artifact_paths\` text NOT NULL, \`result_summary\` text, \`review_issues\` text DEFAULT '[]' NOT NULL,
    \`last_event\` text, \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL,
    CONSTRAINT \`agent_cluster_task_session_id_id_pk\` PRIMARY KEY(\`session_id\`, \`id\`),
    CONSTRAINT \`fk_agent_cluster_task_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
  )`,
  `INSERT INTO \`__new_agent_cluster_task\` (\`id\`, \`session_id\`, \`origin_message_id\`, \`parent_task_id\`, \`child_session_id\`, \`role\`, \`title\`, \`prompt\`, \`complexity\`, \`model\`, \`status\`, \`step\`, \`dependencies\`, \`review_round\`, \`acceptance_criteria\`, \`artifact_paths\`, \`result_summary\`, \`review_issues\`, \`last_event\`, \`time_created\`, \`time_updated\`)
   SELECT map.\`new_id\`, map.\`session_id\`, run.\`parent_message_id\`, parent.\`new_id\`, task.\`child_session_id\`, task.\`role\`, task.\`title\`, task.\`prompt\`, task.\`complexity\`, task.\`model\`, task.\`status\`, task.\`step\`,
     COALESCE((SELECT json_group_array(COALESCE(dependency_map.\`new_id\`, dependency.\`value\`)) FROM json_each(task.\`dependencies\`) dependency LEFT JOIN \`__agent_cluster_task_id_map\` dependency_map ON dependency_map.\`run_id\` = task.\`run_id\` AND dependency_map.\`id\` = dependency.\`value\`), '[]'),
     task.\`review_round\`, task.\`acceptance_criteria\`, task.\`artifact_paths\`, task.\`result_summary\`, task.\`review_issues\`, task.\`last_event\`, task.\`time_created\`, task.\`time_updated\`
   FROM \`agent_cluster_task\` task JOIN \`agent_cluster_run\` run ON run.\`id\` = task.\`run_id\`
   JOIN \`__agent_cluster_task_id_map\` map ON map.\`run_id\` = task.\`run_id\` AND map.\`id\` = task.\`id\`
   LEFT JOIN \`__agent_cluster_task_id_map\` parent ON parent.\`run_id\` = task.\`run_id\` AND parent.\`id\` = task.\`parent_task_id\``,
  `CREATE TABLE \`__new_agent_cluster_event\` (
    \`id\` text PRIMARY KEY, \`session_id\` text NOT NULL, \`origin_message_id\` text, \`task_id\` text,
    \`type\` text NOT NULL, \`message\` text NOT NULL, \`metadata\` text,
    \`time_created\` integer NOT NULL, \`time_updated\` integer NOT NULL,
    CONSTRAINT \`fk_agent_cluster_event_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
  )`,
  `INSERT INTO \`__new_agent_cluster_event\` (\`id\`, \`session_id\`, \`origin_message_id\`, \`task_id\`, \`type\`, \`message\`, \`metadata\`, \`time_created\`, \`time_updated\`)
   SELECT event.\`id\`, run.\`session_id\`, run.\`parent_message_id\`, task_map.\`new_id\`, event.\`type\`, event.\`message\`, event.\`metadata\`, event.\`time_created\`, event.\`time_updated\`
   FROM \`agent_cluster_event\` event JOIN \`agent_cluster_run\` run ON run.\`id\` = event.\`run_id\`
   LEFT JOIN \`__agent_cluster_task_id_map\` task_map ON task_map.\`run_id\` = event.\`run_id\` AND task_map.\`id\` = event.\`task_id\``,
  "DROP TABLE `agent_cluster_event`",
  "DROP TABLE `agent_cluster_task`",
  "DROP TABLE `agent_cluster_run`",
  "ALTER TABLE `__new_agent_cluster_task` RENAME TO `agent_cluster_task`",
  "ALTER TABLE `__new_agent_cluster_event` RENAME TO `agent_cluster_event`",
  "DROP TABLE `__agent_cluster_task_id_map`",
  "CREATE INDEX `agent_cluster_task_session_idx` ON `agent_cluster_task` (`session_id`)",
  "CREATE INDEX `agent_cluster_task_child_session_idx` ON `agent_cluster_task` (`child_session_id`)",
  "CREATE INDEX `agent_cluster_event_session_idx` ON `agent_cluster_event` (`session_id`)",
  "CREATE INDEX `agent_cluster_event_task_idx` ON `agent_cluster_event` (`task_id`)",
] as const

export default {
  id: "20260725100000_session_task_graph",
  up(tx) {
    return Effect.forEach(statements, (statement) => tx.run(sql.raw(statement)), { discard: true })
  },
} satisfies DatabaseMigration.Migration
