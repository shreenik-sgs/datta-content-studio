CREATE TABLE "distribution"."online_import_service" (
	"provider" text NOT NULL,
	"is_test" boolean NOT NULL,
	"error" text NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"retry_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "online_import_service_provider_is_test_pk" PRIMARY KEY("provider","is_test"),
	CONSTRAINT "online_import_service_provider" CHECK ("distribution"."online_import_service"."provider" IN ('youtube','facebook')),
	CONSTRAINT "online_import_service_attempts" CHECK ("distribution"."online_import_service"."attempts" > 0),
	CONSTRAINT "online_import_service_error" CHECK ("distribution"."online_import_service"."error" IN ('ONLINE_PROVIDER_VERIFICATION_REQUIRED','ONLINE_PROVIDER_RATE_LIMITED'))
);
