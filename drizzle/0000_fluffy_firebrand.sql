CREATE TABLE `race_telemetry` (
	`id` text PRIMARY KEY NOT NULL,
	`race_id` text NOT NULL,
	`player` text NOT NULL,
	`status` text DEFAULT '待機中' NOT NULL,
	`session_id` text,
	`actions` integer DEFAULT 0 NOT NULL,
	`frame_at` integer
);
--> statement-breakpoint
CREATE TABLE `races` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`state` text NOT NULL,
	`red_hash` text NOT NULL,
	`blue_hash` text NOT NULL
);
