CREATE TABLE "distribution"."studio_visual_lesson" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_test" boolean NOT NULL,
	"rule" text NOT NULL,
	"scope" text NOT NULL,
	"source" text NOT NULL,
	"source_reason" text NOT NULL,
	"package_id" uuid,
	"hits" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"retired_by" text,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_visual_lesson_rule_size" CHECK (char_length("distribution"."studio_visual_lesson"."rule") BETWEEN 12 AND 400),
	CONSTRAINT "studio_visual_lesson_reason_size" CHECK (char_length("distribution"."studio_visual_lesson"."source_reason") <= 4000),
	CONSTRAINT "studio_visual_lesson_scope" CHECK ("distribution"."studio_visual_lesson"."scope" IN ('iconography','anatomy','composition','style','continuity','text')),
	CONSTRAINT "studio_visual_lesson_status" CHECK ("distribution"."studio_visual_lesson"."status" IN ('ACTIVE','RETIRED')),
	CONSTRAINT "studio_visual_lesson_source" CHECK ("distribution"."studio_visual_lesson"."source" IN ('IMAGE_REVIEW','CURATOR')),
	CONSTRAINT "studio_visual_lesson_hits" CHECK ("distribution"."studio_visual_lesson"."hits">=1)
);
--> statement-breakpoint
CREATE INDEX "studio_visual_lesson_active" ON "distribution"."studio_visual_lesson" USING btree ("is_test","status","updated_at");