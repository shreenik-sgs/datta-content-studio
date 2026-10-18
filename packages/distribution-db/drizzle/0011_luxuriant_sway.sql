CREATE TABLE "distribution"."studio_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_id" uuid NOT NULL,
	"is_test" boolean NOT NULL,
	"revision" integer NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"comment" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_feedback_action" CHECK ("distribution"."studio_feedback"."action" IN ('APPROVED','REJECTED','DISCARDED','REVISED','SUBMITTED')),
	CONSTRAINT "studio_feedback_comment" CHECK (length("distribution"."studio_feedback"."comment")<=4000 AND ("distribution"."studio_feedback"."action"<>'REJECTED' OR length(trim("distribution"."studio_feedback"."comment"))>0))
);
--> statement-breakpoint
CREATE TABLE "distribution"."studio_generation_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_id" uuid NOT NULL,
	"is_test" boolean NOT NULL,
	"package_revision" integer NOT NULL,
	"requested_by" text NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_generation_identity" UNIQUE("package_id","is_test","package_revision"),
	CONSTRAINT "studio_generation_status" CHECK ("distribution"."studio_generation_job"."status" IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','STALE')),
	CONSTRAINT "studio_generation_attempts" CHECK ("distribution"."studio_generation_job"."attempts">=0 AND "distribution"."studio_generation_job"."attempts"<=3)
);
--> statement-breakpoint
CREATE TABLE "distribution"."studio_package" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_test" boolean NOT NULL,
	"master_id" uuid NOT NULL,
	"source_version_id" uuid NOT NULL,
	"creation_key" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_package_world" UNIQUE("id","is_test"),
	CONSTRAINT "studio_package_creation" UNIQUE("creation_key","is_test"),
	CONSTRAINT "studio_package_revision_positive" CHECK ("distribution"."studio_package"."revision">0),
	CONSTRAINT "studio_package_creation_hash" CHECK ("distribution"."studio_package"."creation_key" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "distribution"."studio_publication_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publication_id" uuid NOT NULL,
	"is_test" boolean NOT NULL,
	"attempt" integer NOT NULL,
	"status" text NOT NULL,
	"detail" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_attempt_positive" CHECK ("distribution"."studio_publication_attempt"."attempt">=0)
);
--> statement-breakpoint
CREATE TABLE "distribution"."studio_publication_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_id" uuid NOT NULL,
	"is_test" boolean NOT NULL,
	"package_revision" integer NOT NULL,
	"output_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"requested_by" text NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"account_id" text,
	"remote_id" text,
	"remote_url" text,
	"checkpoint" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_publication_world" UNIQUE("id","is_test"),
	CONSTRAINT "studio_publication_identity" UNIQUE("package_id","is_test","package_revision","output_id"),
	CONSTRAINT "studio_publication_status" CHECK ("distribution"."studio_publication_job"."status" IN ('QUEUED','RUNNING','PROCESSING','PUBLISHED','SIMULATED','BLOCKED','FAILED','UNCERTAIN','CANCELLED')),
	CONSTRAINT "studio_publication_world_delivery" CHECK (NOT "distribution"."studio_publication_job"."is_test" OR "distribution"."studio_publication_job"."status" NOT IN ('PUBLISHED','PROCESSING')),
	CONSTRAINT "studio_publication_attempts" CHECK ("distribution"."studio_publication_job"."attempts">=0)
);
--> statement-breakpoint
CREATE TABLE "distribution"."studio_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"package_id" uuid NOT NULL,
	"is_test" boolean NOT NULL,
	"revision" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_revision_identity" UNIQUE("package_id","is_test","revision"),
	CONSTRAINT "studio_revision_positive" CHECK ("distribution"."studio_revision"."revision">0)
);
--> statement-breakpoint
ALTER TABLE "distribution"."studio_feedback" ADD CONSTRAINT "studio_feedback_revision_fk" FOREIGN KEY ("package_id","is_test","revision") REFERENCES "distribution"."studio_revision"("package_id","is_test","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."studio_generation_job" ADD CONSTRAINT "studio_generation_revision_fk" FOREIGN KEY ("package_id","is_test","package_revision") REFERENCES "distribution"."studio_revision"("package_id","is_test","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."studio_package" ADD CONSTRAINT "studio_package_master_fk" FOREIGN KEY ("master_id","is_test") REFERENCES "distribution"."content_master"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."studio_package" ADD CONSTRAINT "studio_package_source_fk" FOREIGN KEY ("source_version_id","is_test") REFERENCES "distribution"."content_version"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."studio_publication_attempt" ADD CONSTRAINT "studio_attempt_publication_fk" FOREIGN KEY ("publication_id","is_test") REFERENCES "distribution"."studio_publication_job"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."studio_publication_job" ADD CONSTRAINT "studio_publication_revision_fk" FOREIGN KEY ("package_id","is_test","package_revision") REFERENCES "distribution"."studio_revision"("package_id","is_test","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."studio_revision" ADD CONSTRAINT "studio_revision_package_fk" FOREIGN KEY ("package_id","is_test") REFERENCES "distribution"."studio_package"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "studio_generation_queue" ON "distribution"."studio_generation_job" USING btree ("is_test","status","available_at");--> statement-breakpoint
CREATE INDEX "studio_package_library" ON "distribution"."studio_package" USING btree ("is_test","master_id","created_at");--> statement-breakpoint
CREATE INDEX "studio_publication_queue" ON "distribution"."studio_publication_job" USING btree ("is_test","status","available_at");