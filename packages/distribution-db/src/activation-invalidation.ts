import type {
  ActivationReviewPackage,
  ChannelActivation,
  CtaDefinition,
  OutreachCampaign,
  TrackedLinkRecord,
} from "@satsang/distribution-domain";
import { stopChannelActivation } from "@satsang/distribution-domain";
import type { PoolClient } from "pg";
export type PersistedActivation = ChannelActivation & {
  masterId: string;
  sourceRevision: number;
  title: string;
  language: string;
  recipeSha256: string;
  assetSha256: string;
  token: string;
  pinnedCampaign: OutreachCampaign;
  pinnedCta: CtaDefinition;
  linkBinding: TrackedLinkRecord | null;
  invalidatedReason: string | null;
  reviewPackage?: ActivationReviewPackage;
  approvalPackageSha256?: string;
  supersedesActivationId?: string;
};
export async function readActivation(
  client: PoolClient,
  isTest: boolean,
  id: string,
): Promise<PersistedActivation> {
  const r = await client.query(
    "SELECT snapshot FROM distribution.activation_revision WHERE activation_id=$1 AND is_test=$2 ORDER BY revision DESC LIMIT 1",
    [id, isTest],
  );
  if (!r.rows[0]) throw new Error("NOT_FOUND");
  return r.rows[0].snapshot;
}
export async function appendActivation(
  client: PoolClient,
  isTest: boolean,
  value: PersistedActivation,
  actorId: string,
  action: string,
) {
  await client.query(
    "INSERT INTO distribution.activation_revision(activation_id,is_test,revision,snapshot,actor_id,action) VALUES($1,$2,$3,$4,$5,$6)",
    [value.id, isTest, value.revision, value, actorId, action],
  );
  return value;
}
/** Caller holds activation row lock; its sequence is monotonic across outbox retries and restarts. */
export async function enqueueLink(
  client: PoolClient,
  isTest: boolean,
  id: string,
  record: TrackedLinkRecord,
) {
  const rows = await client.query(
    "UPDATE distribution.activation SET sequence=sequence+1 WHERE id=$1 AND is_test=$2 RETURNING sequence",
    [id, isTest],
  );
  if (!rows.rows[0]) throw new Error("NOT_FOUND");
  const next = { ...record, sequence: rows.rows[0].sequence } as TrackedLinkRecord;
  await client.query(
    "INSERT INTO distribution.link_outbox(activation_id,is_test,sequence,record) VALUES($1,$2,$3,$4)",
    [id, isTest, next.sequence, next],
  );
  return next;
}
/** Dependency mutations already hold source/campaign/CTA lock. Acquire activation locks last, ordered. */
export async function invalidateActivations(
  client: PoolClient,
  input: {
    isTest: boolean;
    actorId: string;
    reason: string;
    masterId?: string;
    campaignId?: string;
    ctaId?: string;
    artifactId?: string;
  },
) {
  const pair = input.masterId
    ? ["master_id", input.masterId]
    : input.campaignId
      ? ["campaign_id", input.campaignId]
      : input.ctaId
        ? ["cta_id", input.ctaId]
        : input.artifactId
          ? ["artifact_id", input.artifactId]
          : null;
  if (!pair) throw new Error("INVALID_ACTIVATION_SCOPE");
  const rows = await client.query(
    `SELECT id FROM distribution.activation WHERE ${pair[0]}=$1 AND is_test=$2 ORDER BY id FOR UPDATE`,
    [pair[1], input.isTest],
  );
  for (const row of rows.rows) {
    const before = await readActivation(client, input.isTest, row.id);
    if (before.status === "STOPPED") continue;
    const next = {
      ...before,
      ...stopChannelActivation(before, before.revision),
      invalidatedReason: input.reason,
    };
    await appendActivation(client, input.isTest, next, input.actorId, "INVALIDATED");
    if (before.linkBinding)
      await enqueueLink(client, input.isTest, before.id, {
        ...before.linkBinding,
        status: "STALE",
        destinationAvailable: false,
      });
  }
}
