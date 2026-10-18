ALTER TABLE "distribution"."online_import" DROP CONSTRAINT "online_import_source_world";--> statement-breakpoint
CREATE UNIQUE INDEX "online_import_source_world" ON "distribution"."online_import" USING btree ("source_key","is_test") WHERE "distribution"."online_import"."deleted_at" IS NULL;--> statement-breakpoint
-- Erasure cannot be undone by a stale request/worker. Metadata remains for audit.
CREATE FUNCTION distribution.guard_erased_content() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc jsonb := to_jsonb(NEW); olddoc jsonb; target uuid;
BEGIN
 IF TG_OP='UPDATE' THEN
   olddoc := to_jsonb(OLD);
   IF olddoc->>'deleted_at' IS NOT NULL THEN RAISE EXCEPTION 'CONTENT_REMOVED'; END IF;
 END IF;
 IF doc->>'deleted_at' IS NOT NULL THEN RETURN NEW; END IF;
 target := NULLIF(doc->>'master_id','')::uuid;
 IF target IS NOT NULL AND EXISTS(SELECT 1 FROM distribution.content_master WHERE id=target AND is_test=NEW.is_test AND deleted_at IS NOT NULL) THEN RAISE EXCEPTION 'CONTENT_REMOVED'; END IF;
 target := NULLIF(doc->>'package_id','')::uuid;
 IF target IS NOT NULL AND EXISTS(SELECT 1 FROM distribution.studio_package WHERE id=target AND is_test=NEW.is_test AND deleted_at IS NOT NULL) THEN RAISE EXCEPTION 'CONTENT_REMOVED'; END IF;
 IF EXISTS (
   SELECT 1 FROM jsonb_path_query(doc,'$.**.storageKey') k
   JOIN distribution.storage_cleanup c ON c.files @> jsonb_build_array(jsonb_build_object('storageKey',k))
 ) THEN RAISE EXCEPTION 'CONTENT_REMOVED'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['content_master','content_version','online_import','studio_package','studio_revision','studio_generation_job','studio_publication_job','render_job','render_artifact','live_window'] LOOP
 EXECUTE format('CREATE TRIGGER guard_erased_content BEFORE INSERT OR UPDATE ON distribution.%I FOR EACH ROW EXECUTE FUNCTION distribution.guard_erased_content()',item);
 END LOOP;
END $$;

--> statement-breakpoint
-- Only lock acquisition is privileged; callers still use their normal row permissions.
CREATE FUNCTION distribution.lock_storage_cleanup() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 LOCK TABLE distribution.content_master,distribution.content_version,distribution.online_import,distribution.studio_package,distribution.studio_revision,distribution.studio_generation_job,distribution.studio_publication_job,distribution.render_job,distribution.render_artifact,distribution.activation,distribution.live_window,distribution.live_broadcast,distribution.storage_cleanup IN SHARE ROW EXCLUSIVE MODE;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION distribution.lock_storage_cleanup() FROM PUBLIC;
