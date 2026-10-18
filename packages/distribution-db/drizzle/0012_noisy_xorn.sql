CREATE TABLE "distribution"."studio_settings" (
	"is_test" boolean PRIMARY KEY NOT NULL,
	"sealed" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_settings_size" CHECK (octet_length("distribution"."studio_settings"."sealed") <= 65536)
);
