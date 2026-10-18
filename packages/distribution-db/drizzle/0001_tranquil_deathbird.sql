CREATE TABLE "distribution"."approval_decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"is_test" boolean NOT NULL,
	"approved_revision" integer NOT NULL,
	"reviewer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_version_revision" UNIQUE("version_id","is_test","approved_revision")
);
--> statement-breakpoint
CREATE TABLE "distribution"."audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"master_id" uuid NOT NULL,
	"is_test" boolean NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "distribution"."capability_grant" (
	"user_id" text NOT NULL,
	"is_test" boolean NOT NULL,
	"capability" text NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capability_grant_user_id_is_test_capability_pk" PRIMARY KEY("user_id","is_test","capability")
);
--> statement-breakpoint
CREATE TABLE "distribution"."content_master" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_test" boolean NOT NULL,
	"title" text NOT NULL,
	"language" text NOT NULL,
	"category" text NOT NULL,
	"state" text DEFAULT 'DRAFT' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"current_version_number" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_master_world" UNIQUE("id","is_test"),
	CONSTRAINT "content_master_revision" CHECK ("distribution"."content_master"."revision" > 0 AND "distribution"."content_master"."current_version_number" > 0),
	CONSTRAINT "content_master_state" CHECK ("distribution"."content_master"."state" IN ('DRAFT','RIGHTS_CLEARED','APPROVED','PUBLISHED','WITHDRAWN'))
);
--> statement-breakpoint
CREATE TABLE "distribution"."content_rights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"is_test" boolean NOT NULL,
	"revision" integer NOT NULL,
	"rights" jsonb NOT NULL,
	"attested_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_rights_revision" UNIQUE("version_id","is_test","revision")
);
--> statement-breakpoint
CREATE TABLE "distribution"."content_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"master_id" uuid NOT NULL,
	"is_test" boolean NOT NULL,
	"number" integer NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"mime_type" text NOT NULL,
	"original_name" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_version_world" UNIQUE("id","is_test"),
	CONSTRAINT "content_version_number" UNIQUE("master_id","is_test","number"),
	CONSTRAINT "content_version_storage_key" UNIQUE("storage_key"),
	CONSTRAINT "content_version_bytes" CHECK ("distribution"."content_version"."byte_size" > 0 AND "distribution"."content_version"."byte_size" <= 52428800),
	CONSTRAINT "content_version_sha256" CHECK ("distribution"."content_version"."sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "distribution"."approval_decision" ADD CONSTRAINT "approval_version_world_fk" FOREIGN KEY ("version_id","is_test") REFERENCES "distribution"."content_version"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."audit_event" ADD CONSTRAINT "audit_master_world_fk" FOREIGN KEY ("master_id","is_test") REFERENCES "distribution"."content_master"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."content_rights" ADD CONSTRAINT "rights_version_world_fk" FOREIGN KEY ("version_id","is_test") REFERENCES "distribution"."content_version"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."content_version" ADD CONSTRAINT "version_master_world_fk" FOREIGN KEY ("master_id","is_test") REFERENCES "distribution"."content_master"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_event_master" ON "distribution"."audit_event" USING btree ("master_id","is_test","created_at");--> statement-breakpoint
CREATE INDEX "content_master_library" ON "distribution"."content_master" USING btree ("is_test","updated_at","id");