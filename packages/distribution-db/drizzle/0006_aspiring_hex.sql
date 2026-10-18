CREATE TABLE "distribution"."native_analysis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_test" boolean NOT NULL,
	"master_id" uuid NOT NULL,
	"transcript_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"analysis" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_analysis_world" UNIQUE("id","is_test"),
	CONSTRAINT "native_analysis_request" UNIQUE("created_by","is_test","request_id")
);
--> statement-breakpoint
CREATE TABLE "distribution"."native_review" (
	"analysis_id" uuid NOT NULL,
	"is_test" boolean NOT NULL,
	"candidate_id" text NOT NULL,
	"revision" integer NOT NULL,
	"request_id" uuid NOT NULL,
	"review" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_review_analysis_id_is_test_candidate_id_revision_pk" PRIMARY KEY("analysis_id","is_test","candidate_id","revision"),
	CONSTRAINT "native_review_request" UNIQUE("analysis_id","is_test","request_id"),
	CONSTRAINT "native_review_revision_positive" CHECK ("distribution"."native_review"."revision">0)
);
--> statement-breakpoint
CREATE TABLE "distribution"."native_reviewer" (
	"user_id" text NOT NULL,
	"is_test" boolean NOT NULL,
	"language" text NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_reviewer_user_id_is_test_language_pk" PRIMARY KEY("user_id","is_test","language"),
	CONSTRAINT "native_reviewer_language" CHECK ("distribution"."native_reviewer"."language" IN ('te','kn','ta'))
);
--> statement-breakpoint
CREATE TABLE "distribution"."native_source" (
	"master_id" uuid NOT NULL,
	"is_test" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "native_source_master_id_is_test_pk" PRIMARY KEY("master_id","is_test")
);
--> statement-breakpoint
ALTER TABLE "distribution"."native_analysis" ADD CONSTRAINT "native_analysis_master_id_is_test_content_master_id_is_test_fk" FOREIGN KEY ("master_id","is_test") REFERENCES "distribution"."content_master"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."native_analysis" ADD CONSTRAINT "native_analysis_transcript_id_is_test_transcript_version_id_is_test_fk" FOREIGN KEY ("transcript_id","is_test") REFERENCES "distribution"."transcript_version"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."native_review" ADD CONSTRAINT "native_review_analysis_id_is_test_native_analysis_id_is_test_fk" FOREIGN KEY ("analysis_id","is_test") REFERENCES "distribution"."native_analysis"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."native_source" ADD CONSTRAINT "native_source_master_id_is_test_content_master_id_is_test_fk" FOREIGN KEY ("master_id","is_test") REFERENCES "distribution"."content_master"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "native_analysis_master" ON "distribution"."native_analysis" USING btree ("master_id","is_test");