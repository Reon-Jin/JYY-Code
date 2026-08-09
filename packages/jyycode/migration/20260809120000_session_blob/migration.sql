CREATE TABLE `plan_event` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`revision` integer,
	`payload` text NOT NULL,
	`time_created` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plan_inbox` (
	`id` text PRIMARY KEY,
	`session_id` text NOT NULL,
	`task_id` text,
	`run_id` text,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`step_id` text,
	`task_title` text,
	`report` text,
	`suggested_actions` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE TABLE `blob_ref` (
	`part_id` text NOT NULL,
	`slot` text NOT NULL,
	`digest` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `blob_ref_pk` PRIMARY KEY(`part_id`, `slot`),
	CONSTRAINT `fk_blob_ref_part_id_part_id_fk` FOREIGN KEY (`part_id`) REFERENCES `part`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_blob_ref_digest_blob_digest_fk` FOREIGN KEY (`digest`) REFERENCES `blob`(`digest`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `blob` (
	`digest` text PRIMARY KEY,
	`size` integer NOT NULL,
	`mime` text NOT NULL,
	`created_at` integer NOT NULL,
	`verified_at` integer NOT NULL,
	`last_ref_removed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plan_event_session_seq_idx` ON `plan_event` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `plan_event_session_idx` ON `plan_event` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `plan_inbox_session_resolved_idx` ON `plan_inbox` (`session_id`,`resolved_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `plan_inbox_session_task_idx` ON `plan_inbox` (`session_id`,`task_id`);--> statement-breakpoint
CREATE INDEX `blob_ref_digest_idx` ON `blob_ref` (`digest`);--> statement-breakpoint
CREATE INDEX `blob_verified_idx` ON `blob` (`verified_at`);