CREATE TABLE "distribution"."storage_cleanup" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_test" boolean NOT NULL,
	"requested_by" text NOT NULL,
	"title" text NOT NULL,
	"selection" jsonb NOT NULL,
	"files" jsonb NOT NULL,
	"removed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "distribution"."content_master" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "distribution"."online_import" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "distribution"."studio_package" ADD COLUMN "deleted_at" timestamp with time zone;