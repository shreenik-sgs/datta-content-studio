CREATE TABLE "distribution"."activation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"is_test" boolean NOT NULL,
	"master_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"cta_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"token" text NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activation_world" UNIQUE("id","is_test"),
	CONSTRAINT "activation_token" UNIQUE("token"),
	CONSTRAINT "activation_token_shape" CHECK ("distribution"."activation"."token" ~ '^[A-Za-z0-9_-]{43}$'),
	CONSTRAINT "activation_sequence_nonnegative" CHECK ("distribution"."activation"."sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "distribution"."activation_revision" (
	"activation_id" uuid NOT NULL,
	"is_test" boolean NOT NULL,
	"revision" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"action" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activation_revision_activation_id_is_test_revision_pk" PRIMARY KEY("activation_id","is_test","revision"),
	CONSTRAINT "activation_revision_valid" CHECK ("distribution"."activation_revision"."revision">0 AND ("distribution"."activation_revision"."snapshot"->>'revision')::int="distribution"."activation_revision"."revision" AND "distribution"."activation_revision"."snapshot"->>'id'="distribution"."activation_revision"."activation_id"::text),
	CONSTRAINT "activation_revision_action" CHECK ("distribution"."activation_revision"."action" IN ('CREATED','APPROVED','STOPPED','INVALIDATED'))
);
--> statement-breakpoint
CREATE TABLE "distribution"."link_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"activation_id" uuid NOT NULL,
	"is_test" boolean NOT NULL,
	"sequence" integer NOT NULL,
	"record" jsonb NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "link_outbox_sequence" UNIQUE("activation_id","is_test","sequence"),
	CONSTRAINT "link_outbox_sequence_valid" CHECK ("distribution"."link_outbox"."sequence">0 AND ("distribution"."link_outbox"."record"->>'sequence')::int="distribution"."link_outbox"."sequence")
);
--> statement-breakpoint
ALTER TABLE "distribution"."activation" ADD CONSTRAINT "activation_master_id_is_test_content_master_id_is_test_fk" FOREIGN KEY ("master_id","is_test") REFERENCES "distribution"."content_master"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."activation" ADD CONSTRAINT "activation_campaign_id_is_test_outreach_campaign_id_is_test_fk" FOREIGN KEY ("campaign_id","is_test") REFERENCES "distribution"."outreach_campaign"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."activation" ADD CONSTRAINT "activation_cta_id_is_test_cta_definition_id_is_test_fk" FOREIGN KEY ("cta_id","is_test") REFERENCES "distribution"."cta_definition"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."activation" ADD CONSTRAINT "activation_artifact_id_is_test_render_artifact_id_is_test_fk" FOREIGN KEY ("artifact_id","is_test") REFERENCES "distribution"."render_artifact"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."activation_revision" ADD CONSTRAINT "activation_revision_activation_id_is_test_activation_id_is_test_fk" FOREIGN KEY ("activation_id","is_test") REFERENCES "distribution"."activation"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."link_outbox" ADD CONSTRAINT "link_outbox_activation_id_is_test_activation_id_is_test_fk" FOREIGN KEY ("activation_id","is_test") REFERENCES "distribution"."activation"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activation_master_world" ON "distribution"."activation" USING btree ("is_test","master_id");--> statement-breakpoint
CREATE INDEX "activation_campaign_world" ON "distribution"."activation" USING btree ("is_test","campaign_id");--> statement-breakpoint
CREATE INDEX "activation_cta_world" ON "distribution"."activation" USING btree ("is_test","cta_id");--> statement-breakpoint
CREATE INDEX "link_outbox_pending" ON "distribution"."link_outbox" USING btree ("is_test","delivered_at","created_at");