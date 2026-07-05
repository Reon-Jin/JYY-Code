-- Add new columns to agent_cluster_task (SQLite 3.35+ supports NOT NULL DEFAULT)
ALTER TABLE `agent_cluster_task` ADD `plan_task_id` text NOT NULL DEFAULT '';
ALTER TABLE `agent_cluster_task` ADD `step` integer NOT NULL DEFAULT 1;
ALTER TABLE `agent_cluster_task` ADD `dependencies` text NOT NULL DEFAULT '[]';
ALTER TABLE `agent_cluster_task` ADD `status_version` integer NOT NULL DEFAULT 0;
ALTER TABLE `agent_cluster_task` ADD `result_text` text;
ALTER TABLE `agent_cluster_task` ADD `review_issues` text NOT NULL DEFAULT '[]';
ALTER TABLE `agent_cluster_task` ADD `revision_prompt` text;
ALTER TABLE `agent_cluster_task` ADD `submitted_at` integer;
ALTER TABLE `agent_cluster_task` ADD `accepted_at` integer;

-- Backfill legacy rows: plan_task_id defaults to the existing id column
UPDATE `agent_cluster_task`
SET `plan_task_id` = `id`,
    `step` = 1,
    `dependencies` = '[]',
    `status_version` = 0,
    `review_issues` = '[]'
WHERE `plan_task_id` = '';

-- Add status_version to agent_cluster_run
ALTER TABLE `agent_cluster_run` ADD `status_version` integer NOT NULL DEFAULT 0;

-- Add unique index on (run_id, plan_task_id) for per-run task identity
CREATE UNIQUE INDEX `agent_cluster_task_run_plan_task_idx` ON `agent_cluster_task` (`run_id`, `plan_task_id`);
