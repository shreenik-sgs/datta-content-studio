CREATE TABLE "distribution"."aggregate_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_test" boolean NOT NULL,
	"campaign_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"source_fingerprint" text NOT NULL,
	"report" jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "analytics_snapshot_input" UNIQUE("is_test","campaign_id","window_start","window_end","source_fingerprint")
);
--> statement-breakpoint
CREATE TABLE "distribution"."analytics_event" (
	"id" uuid NOT NULL,
	"is_test" boolean NOT NULL,
	"campaign_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"event" jsonb NOT NULL,
	CONSTRAINT "analytics_event_id_is_test_received_at_pk" PRIMARY KEY("id","is_test","received_at")
) PARTITION BY RANGE ("received_at");
--> statement-breakpoint
CREATE TABLE "distribution"."analytics_event_default" PARTITION OF "distribution"."analytics_event" DEFAULT;
--> statement-breakpoint
CREATE TABLE "distribution"."analytics_policy" (
	"is_test" boolean PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"retention_days" integer NOT NULL,
	"approval_reference" uuid NOT NULL,
	"approved_by" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "analytics_retention_bounds" CHECK ("distribution"."analytics_policy"."retention_days" between 7 and 90)
);
--> statement-breakpoint
CREATE TABLE "distribution"."analytics_receipt" (
	"id" uuid NOT NULL,
	"is_test" boolean NOT NULL,
	"source" text NOT NULL,
	"source_event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"fingerprint" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "analytics_receipt_id_is_test_pk" PRIMARY KEY("id","is_test"),
	CONSTRAINT "analytics_source_dedupe" UNIQUE("is_test","source","source_event_id","name")
);
--> statement-breakpoint
CREATE TABLE "distribution"."provider_metric_snapshot" (
	"id" uuid NOT NULL,
	"is_test" boolean NOT NULL,
	"campaign_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"metric" text NOT NULL,
	"value" bigint NOT NULL,
	"currency" text,
	"definition_version" integer NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"retrieved_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"fingerprint" text NOT NULL,
	CONSTRAINT "provider_metric_snapshot_id_is_test_pk" PRIMARY KEY("id","is_test")
);
--> statement-breakpoint
ALTER TABLE "distribution"."analytics_event" ADD CONSTRAINT "analytics_event_campaign_id_is_test_outreach_campaign_id_is_test_fk" FOREIGN KEY ("campaign_id","is_test") REFERENCES "distribution"."outreach_campaign"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analytics_latest_snapshot" ON "distribution"."aggregate_snapshot" USING btree ("is_test","campaign_id","generated_at");--> statement-breakpoint
CREATE INDEX "analytics_campaign_window" ON "distribution"."analytics_event" USING btree ("is_test","campaign_id","occurred_at");--> statement-breakpoint
CREATE INDEX "analytics_provider_latest" ON "distribution"."provider_metric_snapshot" USING btree ("is_test","campaign_id","observed_at");