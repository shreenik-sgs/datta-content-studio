CREATE TABLE "distribution"."glossary_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_test" boolean NOT NULL,
	"parent_version_id" uuid,
	"term" text NOT NULL,
	"preferred" text NOT NULL,
	"language" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "glossary_world" UNIQUE("id","is_test"),
	CONSTRAINT "glossary_single_child" UNIQUE("parent_version_id","is_test")
);
--> statement-breakpoint
CREATE TABLE "distribution"."quote_candidate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_test" boolean NOT NULL,
	"master_version_id" uuid NOT NULL,
	"transcript_version_id" uuid NOT NULL,
	"candidate" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quote_candidate_world" UNIQUE("id","is_test")
);
--> statement-breakpoint
CREATE TABLE "distribution"."quote_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_test" boolean NOT NULL,
	"quote_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"decision" text NOT NULL,
	"reviewer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quote_review_revision" UNIQUE("quote_id","is_test","revision"),
	CONSTRAINT "quote_review_decision" CHECK ("distribution"."quote_review"."decision" IN ('APPROVED','REJECTED')),
	CONSTRAINT "quote_review_revision_positive" CHECK ("distribution"."quote_review"."revision" > 1)
);
--> statement-breakpoint
CREATE TABLE "distribution"."transcript_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_test" boolean NOT NULL,
	"transcript_version_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"decision" text NOT NULL,
	"reviewer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcript_review_revision" UNIQUE("transcript_version_id","is_test","revision"),
	CONSTRAINT "transcript_review_decision" CHECK ("distribution"."transcript_review"."decision" IN ('APPROVED','REJECTED')),
	CONSTRAINT "transcript_review_revision_positive" CHECK ("distribution"."transcript_review"."revision" > 1)
);
--> statement-breakpoint
CREATE TABLE "distribution"."transcript_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_test" boolean NOT NULL,
	"master_version_id" uuid NOT NULL,
	"parent_version_id" uuid,
	"language" text NOT NULL,
	"number" integer NOT NULL,
	"transcript" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcript_world" UNIQUE("id","is_test"),
	CONSTRAINT "transcript_source_number" UNIQUE("master_version_id","is_test","language","number"),
	CONSTRAINT "transcript_single_child" UNIQUE("parent_version_id","is_test"),
	CONSTRAINT "transcript_number" CHECK ("distribution"."transcript_version"."number" > 0)
);
--> statement-breakpoint
ALTER TABLE "distribution"."glossary_version" ADD CONSTRAINT "glossary_parent_world_fk" FOREIGN KEY ("parent_version_id","is_test") REFERENCES "distribution"."glossary_version"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."quote_candidate" ADD CONSTRAINT "quote_source_world_fk" FOREIGN KEY ("master_version_id","is_test") REFERENCES "distribution"."content_version"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."quote_candidate" ADD CONSTRAINT "quote_transcript_world_fk" FOREIGN KEY ("transcript_version_id","is_test") REFERENCES "distribution"."transcript_version"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."quote_review" ADD CONSTRAINT "quote_review_world_fk" FOREIGN KEY ("quote_id","is_test") REFERENCES "distribution"."quote_candidate"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."transcript_review" ADD CONSTRAINT "transcript_review_world_fk" FOREIGN KEY ("transcript_version_id","is_test") REFERENCES "distribution"."transcript_version"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."transcript_version" ADD CONSTRAINT "transcript_source_world_fk" FOREIGN KEY ("master_version_id","is_test") REFERENCES "distribution"."content_version"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."transcript_version" ADD CONSTRAINT "transcript_parent_world_fk" FOREIGN KEY ("parent_version_id","is_test") REFERENCES "distribution"."transcript_version"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "glossary_language" ON "distribution"."glossary_version" USING btree ("is_test","language","term");--> statement-breakpoint
CREATE INDEX "quote_candidate_source" ON "distribution"."quote_candidate" USING btree ("master_version_id","is_test","created_at");