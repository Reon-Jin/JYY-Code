CREATE TABLE `agent_cluster_intervention` (
  `id` text PRIMARY KEY NOT NULL,
  `run_id` text NOT NULL,
  `task_id` text NOT NULL,
  `child_session_id` text NOT NULL,
  `source` text NOT NULL,
  `mode` text NOT NULL,
  `content` text NOT NULL,
  `status` text NOT NULL,
  `sequence` integer NOT NULL,
  `delivered_at` integer,
  `acknowledged_at` integer,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  FOREIGN KEY (`run_id`) REFERENCES `agent_cluster_run`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX `agent_cluster_intervention_child_session_idx` ON `agent_cluster_intervention` (`child_session_id`, `status`, `sequence`);
CREATE INDEX `agent_cluster_intervention_run_task_idx` ON `agent_cluster_intervention` (`run_id`, `task_id`);
