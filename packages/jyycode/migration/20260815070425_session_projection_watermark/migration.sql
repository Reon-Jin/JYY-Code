CREATE TABLE `session_projection` (
	`aggregate_id` text NOT NULL,
	`projector` text NOT NULL,
	`projector_version` integer NOT NULL,
	`seq` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `session_projection_pk` PRIMARY KEY(`aggregate_id`, `projector`)
);
--> statement-breakpoint
ALTER TABLE `event` ADD `ignorable` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `session_projection_aggregate_seq_idx` ON `session_projection` (`aggregate_id`,`seq`);