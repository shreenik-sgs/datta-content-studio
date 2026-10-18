CREATE TABLE "distribution"."cta_definition" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_test" boolean NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cta_definition_world" UNIQUE("id","is_test")
);
--> statement-breakpoint
CREATE TABLE "distribution"."cta_revision" (
	"cta_id" uuid NOT NULL,
	"is_test" boolean NOT NULL,
	"revision" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"action" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cta_revision_cta_id_is_test_revision_pk" PRIMARY KEY("cta_id","is_test","revision"),
	CONSTRAINT "cta_revision_valid" CHECK ("distribution"."cta_revision"."revision">0 AND ("distribution"."cta_revision"."snapshot"->>'revision')::int="distribution"."cta_revision"."revision" AND "distribution"."cta_revision"."snapshot"->>'id'="distribution"."cta_revision"."cta_id"::text),
	CONSTRAINT "cta_revision_action" CHECK ("distribution"."cta_revision"."action" IN ('CREATED','EDITED','APPROVED'))
);
--> statement-breakpoint
CREATE TABLE "distribution"."outreach_campaign" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_test" boolean NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outreach_campaign_world" UNIQUE("id","is_test")
);
--> statement-breakpoint
CREATE TABLE "distribution"."outreach_campaign_revision" (
	"campaign_id" uuid NOT NULL,
	"is_test" boolean NOT NULL,
	"revision" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"action" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outreach_campaign_revision_campaign_id_is_test_revision_pk" PRIMARY KEY("campaign_id","is_test","revision"),
	CONSTRAINT "outreach_campaign_revision_valid" CHECK ("distribution"."outreach_campaign_revision"."revision">0 AND ("distribution"."outreach_campaign_revision"."snapshot"->>'revision')::int="distribution"."outreach_campaign_revision"."revision" AND "distribution"."outreach_campaign_revision"."snapshot"->>'id'="distribution"."outreach_campaign_revision"."campaign_id"::text AND "distribution"."outreach_campaign_revision"."snapshot"->>'kind'='OUTREACH'),
	CONSTRAINT "outreach_campaign_revision_action" CHECK ("distribution"."outreach_campaign_revision"."action" IN ('CREATED','EDITED','APPROVED','PAUSED','STOPPED'))
);
--> statement-breakpoint
ALTER TABLE "distribution"."cta_revision" ADD CONSTRAINT "cta_revision_cta_id_is_test_cta_definition_id_is_test_fk" FOREIGN KEY ("cta_id","is_test") REFERENCES "distribution"."cta_definition"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."outreach_campaign_revision" ADD CONSTRAINT "outreach_campaign_revision_campaign_id_is_test_outreach_campaign_id_is_test_fk" FOREIGN KEY ("campaign_id","is_test") REFERENCES "distribution"."outreach_campaign"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cta_revision_latest" ON "distribution"."cta_revision" USING btree ("is_test","cta_id","revision");--> statement-breakpoint
CREATE INDEX "outreach_campaign_revision_latest" ON "distribution"."outreach_campaign_revision" USING btree ("is_test","campaign_id","revision");