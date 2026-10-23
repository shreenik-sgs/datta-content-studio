import { reviewerLanguageBlocker } from "@satsang/distribution-domain";
import type { Pool } from "pg";
import { operatorTokenHash } from "./operator-store";

type Query = Pick<Pool, "query">;
export async function studioReviewAssignment(
  pool: Query,
  userId: string,
  isTest: boolean,
  language: string,
) {
  const { rows } = await pool.query(
    "SELECT language FROM distribution.native_reviewer WHERE user_id=$1 AND is_test=$2 ORDER BY language",
    [userId, isTest],
  );
  return {
    sourceLanguage: language,
    blocker: reviewerLanguageBlocker(
      language,
      rows.map((r) => r.language),
    ),
  };
}
export async function listStudioReviewers(pool: Query, isTest: boolean) {
  const { rows } = await pool.query(
    `SELECT o.id,o.display_name AS "displayName",
    coalesce(array_agg(n.language ORDER BY n.language) FILTER(WHERE n.language IS NOT NULL),'{}') AS languages
    FROM distribution.operator o LEFT JOIN distribution.native_reviewer n ON n.user_id=o.id::text AND n.is_test=o.is_test
    WHERE o.is_test=$1 AND o.active AND o.roles ? 'CONTENT_APPROVER' GROUP BY o.id ORDER BY o.display_name,o.id`,
    [isTest],
  );
  return rows as { id: string; displayName: string; languages: string[] }[];
}
export async function saveStudioReviewerLanguages(
  pool: Query,
  input: {
    sessionToken: string;
    operatorId: string;
    isTest: boolean;
    expectedLanguages: string[];
    languages: string[];
  },
) {
  await pool.query("SELECT distribution.set_reviewer_languages($1,$2,$3,$4,$5)", [
    operatorTokenHash(input.sessionToken),
    input.operatorId,
    input.isTest,
    input.expectedLanguages,
    input.languages,
  ]);
}
