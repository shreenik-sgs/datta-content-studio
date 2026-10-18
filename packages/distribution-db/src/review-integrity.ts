import { requireIndependentContentReview } from "@satsang/distribution-domain";
import type { PoolClient } from "pg";

/** Existing immutable provenance is authoritative; request bodies never identify authors. */
export async function requireIndependentSourceReview(
  client: PoolClient,
  input: {
    isTest: boolean;
    masterId: string;
    versionId: string;
    reviewerId: string;
    reviewerRoles?: readonly string[] | undefined;
  },
): Promise<void> {
  // Replacing bytes does not replace title/language/category. Their latest full metadata
  // write remains a contribution even if it predates the current byte version. Rights
  // are full immutable attestations per byte version, so obsolete attestations need not
  // disqualify somebody who did not author any part of the current review snapshot.
  const rows = await client.query(
    `SELECT created_by AS actor_id FROM distribution.content_version WHERE id=$1 AND master_id=$2 AND is_test=$3
     UNION SELECT actor_id FROM distribution.audit_event WHERE master_id=$2 AND is_test=$3
     AND action IN ('CONTENT_CREATED','METADATA_UPDATED')
     AND revision=(SELECT max(revision) FROM distribution.audit_event WHERE master_id=$2 AND is_test=$3
       AND action IN ('CONTENT_CREATED','METADATA_UPDATED'))
     UNION SELECT attested_by AS actor_id FROM distribution.content_rights WHERE version_id=$1 AND is_test=$3
     AND revision=(SELECT max(revision) FROM distribution.content_rights WHERE version_id=$1 AND is_test=$3)`,
    [input.versionId, input.masterId, input.isTest],
  );
  requireIndependentContentReview(
    input.reviewerId,
    rows.rows.map((row) => row.actor_id),
    input.reviewerRoles,
  );
}

const authoredTables = {
  transcript: "transcript_version",
  quote: "quote_candidate",
  native: "native_analysis",
} as const;
export async function requireIndependentEditorialReview(
  client: PoolClient,
  input: { isTest: boolean; kind: keyof typeof authoredTables; id: string; reviewerId: string },
): Promise<void> {
  const rows = await client.query(
    `SELECT created_by FROM distribution.${authoredTables[input.kind]} WHERE id=$1 AND is_test=$2`,
    [input.id, input.isTest],
  );
  requireIndependentContentReview(
    input.reviewerId,
    rows.rows.map((row) => row.created_by),
  );
}

const histories = {
  campaign: ["outreach_campaign_revision", "campaign_id"],
  cta: ["cta_revision", "cta_id"],
  activation: ["activation_revision", "activation_id"],
} as const;
/** Every author of the inherited package is independent of its reviewer. Test/approval actions are not authoring. */
export async function requireIndependentPackageReview(
  client: PoolClient,
  input: {
    isTest: boolean;
    kind: keyof typeof histories;
    id: string;
    revision: number;
    reviewerId: string;
  },
): Promise<void> {
  const [table, idColumn] = histories[input.kind];
  const rows = await client.query(
    `SELECT DISTINCT actor_id FROM distribution.${table} WHERE ${idColumn}=$1 AND is_test=$2 AND revision<=$3 AND action IN ('CREATED','EDITED')`,
    [input.id, input.isTest, input.revision],
  );
  requireIndependentContentReview(
    input.reviewerId,
    rows.rows.map((row) => row.actor_id),
  );
}
