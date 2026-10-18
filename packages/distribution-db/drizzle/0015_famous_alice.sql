CREATE TABLE "distribution"."online_import" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_test" boolean NOT NULL,
	"source" jsonb NOT NULL,
	"source_key" text NOT NULL,
	"requested_by" text NOT NULL,
	"language" text NOT NULL,
	"category" text NOT NULL,
	"title" text,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"master_id" uuid,
	"parent_id" uuid,
	"child_ids" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "online_import_source_world" UNIQUE("source_key","is_test"),
	CONSTRAINT "online_import_world" UNIQUE("id","is_test"),
	CONSTRAINT "online_import_status" CHECK ("distribution"."online_import"."status" IN ('QUEUED','DOWNLOADING','COMPLETE','FAILED'))
);
--> statement-breakpoint
ALTER TABLE "distribution"."online_import" ADD CONSTRAINT "online_import_master_world_fk" FOREIGN KEY ("master_id","is_test") REFERENCES "distribution"."content_master"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "online_import_queue" ON "distribution"."online_import" USING btree ("is_test","status","created_at");