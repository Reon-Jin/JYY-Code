import { Effect } from "effect"
import type { DatabaseMigration } from "./migration"

const statements = [
  "CREATE TABLE `workspace` (\n\t`id` text PRIMARY KEY,\n\t`type` text NOT NULL,\n\t`name` text DEFAULT '' NOT NULL,\n\t`branch` text,\n\t`directory` text,\n\t`extra` text,\n\t`project_id` text NOT NULL,\n\t`time_used` integer NOT NULL,\n\tCONSTRAINT `fk_workspace_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE\n);",
  "CREATE TABLE `data_migration` (\n\t`name` text PRIMARY KEY,\n\t`time_completed` integer NOT NULL\n);",
  "CREATE TABLE `project` (\n\t`id` text PRIMARY KEY,\n\t`worktree` text NOT NULL,\n\t`vcs` text,\n\t`name` text,\n\t`icon_url` text,\n\t`icon_url_override` text,\n\t`icon_color` text,\n\t`time_created` integer NOT NULL,\n\t`time_updated` integer NOT NULL,\n\t`time_initialized` integer,\n\t`sandboxes` text NOT NULL,\n\t`commands` text\n);",
  "CREATE TABLE `message` (\n\t`id` text PRIMARY KEY,\n\t`session_id` text NOT NULL,\n\t`time_created` integer NOT NULL,\n\t`time_updated` integer NOT NULL,\n\t`data` text NOT NULL,\n\tCONSTRAINT `fk_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE\n);",
  "CREATE TABLE `part` (\n\t`id` text PRIMARY KEY,\n\t`message_id` text NOT NULL,\n\t`session_id` text NOT NULL,\n\t`time_created` integer NOT NULL,\n\t`time_updated` integer NOT NULL,\n\t`data` text NOT NULL,\n\tCONSTRAINT `fk_part_message_id_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON DELETE CASCADE\n);",
  "CREATE TABLE `permission` (\n\t`project_id` text PRIMARY KEY,\n\t`time_created` integer NOT NULL,\n\t`time_updated` integer NOT NULL,\n\t`data` text NOT NULL,\n\tCONSTRAINT `fk_permission_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE\n);",
  "CREATE TABLE `session_message` (\n\t`id` text PRIMARY KEY,\n\t`session_id` text NOT NULL,\n\t`type` text NOT NULL,\n\t`time_created` integer NOT NULL,\n\t`time_updated` integer NOT NULL,\n\t`data` text NOT NULL,\n\tCONSTRAINT `fk_session_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE\n);",
  "CREATE TABLE `session` (\n\t`id` text PRIMARY KEY,\n\t`project_id` text NOT NULL,\n\t`workspace_id` text,\n\t`parent_id` text,\n\t`slug` text NOT NULL,\n\t`directory` text NOT NULL,\n\t`path` text,\n\t`title` text NOT NULL,\n\t`version` text NOT NULL,\n\t`share_url` text,\n\t`summary_additions` integer,\n\t`summary_deletions` integer,\n\t`summary_files` integer,\n\t`summary_diffs` text,\n\t`cost` real DEFAULT 0 NOT NULL,\n\t`tokens_input` integer DEFAULT 0 NOT NULL,\n\t`tokens_output` integer DEFAULT 0 NOT NULL,\n\t`tokens_reasoning` integer DEFAULT 0 NOT NULL,\n\t`tokens_cache_read` integer DEFAULT 0 NOT NULL,\n\t`tokens_cache_write` integer DEFAULT 0 NOT NULL,\n\t`revert` text,\n\t`permission` text,\n\t`agent` text,\n\t`model` text,\n\t`goal` text,\n\t`multi_agent_enabled` integer,\n\t`time_created` integer NOT NULL,\n\t`time_updated` integer NOT NULL,\n\t`time_compacting` integer,\n\t`time_archived` integer,\n\tCONSTRAINT `fk_session_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE\n);",
  "CREATE TABLE `blackboard_message` (\n\t`id` text PRIMARY KEY,\n\t`root_session_id` text NOT NULL,\n\t`step_id` text NOT NULL,\n\t`parent_message_id` text,\n\t`author_kind` text NOT NULL,\n\t`author_session_id` text,\n\t`author_task_id` text,\n\t`kind` text NOT NULL,\n\t`purpose` text DEFAULT 'general' NOT NULL,\n\t`body` text NOT NULL,\n\t`mentions` text DEFAULT '[]' NOT NULL,\n\t`attachments` text DEFAULT '[]' NOT NULL,\n\t`time_created` integer NOT NULL,\n\t`time_updated` integer NOT NULL,\n\tCONSTRAINT `fk_blackboard_message_root_session_id_session_id_fk` FOREIGN KEY (`root_session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE\n);",
  "CREATE TABLE `blackboard_message_task` (\n\t`message_id` text NOT NULL,\n\t`task_id` text NOT NULL,\n\tCONSTRAINT `blackboard_message_task_pk` PRIMARY KEY(`message_id`, `task_id`),\n\tCONSTRAINT `fk_blackboard_message_task_message_id_blackboard_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `blackboard_message`(`id`) ON DELETE CASCADE\n);",
  "CREATE TABLE `blackboard_read_cursor` (\n\t`root_session_id` text NOT NULL,\n\t`step_id` text NOT NULL,\n\t`participant_key` text NOT NULL,\n\t`last_message_id` text,\n\t`checked_at` integer NOT NULL,\n\tCONSTRAINT `blackboard_read_cursor_pk` PRIMARY KEY(`root_session_id`, `step_id`, `participant_key`),\n\tCONSTRAINT `fk_blackboard_read_cursor_root_session_id_session_id_fk` FOREIGN KEY (`root_session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE\n);",
  "CREATE TABLE `todo` (\n\t`session_id` text NOT NULL,\n\t`content` text NOT NULL,\n\t`status` text NOT NULL,\n\t`priority` text NOT NULL,\n\t`position` integer NOT NULL,\n\t`time_created` integer NOT NULL,\n\t`time_updated` integer NOT NULL,\n\tCONSTRAINT `todo_pk` PRIMARY KEY(`session_id`, `position`),\n\tCONSTRAINT `fk_todo_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE\n);",
  "CREATE TABLE `session_share` (\n\t`session_id` text PRIMARY KEY,\n\t`id` text NOT NULL,\n\t`secret` text NOT NULL,\n\t`url` text NOT NULL,\n\t`time_created` integer NOT NULL,\n\t`time_updated` integer NOT NULL,\n\tCONSTRAINT `fk_session_share_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE\n);",
  "CREATE TABLE `event_sequence` (\n\t`aggregate_id` text PRIMARY KEY,\n\t`seq` integer NOT NULL,\n\t`owner_id` text\n);",
  "CREATE TABLE `event` (\n\t`id` text PRIMARY KEY,\n\t`aggregate_id` text NOT NULL,\n\t`seq` integer NOT NULL,\n\t`type` text NOT NULL,\n\t`data` text NOT NULL,\n\tCONSTRAINT `fk_event_aggregate_id_event_sequence_aggregate_id_fk` FOREIGN KEY (`aggregate_id`) REFERENCES `event_sequence`(`aggregate_id`) ON DELETE CASCADE\n);",
  "CREATE INDEX `message_session_time_created_id_idx` ON `message` (`session_id`,`time_created`,`id`);",
  "CREATE INDEX `part_message_id_id_idx` ON `part` (`message_id`,`id`);",
  "CREATE INDEX `part_session_idx` ON `part` (`session_id`);",
  "CREATE INDEX `session_message_session_idx` ON `session_message` (`session_id`);",
  "CREATE INDEX `session_message_session_type_idx` ON `session_message` (`session_id`,`type`);",
  "CREATE INDEX `session_message_time_created_idx` ON `session_message` (`time_created`);",
  "CREATE INDEX `session_project_idx` ON `session` (`project_id`);",
  "CREATE INDEX `session_workspace_idx` ON `session` (`workspace_id`);",
  "CREATE INDEX `session_parent_idx` ON `session` (`parent_id`);",
  "CREATE INDEX `blackboard_message_session_step_id_idx` ON `blackboard_message` (`root_session_id`,`step_id`,`id`);",
  "CREATE INDEX `blackboard_message_parent_idx` ON `blackboard_message` (`parent_message_id`);",
  "CREATE INDEX `blackboard_message_task_task_idx` ON `blackboard_message_task` (`task_id`);",
  "CREATE INDEX `todo_session_idx` ON `todo` (`session_id`);;",
  "CREATE TABLE `blob` (\n\t`digest` text PRIMARY KEY,\n\t`size` integer NOT NULL,\n\t`mime` text NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`verified_at` integer NOT NULL,\n\t`last_ref_removed_at` integer\n);",
  "CREATE TABLE `blob_ref` (\n\t`part_id` text NOT NULL,\n\t`slot` text NOT NULL,\n\t`digest` text NOT NULL,\n\t`created_at` integer NOT NULL,\n\tCONSTRAINT `blob_ref_pk` PRIMARY KEY(`part_id`, `slot`),\n\tCONSTRAINT `fk_blob_ref_part_id_part_id_fk` FOREIGN KEY (`part_id`) REFERENCES `part`(`id`) ON DELETE CASCADE,\n\tCONSTRAINT `fk_blob_ref_digest_blob_digest_fk` FOREIGN KEY (`digest`) REFERENCES `blob`(`digest`) ON DELETE RESTRICT\n);",
  "CREATE INDEX `blob_ref_digest_idx` ON `blob_ref` (`digest`);",
  "CREATE INDEX `blob_verified_idx` ON `blob` (`verified_at`);",
] as const

export default {
  up(tx) {
    return Effect.forEach(statements, (statement) => tx.run(statement), { discard: true })
  },
} satisfies Omit<DatabaseMigration.Migration, "id">
