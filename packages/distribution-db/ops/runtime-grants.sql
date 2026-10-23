-- Apply as the Distribution migration owner after its migrations, never at boot.
-- Role creation and credentials belong to infrastructure, not the runtime.
-- The role receives no core schema privileges and no rights to alter this schema.
SELECT set_config('distribution.runtime_role', :'distribution_runtime_role', false);
DO $$
DECLARE runtime_role text := current_setting('distribution.runtime_role');
DECLARE item text;
BEGIN
  EXECUTE format('REVOKE CREATE ON SCHEMA distribution FROM %I', runtime_role);
  EXECUTE format('GRANT USAGE ON SCHEMA distribution TO %I', runtime_role);
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA distribution FROM %I', runtime_role);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA distribution REVOKE ALL ON TABLES FROM %I', runtime_role);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE ON distribution.module_state TO %I', runtime_role);
  IF to_regclass('distribution.content_master') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON distribution.content_master TO %I', runtime_role);
  END IF;
  FOREACH item IN ARRAY ARRAY['content_version','content_rights','approval_decision','audit_event','transcript_version','transcript_review','quote_candidate','quote_review','glossary_version','render_artifact','render_artifact_review','outreach_campaign','outreach_campaign_revision','cta_definition','cta_revision','activation','activation_revision','link_outbox','native_source','native_analysis','native_review','analytics_policy','analytics_receipt','analytics_event','aggregate_snapshot','provider_metric_snapshot','channel_account','channel_account_revision','channel_publication','channel_publication_revision'] LOOP
    IF to_regclass('distribution.' || item) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT,INSERT ON distribution.%I TO %I', item, runtime_role);
    END IF;
  END LOOP;
  IF to_regclass('distribution.render_job') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT,INSERT ON distribution.render_job TO %I', runtime_role);
    EXECUTE format('GRANT UPDATE(status,attempts,available_at,lease_token,lease_owner,lease_until,last_error,updated_at) ON distribution.render_job TO %I', runtime_role);
  END IF;
  IF to_regclass('distribution.activation') IS NOT NULL THEN
    EXECUTE format('GRANT UPDATE(sequence) ON distribution.activation TO %I', runtime_role);
    EXECUTE format('GRANT UPDATE(delivered_at) ON distribution.link_outbox TO %I', runtime_role);
  END IF;
  IF to_regclass('distribution.native_reviewer') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT ON distribution.native_reviewer TO %I', runtime_role);
  END IF;
  IF to_regclass('distribution.reviewer_language_audit') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT ON distribution.reviewer_language_audit TO %I', runtime_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION distribution.set_reviewer_languages(text,uuid,boolean,text[],text[]) TO %I', runtime_role);
  END IF;
  IF to_regclass('distribution.operator') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT ON distribution.operator TO %I', runtime_role);
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON distribution.operator_session,distribution.login_attempt TO %I', runtime_role);
  END IF;
  IF to_regclass('distribution.capability_grant') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT ON distribution.capability_grant TO %I', runtime_role);
  END IF;
  IF to_regclass('distribution.online_import') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON distribution.online_import TO %I', runtime_role);
  END IF;
  IF to_regclass('distribution.online_import_service') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON distribution.online_import_service TO %I', runtime_role);
  END IF;
  IF to_regclass('distribution.live_monitor') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON distribution.live_monitor,distribution.live_broadcast,distribution.live_window TO %I', runtime_role);
  END IF;
  IF to_regclass('distribution.storage_cleanup') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON distribution.storage_cleanup TO %I', runtime_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION distribution.lock_storage_cleanup() TO %I', runtime_role);
  END IF;
  IF to_regclass('distribution.studio_settings') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT,INSERT,UPDATE ON distribution.studio_settings TO %I', runtime_role);
  END IF;
  IF to_regclass('distribution.studio_package') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT,INSERT ON distribution.studio_package,distribution.studio_revision,distribution.studio_feedback,distribution.studio_generation_job,distribution.studio_publication_job,distribution.studio_publication_attempt TO %I', runtime_role);
    EXECUTE format('GRANT UPDATE(revision,updated_at,generation_checkpoint,deleted_at) ON distribution.studio_package TO %I', runtime_role);
    EXECUTE format('GRANT UPDATE(status,attempts,available_at,lease_token,lease_owner,lease_until,last_error,progress,updated_at) ON distribution.studio_generation_job TO %I', runtime_role);
    EXECUTE format('GRANT UPDATE(status,attempts,available_at,lease_token,lease_owner,lease_until,last_error,account_id,remote_id,remote_url,checkpoint,destination_key,duplicate_check,updated_at) ON distribution.studio_publication_job TO %I', runtime_role);
  END IF;
END $$;
