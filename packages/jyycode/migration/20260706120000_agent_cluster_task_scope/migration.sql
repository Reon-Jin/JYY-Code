PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_cluster_task` (
	`id` text NOT NULL,
	`run_id` text NOT NULL,
	`parent_task_id` text,
	`child_session_id` text,
	`role` text NOT NULL,
	`title` text NOT NULL,
	`prompt` text NOT NULL,
	`complexity` text NOT NULL,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`step` integer DEFAULT 1 NOT NULL,
	`dependencies` text DEFAULT '[]' NOT NULL,
	`review_round` integer DEFAULT 0 NOT NULL,
	`acceptance_criteria` text NOT NULL,
	`artifact_paths` text NOT NULL,
	`result_summary` text,
	`review_issues` text DEFAULT '[]' NOT NULL,
	`last_event` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `agent_cluster_task_run_id_id_pk` PRIMARY KEY(`run_id`, `id`),
	CONSTRAINT `fk_agent_cluster_task_run_id_agent_cluster_run_id_fk` FOREIGN KEY (`run_id`) REFERENCES `agent_cluster_run`(`id`) ON DELETE CASCADE
);--> statement-breakpoint
INSERT INTO `__new_agent_cluster_task`(`id`, `run_id`, `parent_task_id`, `child_session_id`, `role`, `title`, `prompt`, `complexity`, `model`, `status`, `step`, `dependencies`, `review_round`, `acceptance_criteria`, `artifact_paths`, `result_summary`, `review_issues`, `last_event`, `time_created`, `time_updated`) SELECT `id`, `run_id`, `parent_task_id`, `child_session_id`, `role`, `title`, `prompt`, `complexity`, `model`, `status`, `step`, `dependencies`, `review_round`, `acceptance_criteria`, `artifact_paths`, `result_summary`, `review_issues`, `last_event`, `time_created`, `time_updated` FROM `agent_cluster_task`;--> statement-breakpoint
DROP TABLE `agent_cluster_task`;--> statement-breakpoint
ALTER TABLE `__new_agent_cluster_task` RENAME TO `agent_cluster_task`;--> statement-breakpoint
CREATE INDEX `agent_cluster_task_run_idx` ON `agent_cluster_task` (`run_id`);--> statement-breakpoint
CREATE INDEX `agent_cluster_task_child_session_idx` ON `agent_cluster_task` (`child_session_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
