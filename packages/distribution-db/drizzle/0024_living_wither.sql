ALTER TABLE "distribution"."studio_publication_job" ADD COLUMN "destination_key" text;--> statement-breakpoint
ALTER TABLE "distribution"."studio_publication_job" ADD COLUMN "duplicate_check" jsonb;--> statement-breakpoint
CREATE INDEX "studio_publication_destination" ON "distribution"."studio_publication_job" USING btree ("is_test","destination_key","status");