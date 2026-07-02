import { Effect } from "effect"
import type { DatabaseMigration } from "./migration"

const statements = [
  "CREATE TABLE `agent_cluster_event` (\n\t`id` text PRIMARY KEY,\n\t`run_id` text NOT NULL,\n\t`task_id` text,\n\t`type` text NOT NULL,\n\t`message` text NOT NULL,\n\t`metadata` text,\n\t`time_created` integer NOT NULL,\n\t`time_updated` integer NOT NULL,\n\tCONSTRAINT `fk_agent_cluster_event_run_id_agent_cluster_run_id_fk` FOREIGN KEY (`run_id`) REFERENCES `agent_cluster_run`(`id`) ON DELETE CASCADE\n);",
  "CREATE TABLE `agent_cluster_run` (\n\t`id` text PRIMARY KEY,\n\t`session_id` text NOT NULL,\n\t`parent_message_id` text NOT NULL,\n\t`enabled` integer DEFAULT true NOT NULL,\n\t`status` text NOT NULL,\n\t`goal` text NOT NULL,\n\t`planner_model` text NOT NULL,\n\t`reviewer_model` text NOT NULL,\n\t`time_created` integer NOT NULL,\n\t`time_updated` integer NOT NULL,\n\t`completed_at` integer,\n\tCONSTRAINT `fk_agent_cluster_run_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE,\n\tCONSTRAINT `fk_agent_cluster_run_parent_message_id_message_id_fk` FOREIGN KEY (`parent_message_id`) REFERENCES `message`(`id`) ON DELETE CASCADE\n);",
  "CREATE TABLE `agent_cluster_task` (\n\t`id` text PRIMARY KEY,\n\t`run_id` text NOT NULL,\n\t`parent_task_id` text,\n\t`child_session_id` text,\n\t`role` text NOT NULL,\n\t`title` text NOT NULL,\n\t`prompt` text NOT NULL,\n\t`complexity` text NOT NULL,\n\t`model` text NOT NULL,\n\t`status` text NOT NULL,\n\t`review_round` integer DEFAULT 0 NOT NULL,\n\t`acceptance_criteria` text NOT NULL,\n\t`artifact_paths` text NOT NULL,\n\t`last_event` text,\n\t`time_created` integer NOT NULL,\n\t`time_updated` integer NOT NULL,\n\tCONSTRAINT `fk_agent_cluster_task_run_id_agent_cluster_run_id_fk` FOREIGN KEY (`run_id`) REFERENCES `agent_cluster_run`(`id`) ON DELETE CASCADE\n);",
  "CREATE TABLE `workspace` (\n\t`id` text PRIMARY KEY,\n\t`type` text NOT NULL,\n\t`name` text DEFAULT '' NOT NULL,\n\t`branch` text,\n\t`directory` text,\n\t`extra` text,\n\t`project_id` text NOT NULL,\n\t`time_used` integer NOT NULL,\n\tCONSTRAINT `fk_workspace_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE\n);",
  "CREATE TABLE `data_migration` (\n\t`name` text PRIMARY KEY,\n\t`time_completed` integer NOT NULL\n);",
  "CREATE TABLE `project` (\n\t`id` text PRIMARY KEY,\n\t`worktree` text NOT NULL,\n\t`vcs` text,\n\t`name` text,\n\t`icon_url` text,\n\t`icon_url_override` text,\n\t`icon_color` text,\n\t`time_created` integer NOT NULL,\n\t`time_updated` integer NOT NULL,\n\t`time_initialized` integer,\n\t`sandboxes` text NOT NULL,\n\t`commands` text\n);",
  "CREATE TABLE `message` (\n\t`id` text PRIMARY KEY,\n\t`session_id` text NOT NULL,\n\t`time_created` integer NOT NULL,\n\t`time_updated` integer NOT NULL,\n\t`data` text NOT NULL,\n\tCONSTRAINT `fk_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE\n);",
  "CREATE TABLE `part` (\n\t`id` text PRIMARY KEY,\n\t`message_id` text NOT NULL,\n\t`session_id` text NOT NULL,\n\t`time_created` integer NOT NULL,\n\t`time_updated` integer NOT NULL,\n\t`data` text NOT NULL,\n\tCONSTRAINT `fk_part_message_id_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON DELETE CASCADE\n);",
  "CREATE TABLE `permission` (\n\t`project_id` text PRIMARY KEY,\n\t`time_created` integer NOT NULL,\n\t`time_updated` integer NOT NULL,\n\t`data` text NOT NULL,\n\tCONSTRAINT `fk_permission_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE\n);",
  "CREATE TABLE `session_message` (\n\t`id` text PRIMARY KEY,\n\t`session_id` text NOT NULL,\n\t`type` text NOT NULL,\n\t`time_created` integer NOT NULL,\n\t`time_updated` integer NOT NULL,\n\t`data` text NOT NULL,\n\tCONSTRAINT `fk_session_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE\n);",
  "CREATE TABLE `session` (\n\t`id` text PRIMARY KEY,\n\t`project_id` text NOT NULL,\n\t`workspace_id` text,\n\t`parent_id` text,\n\t`slug` text NOT NULL,\n\t`directory` text NOT NULL,\n\t`path` text,\n\t`title` text NOT NULL,\n\t`version` text NOT NULL,\n\t`share_url` text,\n\t`summary_additions` integer,\n\t`summary_deletions` integer,\n\t`summary_files` integer,\n\t`summary_diffs` text,\n\t`cost` real DEFAULT 0 NOT NULL,\n\t`tokens_input` integer DEFAULT 0 NOT NULL,\n\t`tokens_output` integer DEFAULT 0 NOT NULL,\n\t`tokens_reasoning` integer DEFAULT 0 NOT NULL,\n\t`tokens_cache_read` integer DEFAULT 0 NOT NULL,\n\t`tokens_cache_write` integer DEFAULT 0 NOT NULL,\n\t`revert` text,\n\t`permission` text,\n\t`agent` text,\n\t`model` text,\n\t`multi_agent_enabled` integer,\n\t`time_created` integer NOT NULL,\n\t`time_updated` integer NOT NULL,\n\t`time_compacting` integer,\n\t`time_archived` integer,\n\tCONSTRAINT `fk_session_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE\n);",
  "CREATE TABLE `todo` (\n\t`session_id` text NOT NULL,\n\t`content` text NOT NULL,\n\t`status` text NOT NULL,\n\t`priority` text NOT NULL,\n\t`position` integer NOT NULL,\n\t`time_created` integer NOT NULL,\n\t`time_updated` integer NOT NULL,\n\tCONSTRAINT `todo_pk` PRIMARY KEY(`session_id`, `position`),\n\tCONSTRAINT `fk_todo_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE\n);",
  "CREATE TABLE `session_share` (\n\t`session_id` text PRIMARY KEY,\n\t`id` text NOT NULL,\n\t`secret` text NOT NULL,\n\t`url` text NOT NULL,\n\t`time_created` integer NOT NULL,\n\t`time_updated` integer NOT NULL,\n\tCONSTRAINT `fk_session_share_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE\n);",
  "CREATE TABLE `event_sequence` (\n\t`aggregate_id` text PRIMARY KEY,\n\t`seq` integer NOT NULL,\n\t`owner_id` text\n);",
  "CREATE TABLE `event` (\n\t`id` text PRIMARY KEY,\n\t`aggregate_id` text NOT NULL,\n\t`seq` integer NOT NULL,\n\t`type` text NOT NULL,\n\t`data` text NOT NULL,\n\tCONSTRAINT `fk_event_aggregate_id_event_sequence_aggregate_id_fk` FOREIGN KEY (`aggregate_id`) REFERENCES `event_sequence`(`aggregate_id`) ON DELETE CASCADE\n);",
  "CREATE INDEX `agent_cluster_event_run_idx` ON `agent_cluster_event` (`run_id`);",
  "CREATE INDEX `agent_cluster_event_task_idx` ON `agent_cluster_event` (`task_id`);",
  "CREATE INDEX `agent_cluster_run_session_idx` ON `agent_cluster_run` (`session_id`);",
  "CREATE INDEX `agent_cluster_run_parent_message_idx` ON `agent_cluster_run` (`parent_message_id`);",
  "CREATE INDEX `agent_cluster_task_run_idx` ON `agent_cluster_task` (`run_id`);",
  "CREATE INDEX `agent_cluster_task_child_session_idx` ON `agent_cluster_task` (`child_session_id`);",
  "CREATE INDEX `message_session_time_created_id_idx` ON `message` (`session_id`,`time_created`,`id`);",
  "CREATE INDEX `part_message_id_id_idx` ON `part` (`message_id`,`id`);",
  "CREATE INDEX `part_session_idx` ON `part` (`session_id`);",
  "CREATE INDEX `session_message_session_idx` ON `session_message` (`session_id`);",
  "CREATE INDEX `session_message_session_type_idx` ON `session_message` (`session_id`,`type`);",
  "CREATE INDEX `session_message_time_created_idx` ON `session_message` (`time_created`);",
  "CREATE INDEX `session_project_idx` ON `session` (`project_id`);",
  "CREATE INDEX `session_workspace_idx` ON `session` (`workspace_id`);",
  "CREATE INDEX `session_parent_idx` ON `session` (`parent_id`);",
  "CREATE INDEX `todo_session_idx` ON `todo` (`session_id`);;"
] as const

export default {
  up(tx) {
    return Effect.forEach(statements, (statement) => tx.run(statement), { discard: true })
  },
} satisfies Omit<DatabaseMigration.Migration, "id">

