import type {
  ContentMaster,
  StudioTranscript,
  TranscriptVersion,
} from "@satsang/distribution-domain";
import type { PoolClient } from "pg";
import type { PrivateAsset } from "./repository.js";
import { requireIndependentEditorialReview } from "./review-integrity.js";
const iso = (value: Date | string) => new Date(value).toISOString();
export async function loadStudioSource(
  client: PoolClient,
  isTest: boolean,
  masterId: string,
  lock = false,
) {
  if (lock)
    await client.query(
      "SELECT id FROM distribution.content_master WHERE id=$1 AND is_test=$2 FOR UPDATE",
      [masterId, isTest],
    );
  const rows = await client.query(
    `SELECT m.*,v.id AS version_id,v.number AS version_number,v.sha256,v.byte_size,v.mime_type,v.original_name,v.storage_key,v.created_at AS version_created_at,v.created_by AS version_created_by,
    (SELECT rights FROM distribution.content_rights WHERE version_id=v.id AND is_test=m.is_test ORDER BY revision DESC LIMIT 1) AS rights,
    (SELECT jsonb_build_object('versionId',version_id,'approvedRevision',approved_revision,'reviewerId',reviewer_id,'approvedAt',created_at) FROM distribution.approval_decision WHERE version_id=v.id AND is_test=m.is_test AND approved_revision=m.revision LIMIT 1) AS approval
    FROM distribution.content_master m JOIN distribution.content_version v ON v.master_id=m.id AND v.is_test=m.is_test AND v.number=m.current_version_number WHERE m.id=$1 AND m.is_test=$2 AND m.deleted_at IS NULL`,
    [masterId, isTest],
  );
  const row = rows.rows[0];
  if (!row) throw new Error("NOT_FOUND");
  const master: ContentMaster = {
    id: row.id,
    title: row.title,
    language: row.language,
    category: row.category,
    state: row.state,
    isTest: row.is_test,
    revision: row.revision,
    currentVersion: {
      id: row.version_id,
      masterId: row.id,
      number: row.version_number,
      sha256: row.sha256,
      byteSize: Number(row.byte_size),
      mimeType: row.mime_type,
      originalName: row.original_name,
      createdAt: iso(row.version_created_at),
      createdBy: row.version_created_by,
    },
    rights: row.rights,
    approval: row.approval ? { ...row.approval, approvedAt: iso(row.approval.approvedAt) } : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
  const source: PrivateAsset & { versionId: string; masterId: string } = {
    versionId: row.version_id,
    masterId: row.id,
    storageKey: row.storage_key,
    sha256: row.sha256,
    byteSize: Number(row.byte_size),
    mimeType: row.mime_type,
    originalName: row.original_name,
  };
  return { master, source };
}
export async function currentStudioTranscript(
  client: PoolClient,
  isTest: boolean,
  versionId: string,
): Promise<StudioTranscript | null> {
  const rows = await client.query(
    "SELECT t.*,r.decision,r.reviewer_id FROM distribution.transcript_version t LEFT JOIN LATERAL (SELECT decision,reviewer_id FROM distribution.transcript_review WHERE transcript_version_id=t.id AND is_test=t.is_test ORDER BY revision DESC LIMIT 1) r ON true WHERE t.master_version_id=$1 AND t.is_test=$2 ORDER BY t.number DESC LIMIT 1",
    [versionId, isTest],
  );
  const row = rows.rows[0];
  if (!row || row.decision !== "APPROVED") return null;
  await requireIndependentEditorialReview(client, {
    isTest,
    kind: "transcript",
    id: row.id,
    reviewerId: row.reviewer_id,
  });
  const transcript = row.transcript as TranscriptVersion;
  return {
    language: transcript.language,
    durationMs: transcript.durationMs,
    segments: transcript.segments.map((segment) => ({
      id: segment.id,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.displayText,
    })),
    provenance: "APPROVED_TRANSCRIPT",
    sourceTranscriptId: row.id,
  };
}
