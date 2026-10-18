CREATE TABLE "distribution"."login_attempt" (
	"key" text PRIMARY KEY NOT NULL,
	"attempts" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "distribution"."operator" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"roles" jsonb NOT NULL,
	"is_test" boolean NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	CONSTRAINT "operator_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "distribution"."operator_session" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "distribution"."operator_session" ADD CONSTRAINT "operator_session_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "distribution"."operator"("id") ON DELETE no action ON UPDATE no action;