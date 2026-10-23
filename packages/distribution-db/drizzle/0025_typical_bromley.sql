CREATE TABLE "distribution"."reviewer_language_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"is_test" boolean NOT NULL,
	"before_languages" jsonb NOT NULL,
	"after_languages" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "distribution"."native_reviewer" DROP CONSTRAINT "native_reviewer_language";--> statement-breakpoint
ALTER TABLE "distribution"."reviewer_language_audit" ADD CONSTRAINT "reviewer_language_audit_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "distribution"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."reviewer_language_audit" ADD CONSTRAINT "reviewer_language_audit_actor_id_operator_id_fk" FOREIGN KEY ("actor_id") REFERENCES "distribution"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution"."native_reviewer" ADD CONSTRAINT "native_reviewer_language" CHECK ("distribution"."native_reviewer"."language" IN ('en','hi','te','kn','ta','ml','gu','sa'));--> statement-breakpoint
-- Runtime cannot write language grants directly. This narrow function rechecks a real,
-- unexpired Admin session, world and current roles inside the assignment transaction.
CREATE FUNCTION distribution.set_reviewer_languages(session_hash text, target_id uuid, target_world boolean, expected_languages text[], requested_languages text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE actor uuid;
DECLARE before_list text[];
DECLARE after_list text[];
DECLARE expected_list text[];
BEGIN
  SELECT o.id INTO actor FROM distribution.operator_session s
  JOIN distribution.operator o ON o.id=s.operator_id
  WHERE s.token_hash=session_hash AND s.expires_at>clock_timestamp()
    AND o.active AND o.is_test=target_world AND o.roles ? 'SUPER_ADMIN'
  FOR SHARE OF o,s;
  IF actor IS NULL THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  PERFORM 1 FROM distribution.operator o WHERE o.id=target_id AND o.is_test=target_world
    AND o.active AND o.roles ? 'CONTENT_APPROVER' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'REVIEWER_NOT_FOUND'; END IF;
  IF requested_languages IS NULL OR expected_languages IS NULL
     OR cardinality(requested_languages)>8 OR cardinality(expected_languages)>8
     OR EXISTS(SELECT 1 FROM unnest(requested_languages || expected_languages) l
               WHERE l IS NULL OR l NOT IN ('en','hi','te','kn','ta','ml','gu','sa'))
  THEN RAISE EXCEPTION 'INVALID_REVIEWER_LANGUAGES'; END IF;
  SELECT coalesce(array_agg(language ORDER BY language),ARRAY[]::text[]) INTO before_list
    FROM distribution.native_reviewer WHERE user_id=target_id::text AND is_test=target_world;
  SELECT coalesce(array_agg(DISTINCT l ORDER BY l),ARRAY[]::text[]) INTO after_list FROM unnest(requested_languages) l;
  SELECT coalesce(array_agg(DISTINCT l ORDER BY l),ARRAY[]::text[]) INTO expected_list FROM unnest(expected_languages) l;
  IF before_list<>expected_list THEN RAISE EXCEPTION 'REVIEWER_LANGUAGES_CHANGED'; END IF;
  IF before_list=after_list THEN RETURN; END IF;
  DELETE FROM distribution.native_reviewer WHERE user_id=target_id::text AND is_test=target_world AND NOT(language=ANY(after_list));
  INSERT INTO distribution.native_reviewer(user_id,is_test,language,granted_by)
    SELECT target_id::text,target_world,l,actor::text FROM unnest(after_list) l ON CONFLICT DO NOTHING;
  INSERT INTO distribution.reviewer_language_audit(operator_id,actor_id,is_test,before_languages,after_languages)
    VALUES(target_id,actor,target_world,to_jsonb(before_list),to_jsonb(after_list));
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION distribution.set_reviewer_languages(text,uuid,boolean,text[],text[]) FROM PUBLIC;
