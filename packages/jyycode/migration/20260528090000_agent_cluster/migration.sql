ALTER TABLE `session` ADD `multi_agent_enabled` integer;--> statement-breakpoint
CREATE TABLE `agent_cluster_run` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`parent_message_id` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`status` text NOT NULL,
	`goal` text NOT NULL,
	`planner_model` text NOT NULL,
	`reviewer_model` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_cluster_run_session_idx` ON `agent_cluster_run` (`session_id`);--> statement-breakpoint
CREATE INDEX `agent_cluster_run_parent_message_idx` ON `agent_cluster_run` (`parent_message_id`);--> statement-breakpoint
CREATE TABLE `agent_cluster_task` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`parent_task_id` text,
	`child_session_id` text,
	`role` text NOT NULL,
	`title` text NOT NULL,
	`prompt` text NOT NULL,
	`complexity` text NOT NULL,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`review_round` integer DEFAULT 0 NOT NULL,
	`acceptance_criteria` text NOT NULL,
	`artifact_paths` text NOT NULL,
	`last_event` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_cluster_run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_cluster_task_run_idx` ON `agent_cluster_task` (`run_id`);--> statement-breakpoint
CREATE INDEX `agent_cluster_task_child_session_idx` ON `agent_cluster_task` (`child_session_id`);--> statement-breakpoint
CREATE TABLE `agent_cluster_event` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`task_id` text,
	`type` text NOT NULL,
	`message` text NOT NULL,
	`metadata` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_cluster_run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_cluster_event_run_idx` ON `agent_cluster_event` (`run_id`);--> statement-breakpoint
CREATE INDEX `agent_cluster_event_task_idx` ON `agent_cluster_event` (`task_id`);
