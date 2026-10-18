CREATE TABLE "distribution"."render_artifact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"is_test" boolean NOT NULL,
	"recipe_sha256" text NOT NULL,
	"asset_sha256" text NOT NULL,
	"output" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "render_artifact_world" UNIQUE("id","is_test"),
	CONSTRAINT "render_artifact_job_world" UNIQUE("job_id","is_test"),
	CONSTRAINT "render_artifact_hashes" CHECK ("distribution"."render_artifact"."recipe_sha256" ~ '^[a-f0-9]{64}$' AND "distribution"."render_artifact"."asset_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "distribution"."render_artifact_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"is_test" boolean NOT NULL,
	"revision" integer NOT NULL,
	"decision" text NOT NULL,
	"recipe_sha256" text NOT NULL,
	"asset_sha256" text NOT NULL,
	"reviewer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "render_artifact_review_revision" UNIQUE("artifact_id","is_test","revision"),
	CONSTRAINT "render_artifact_review_decision" CHECK ("distribution"."render_artifact_review"."decision" IN ('APPROVED','REJECTED')),
	CONSTRAINT "render_artifact_review_revision_positive" CHECK ("distribution"."render_artifact_review"."revision" > 1),
	CONSTRAINT "render_artifact_review_hashes" CHECK ("distribution"."render_artifact_review"."recipe_sha256" ~ '^[a-f0-9]{64}$' AND "distribution"."render_artifact_review"."asset_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "distribution"."render_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_test" boolean NOT NULL,
	"master_id" uuid NOT NULL,
	"source_version_id" uuid NOT NULL,
	"recipe_sha256" text NOT NULL,
	"recipe" jsonb NOT NULL,
	"requested_by" text NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "render_job_world" UNIQUE("id","is_test"),
	CONSTRAINT "render_job_recipe_world" UNIQUE("recipe_sha256","is_test"),
	CONSTRAINT "render_job_hash" CHECK ("distribution"."render_job"."recipe_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "render_job_attempts" CHECK ("distribution"."render_job"."max_attempts" = 3 AND "distribution"."render_job"."attempts" >= 0 AND "distribution"."render_job"."attempts" <= "distribution"."render_job"."max_attempts"),
	CONSTRAINT "render_job_status" CHECK ("distribution"."render_job"."status" IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','STALE')),
	CONSTRAINT "render_job_lease" CHECK (("distribution"."render_job"."status" = 'RUNNING' AND "distribution"."render_job"."lease_token" IS NOT NULL AND "distribution"."render_job"."lease_owner" IS NOT NULL AND "distribution"."render_job"."lease_until" IS NOT NULL) OR ("distribution"."render_job"."status" <> 'RUNNING' AND "distribution"."render_job"."lease_token" IS NULL AND "distribution"."render_job"."lease_owner" IS NULL AND "distribution"."render_job"."lease_until" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "distribution"."render_artifact" ADD CONSTRAINT "render_artifact_job_world_fk" FOREIGN KEY ("job_id","is_test") REFERENCES "distribution"."render_job"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."render_artifact_review" ADD CONSTRAINT "render_artifact_review_world_fk" FOREIGN KEY ("artifact_id","is_test") REFERENCES "distribution"."render_artifact"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."render_job" ADD CONSTRAINT "render_job_master_world_fk" FOREIGN KEY ("master_id","is_test") REFERENCES "distribution"."content_master"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."render_job" ADD CONSTRAINT "render_job_source_world_fk" FOREIGN KEY ("source_version_id","is_test") REFERENCES "distribution"."content_version"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "render_job_claim" ON "distribution"."render_job" USING btree ("is_test","status","available_at","created_at");