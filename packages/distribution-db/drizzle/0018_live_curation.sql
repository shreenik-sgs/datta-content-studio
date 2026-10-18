CREATE TABLE "distribution"."live_broadcast" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_test" boolean NOT NULL,
	"monitor_id" uuid NOT NULL,
	"video_id" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'CAPTURING' NOT NULL,
	"state" jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_broadcast_world" UNIQUE("id","is_test"),
	CONSTRAINT "live_broadcast_video" UNIQUE("video_id","is_test"),
	CONSTRAINT "live_broadcast_status" CHECK ("distribution"."live_broadcast"."status" IN ('CAPTURING','ENDED','NEEDS_ATTENTION'))
);
--> statement-breakpoint
CREATE TABLE "distribution"."live_monitor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_test" boolean NOT NULL,
	"channel_id" text NOT NULL,
	"settings" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"requested_by" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"checked_at" timestamp with time zone,
	"error" text,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_monitor_world" UNIQUE("id","is_test"),
	CONSTRAINT "live_monitor_channel" UNIQUE("channel_id","is_test"),
	CONSTRAINT "live_monitor_revision" CHECK ("distribution"."live_monitor"."revision">0)
);
--> statement-breakpoint
CREATE TABLE "distribution"."live_window" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_test" boolean NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"start_ms" integer NOT NULL,
	"end_ms" integer NOT NULL,
	"owned_end_ms" integer NOT NULL,
	"master_id" uuid NOT NULL,
	"package_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_window_identity" UNIQUE("broadcast_id","is_test","number"),
	CONSTRAINT "live_window_span" CHECK ("distribution"."live_window"."start_ms">=0 AND "distribution"."live_window"."end_ms">"distribution"."live_window"."start_ms" AND "distribution"."live_window"."owned_end_ms">0 AND "distribution"."live_window"."owned_end_ms"<="distribution"."live_window"."end_ms"-"distribution"."live_window"."start_ms"+1)
);
--> statement-breakpoint
ALTER TABLE "distribution"."live_broadcast" ADD CONSTRAINT "live_broadcast_monitor_id_is_test_live_monitor_id_is_test_fk" FOREIGN KEY ("monitor_id","is_test") REFERENCES "distribution"."live_monitor"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."live_window" ADD CONSTRAINT "live_window_broadcast_id_is_test_live_broadcast_id_is_test_fk" FOREIGN KEY ("broadcast_id","is_test") REFERENCES "distribution"."live_broadcast"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."live_window" ADD CONSTRAINT "live_window_master_id_is_test_content_master_id_is_test_fk" FOREIGN KEY ("master_id","is_test") REFERENCES "distribution"."content_master"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."live_window" ADD CONSTRAINT "live_window_package_id_is_test_studio_package_id_is_test_fk" FOREIGN KEY ("package_id","is_test") REFERENCES "distribution"."studio_package"("id","is_test") ON DELETE no action ON UPDATE no action;