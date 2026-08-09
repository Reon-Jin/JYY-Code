ALTER TABLE `agent_cluster_task` ADD `step` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_cluster_task` ADD `dependencies` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_cluster_task` ADD `result_summary` text;--> statement-breakpoint
ALTER TABLE `agent_cluster_task` ADD `review_issues` text DEFAULT '[]' NOT NULL;
