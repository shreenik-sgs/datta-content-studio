CREATE TABLE "distribution"."channel_account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"is_test" boolean NOT NULL,
	"channel" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_account_world" UNIQUE("id","is_test"),
	CONSTRAINT "channel_account_test_only" CHECK ("distribution"."channel_account"."is_test"=true),
	CONSTRAINT "channel_account_channel" CHECK ("distribution"."channel_account"."channel" IN ('youtube','telegram'))
);
--> statement-breakpoint
CREATE TABLE "distribution"."channel_account_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"is_test" boolean NOT NULL,
	"revision" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"request_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_account_revision_unique" UNIQUE("account_id","is_test","revision"),
	CONSTRAINT "channel_account_request_unique" UNIQUE("account_id","is_test","request_id"),
	CONSTRAINT "channel_account_revision_positive" CHECK ("distribution"."channel_account_revision"."revision">0),
	CONSTRAINT "channel_account_revision_test_only" CHECK ("distribution"."channel_account_revision"."is_test"=true)
);
--> statement-breakpoint
CREATE TABLE "distribution"."channel_publication" (
	"id" uuid PRIMARY KEY NOT NULL,
	"is_test" boolean NOT NULL,
	"account_id" uuid NOT NULL,
	"activation_id" uuid NOT NULL,
	"activation_revision" integer NOT NULL,
	"publication_key" text NOT NULL,
	"payload_sha256" text NOT NULL,
	"plan" jsonb NOT NULL,
	"simulation_only" boolean DEFAULT true NOT NULL,
	"approved_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_publication_world" UNIQUE("id","is_test"),
	CONSTRAINT "channel_publication_identity" UNIQUE("publication_key"),
	CONSTRAINT "channel_publication_local_only" CHECK ("distribution"."channel_publication"."is_test"=true AND "distribution"."channel_publication"."simulation_only"=true),
	CONSTRAINT "channel_publication_sha" CHECK ("distribution"."channel_publication"."payload_sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "distribution"."channel_publication_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publication_id" uuid NOT NULL,
	"is_test" boolean NOT NULL,
	"revision" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"action" text NOT NULL,
	"request_id" uuid NOT NULL,
	"request_sha256" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_publication_revision_unique" UNIQUE("publication_id","is_test","revision"),
	CONSTRAINT "channel_publication_request_unique" UNIQUE("publication_id","is_test","request_id"),
	CONSTRAINT "channel_publication_revision_positive" CHECK ("distribution"."channel_publication_revision"."revision">0),
	CONSTRAINT "channel_publication_revision_test_only" CHECK ("distribution"."channel_publication_revision"."is_test"=true),
	CONSTRAINT "channel_publication_revision_action" CHECK ("distribution"."channel_publication_revision"."action" IN ('PREPARED','CLAIMED','SIMULATED_RESULT','RECOVERED'))
);
--> statement-breakpoint
ALTER TABLE "distribution"."channel_account_revision" ADD CONSTRAINT "channel_account_revision_world_fk" FOREIGN KEY ("account_id","is_test") REFERENCES "distribution"."channel_account"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."channel_publication" ADD CONSTRAINT "channel_publication_account_world_fk" FOREIGN KEY ("account_id","is_test") REFERENCES "distribution"."channel_account"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."channel_publication" ADD CONSTRAINT "channel_publication_activation_world_fk" FOREIGN KEY ("activation_id","is_test") REFERENCES "distribution"."activation"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."channel_publication_revision" ADD CONSTRAINT "channel_publication_revision_world_fk" FOREIGN KEY ("publication_id","is_test") REFERENCES "distribution"."channel_publication"("id","is_test") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_publication_calendar" ON "distribution"."channel_publication" USING btree ("is_test","created_at","id");