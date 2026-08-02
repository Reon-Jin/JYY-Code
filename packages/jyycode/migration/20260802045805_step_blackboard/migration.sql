CREATE TABLE `blackboard_message` (
	`id` text PRIMARY KEY,
	`root_session_id` text NOT NULL,
	`step_id` text NOT NULL,
	`parent_message_id` text,
	`author_kind` text NOT NULL,
	`author_session_id` text,
	`author_task_id` text,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`mentions` text DEFAULT '[]' NOT NULL,
	`attachments` text DEFAULT '[]' NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_blackboard_message_root_session_id_session_id_fk` FOREIGN KEY (`root_session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `blackboard_message_task` (
	`message_id` text NOT NULL,
	`task_id` text NOT NULL,
	CONSTRAINT `blackboard_message_task_pk` PRIMARY KEY(`message_id`, `task_id`),
	CONSTRAINT `fk_blackboard_message_task_message_id_blackboard_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `blackboard_message`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `blackboard_read_cursor` (
	`root_session_id` text NOT NULL,
	`step_id` text NOT NULL,
	`participant_key` text NOT NULL,
	`last_message_id` text,
	`checked_at` integer NOT NULL,
	CONSTRAINT `blackboard_read_cursor_pk` PRIMARY KEY(`root_session_id`, `step_id`, `participant_key`),
	CONSTRAINT `fk_blackboard_read_cursor_root_session_id_session_id_fk` FOREIGN KEY (`root_session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `blackboard_message_session_step_id_idx` ON `blackboard_message` (`root_session_id`,`step_id`,`id`);--> statement-breakpoint
CREATE INDEX `blackboard_message_parent_idx` ON `blackboard_message` (`parent_message_id`);--> statement-breakpoint
CREATE INDEX `blackboard_message_task_task_idx` ON `blackboard_message_task` (`task_id`);
