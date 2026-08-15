CREATE TABLE `plan_activation` (
	`session_id` text PRIMARY KEY,
	`parent_session_id` text NOT NULL,
	`task_id` text NOT NULL,
	`run_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`generation` integer NOT NULL,
	`lease_expires_at` integer NOT NULL,
	`state` text NOT NULL,
	`recovery_reason` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `plan_activation_parent_idx` ON `plan_activation` (`parent_session_id`,`session_id`);--> statement-breakpoint
CREATE INDEX `plan_activation_lease_idx` ON `plan_activation` (`lease_expires_at`,`state`);--> statement-breakpoint
CREATE INDEX `plan_activation_owner_idx` ON `plan_activation` (`owner_id`,`state`);