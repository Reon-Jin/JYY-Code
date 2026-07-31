CREATE TABLE `workflow_template` (
  `id` text PRIMARY KEY NOT NULL,
  `display_name` text NOT NULL,
  `scope` text NOT NULL,
  `source` text NOT NULL,
  `installed` integer DEFAULT false NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL
);--> statement-breakpoint
CREATE TABLE `workflow_version` (
  `workflow_id` text NOT NULL,
  `version` text NOT NULL,
  `definition` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  PRIMARY KEY(`workflow_id`, `version`),
  FOREIGN KEY (`workflow_id`) REFERENCES `workflow_template`(`id`) ON DELETE CASCADE
);--> statement-breakpoint
CREATE TABLE `session_workflow_pin` (
  `session_id` text PRIMARY KEY NOT NULL,
  `workflow_id` text NOT NULL,
  `workflow_version` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);--> statement-breakpoint
CREATE TABLE `run_plan` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL,
  `workflow_id` text NOT NULL,
  `workflow_version` text NOT NULL,
  `version` integer NOT NULL,
  `mode` text NOT NULL,
  `goal` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);--> statement-breakpoint
CREATE UNIQUE INDEX `run_plan_session_id_unique` ON `run_plan` (`session_id`);--> statement-breakpoint
CREATE TABLE `run_plan_version` (
  `run_plan_id` text NOT NULL,
  `version` integer NOT NULL,
  `author` text NOT NULL,
  `reason` text NOT NULL,
  `snapshot` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  PRIMARY KEY(`run_plan_id`, `version`),
  FOREIGN KEY (`run_plan_id`) REFERENCES `run_plan`(`id`) ON DELETE CASCADE
);--> statement-breakpoint
CREATE TABLE `plan_patch_operation` (
  `id` text PRIMARY KEY NOT NULL,
  `run_plan_id` text NOT NULL,
  `version` integer NOT NULL,
  `ordinal` integer NOT NULL,
  `operation` text NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  FOREIGN KEY (`run_plan_id`) REFERENCES `run_plan`(`id`) ON DELETE CASCADE
);--> statement-breakpoint
CREATE TABLE `workflow_node_runtime` (
  `run_plan_id` text NOT NULL,
  `node_id` text NOT NULL,
  `status` text NOT NULL,
  `assignee` text,
  `detail` text,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  PRIMARY KEY(`run_plan_id`, `node_id`),
  FOREIGN KEY (`run_plan_id`) REFERENCES `run_plan`(`id`) ON DELETE CASCADE
);--> statement-breakpoint
CREATE TABLE `workflow_runtime_event` (
  `id` text PRIMARY KEY NOT NULL,
  `session_id` text NOT NULL,
  `run_plan_id` text,
  `node_id` text,
  `type` text NOT NULL,
  `payload` text NOT NULL,
  `time_created` integer NOT NULL,
  FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`run_plan_id`) REFERENCES `run_plan`(`id`) ON DELETE CASCADE
);--> statement-breakpoint
CREATE INDEX `session_workflow_pin_workflow_idx` ON `session_workflow_pin` (`workflow_id`,`workflow_version`);--> statement-breakpoint
CREATE INDEX `run_plan_workflow_idx` ON `run_plan` (`workflow_id`,`workflow_version`);--> statement-breakpoint
CREATE INDEX `plan_patch_operation_run_plan_idx` ON `plan_patch_operation` (`run_plan_id`,`version`);--> statement-breakpoint
CREATE INDEX `workflow_node_runtime_status_idx` ON `workflow_node_runtime` (`status`);--> statement-breakpoint
CREATE INDEX `workflow_runtime_event_session_idx` ON `workflow_runtime_event` (`session_id`,`time_created`);
