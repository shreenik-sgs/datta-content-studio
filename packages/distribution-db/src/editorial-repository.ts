import { randomUUID } from "node:crypto";
import {
  type EditorialProvenance,
  type EditorialReview,
  type GlossaryEntry,
  type QuoteCandidate,
  type TranscriptSegment,
  type TranscriptVersion,
  reviewQuote as decideQuoteReview,
  reviewTranscript as decideTranscriptReview,
  quoteReviewDecision,
  requireContentRevision,
  reviseTranscript,
  sourceContextWindow,
  validateTranscript,
} from "@satsang/distribution-domain";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { invalidateActivations } from "./activation-invalidation.js";
import {
  type DistributionContext,
  distributionWorld,
  requireDistributionCapability,
} from "./repository.js";
import { requireIndependentEditorialReview } from "./review-integrity.js";

export type NewTranscript = {
  expectedSourceVersionId: string;
  language: string;
  durationMs: number;
  segments: TranscriptSegment[];
  provenance: EditorialProvenance;
};
export type NewQuoteCandidate = {
  transcriptVersionId: string;
  transcriptRevision: number;
  kind: QuoteCandidate["kind"];
  segmentIds: string[];
  startMs: number;
  endMs: number;
  text: string;
  provenance: EditorialProvenance;
};
export type GlossaryInput = { term: string; preferred: string; language: string };
const languages = ["en", "hi", "te", "kn", "ta", "ml", "gu", "sa"];
export function validateGlossaryInput(input: GlossaryInput): void {
  if (
    !input.term.trim() ||
    input.term.length > 200 ||
    !input.preferred.trim() ||
    input.preferred.length > 200 ||
    !languages.includes(input.language)
  )
    throw new Error("INVALID_GLOSSARY_ENTRY");
}
function reviewFrom(row: QueryResultRow): EditorialReview | null {
  return row.review_decision
    ? {
        decision: row.review_decision,
        reviewerId: row.reviewer_id,
        reviewedAt: new Date(row.reviewed_at).toISOString(),
        revision: row.review_revision,
      }
    : null;
}
function transcriptFrom(row: QueryResultRow): TranscriptVersion {
  const review = reviewFrom(row);
  return { ...row.transcript, revision: review?.revision ?? 1, review };
}
function quoteFrom(row: QueryResultRow): QuoteCandidate {
  const review = reviewFrom(row);
  return { ...row.candidate, revision: review?.revision ?? 1, review };
}
const transcriptSelect = `SELECT t.*, r.decision AS review_decision, r.reviewer_id, r.created_at AS reviewed_at, r.revision AS review_revision
 FROM distribution.transcript_version t LEFT JOIN LATERAL
 (SELECT * FROM distribution.transcript_review WHERE transcript_version_id=t.id AND is_test=t.is_test ORDER BY revision DESC LIMIT 1) r ON true`;
const quoteSelect = `SELECT q.*, r.decision AS review_decision, r.reviewer_id, r.created_at AS reviewed_at, r.revision AS review_revision
 FROM distribution.quote_candidate q LEFT JOIN LATERAL
 (SELECT * FROM distribution.quote_review WHERE quote_id=q.id AND is_test=q.is_test ORDER BY revision DESC LIMIT 1) r ON true`;

/** Immutable editorial snapshots and append-only human decisions, isolated from core storage. */
export function createDistributionEditorialRepository(pool: Pool) {
  async function run<T>(
    ctx: DistributionContext,
    capability: "content.create" | "content.review" | null,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    distributionWorld(ctx);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await requireDistributionCapability(
        client,
        ctx,
        capability ? [capability] : ["content.create", "content.review", "content.publish"],
      );
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async function source(
    client: PoolClient,
    ctx: DistributionContext,
    masterVersionId: string,
    lock: boolean,
  ) {
    // The same master lock used by R1 serializes editorial writes with version replacement/withdrawal.
    const result = await client.query(
      `SELECT v.id,v.master_id,v.sha256,m.state,m.current_version_number,v.number FROM distribution.content_version v JOIN distribution.content_master m ON m.id=v.master_id AND m.is_test=v.is_test WHERE v.id=$1 AND v.is_test=$2 ${lock ? "FOR UPDATE OF m" : ""}`,
      [masterVersionId, distributionWorld(ctx)],
    );
    const row = result.rows[0];
    if (!row) throw new Error("NOT_FOUND");
    if (lock && row.state === "WITHDRAWN") throw new Error("CONTENT_WITHDRAWN");
    if (lock && row.current_version_number !== row.number) throw new Error("SOURCE_VERSION_STALE");
    return row;
  }
  async function transcript(
    client: PoolClient,
    ctx: DistributionContext,
    id: string,
    mutable = false,
  ): Promise<TranscriptVersion> {
    const result = await client.query(`${transcriptSelect} WHERE t.id=$1 AND t.is_test=$2`, [
      id,
      distributionWorld(ctx),
    ]);
    if (!result.rows[0]) throw new Error("NOT_FOUND");
    let value = transcriptFrom(result.rows[0]);
    if (mutable) {
      const currentSource = await source(client, ctx, value.masterVersionId, true);
      // Refetch after taking the source lock to observe a review that committed while waiting.
      const current = await client.query(`${transcriptSelect} WHERE t.id=$1 AND t.is_test=$2`, [
        id,
        distributionWorld(ctx),
      ]);
      value = transcriptFrom(current.rows[0] as QueryResultRow);
      if (value.sourceSha256 !== currentSource.sha256) throw new Error("SOURCE_MISMATCH");
      const child = await client.query(
        "SELECT id FROM distribution.transcript_version WHERE parent_version_id=$1 AND is_test=$2",
        [id, distributionWorld(ctx)],
      );
      if (child.rowCount) throw new Error("TRANSCRIPT_SUPERSEDED");
    }
    return value;
  }
  async function insertTranscript(
    client: PoolClient,
    ctx: DistributionContext,
    value: TranscriptVersion,
  ) {
    validateTranscript(value);
    await client.query(
      "INSERT INTO distribution.transcript_version(id,is_test,master_version_id,parent_version_id,language,number,transcript,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        value.id,
        distributionWorld(ctx),
        value.masterVersionId,
        value.parentVersionId,
        value.language,
        value.number,
        value,
        ctx.userId,
      ],
    );
    return value;
  }
  async function quote(
    client: PoolClient,
    ctx: DistributionContext,
    id: string,
  ): Promise<QuoteCandidate> {
    const result = await client.query(`${quoteSelect} WHERE q.id=$1 AND q.is_test=$2`, [
      id,
      distributionWorld(ctx),
    ]);
    if (!result.rows[0]) throw new Error("NOT_FOUND");
    return quoteFrom(result.rows[0]);
  }
  async function writeGlossary(
    client: PoolClient,
    ctx: DistributionContext,
    input: GlossaryInput,
    parentVersionId: string | null,
  ): Promise<GlossaryEntry> {
    validateGlossaryInput(input);
    const id = randomUUID();
    await client.query(
      "INSERT INTO distribution.glossary_version(id,is_test,parent_version_id,term,preferred,language,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [
        id,
        distributionWorld(ctx),
        parentVersionId,
        input.term.trim(),
        input.preferred.trim(),
        input.language,
        ctx.userId,
      ],
    );
    return {
      id,
      term: input.term.trim(),
      preferred: input.preferred.trim(),
      language: input.language,
    };
  }
  async function invalidateSource(
    client: PoolClient,
    ctx: DistributionContext,
    versionId: string,
    reason: string,
  ) {
    const rows = await client.query(
      "SELECT master_id FROM distribution.content_version WHERE id=$1 AND is_test=$2",
      [versionId, distributionWorld(ctx)],
    );
    if (rows.rows[0])
      await invalidateActivations(client, {
        isTest: ctx.isTest,
        actorId: ctx.userId,
        masterId: rows.rows[0].master_id,
        reason,
      });
  }
  return {
    listTranscripts: (ctx: DistributionContext, masterId: string) =>
      run(ctx, null, async (client) => {
        const result = await client.query(
          `${transcriptSelect} JOIN distribution.content_version v ON v.id=t.master_version_id AND v.is_test=t.is_test WHERE v.master_id=$1 AND t.is_test=$2 ORDER BY t.created_at DESC,t.id LIMIT 100`,
          [masterId, distributionWorld(ctx)],
        );
        return result.rows.map(transcriptFrom);
      }),
    getTranscript: (ctx: DistributionContext, id: string) =>
      run(ctx, null, (client) => transcript(client, ctx, id)),
    createTranscript: (ctx: DistributionContext, masterId: string, input: NewTranscript) =>
      run(ctx, "content.create", async (client) => {
        if (!languages.includes(input.language)) throw new Error("INVALID_TRANSCRIPT");
        const currentSource = await source(client, ctx, input.expectedSourceVersionId, true);
        if (currentSource.master_id !== masterId) throw new Error("SOURCE_MISMATCH");
        const existing = await client.query(
          "SELECT id FROM distribution.transcript_version WHERE master_version_id=$1 AND is_test=$2 AND language=$3 LIMIT 1",
          [input.expectedSourceVersionId, distributionWorld(ctx), input.language],
        );
        if (existing.rowCount) throw new Error("TRANSCRIPT_ALREADY_EXISTS");
        const value: TranscriptVersion = {
          id: randomUUID(),
          parentVersionId: null,
          number: 1,
          masterVersionId: input.expectedSourceVersionId,
          sourceSha256: currentSource.sha256,
          language: input.language,
          durationMs: input.durationMs,
          segments: input.segments,
          provenance: input.provenance,
          revision: 1,
          review: null,
        };
        return insertTranscript(client, ctx, value);
      }),
    correctTranscript: (
      ctx: DistributionContext,
      id: string,
      input: {
        expectedRevision: number;
        corrections: { segmentId: string; displayText: string }[];
      },
    ) =>
      run(ctx, "content.create", async (client) => {
        const current = await transcript(client, ctx, id, true);
        const revised = reviseTranscript({
          transcript: current,
          expectedRevision: input.expectedRevision,
          newId: randomUUID(),
          corrections: input.corrections,
        });
        const result = await insertTranscript(client, ctx, revised);
        await invalidateSource(client, ctx, current.masterVersionId, "TRANSCRIPT_CORRECTED");
        return result;
      }),
    reviewTranscript: (
      ctx: DistributionContext,
      id: string,
      input: { expectedRevision: number; decision: EditorialReview["decision"] },
    ) =>
      run(ctx, "content.review", async (client) => {
        const current = await transcript(client, ctx, id, true);
        requireContentRevision(current.revision, input.expectedRevision);
        await requireIndependentEditorialReview(client, {
          isTest: ctx.isTest,
          kind: "transcript",
          id,
          reviewerId: ctx.userId,
        });
        const reviewedAt = new Date().toISOString();
        const reviewed = decideTranscriptReview({
          transcript: current,
          ...input,
          reviewerId: ctx.userId,
          reviewedAt,
        });
        await client.query(
          "INSERT INTO distribution.transcript_review(transcript_version_id,is_test,revision,decision,reviewer_id,created_at) VALUES ($1,$2,$3,$4,$5,$6)",
          [id, distributionWorld(ctx), reviewed.revision, input.decision, ctx.userId, reviewedAt],
        );
        await invalidateSource(client, ctx, current.masterVersionId, "EDITORIAL_REVIEW_CHANGED");
        return reviewed;
      }),
    listQuotes: (ctx: DistributionContext, masterId: string) =>
      run(ctx, null, async (client) => {
        const result = await client.query(
          `${quoteSelect} JOIN distribution.content_version v ON v.id=q.master_version_id AND v.is_test=q.is_test WHERE v.master_id=$1 AND q.is_test=$2 ORDER BY q.created_at DESC,q.id LIMIT 100`,
          [masterId, distributionWorld(ctx)],
        );
        return result.rows.map(quoteFrom);
      }),
    getQuote: (ctx: DistributionContext, id: string) =>
      run(ctx, null, (client) => quote(client, ctx, id)),
    createQuote: (ctx: DistributionContext, input: NewQuoteCandidate) =>
      run(ctx, "content.create", async (client) => {
        const current = await transcript(client, ctx, input.transcriptVersionId, true);
        requireContentRevision(current.revision, input.transcriptRevision);
        sourceContextWindow({
          startMs: input.startMs,
          endMs: input.endMs,
          durationMs: current.durationMs,
          contextMs: 0,
        });
        if (
          !input.text.trim() ||
          input.text.length > 20000 ||
          !["EXACT_QUOTE", "SUMMARY"].includes(input.kind) ||
          input.segmentIds.length < 1 ||
          input.segmentIds.length > 1000 ||
          new Set(input.segmentIds).size !== input.segmentIds.length ||
          input.segmentIds.some((id) => !current.segments.some((segment) => segment.id === id))
        )
          throw new Error("INVALID_QUOTE_CANDIDATE");
        // Reuse transcript provenance validation rather than accepting a second weaker provenance shape.
        validateTranscript({ ...current, provenance: input.provenance });
        const candidate: QuoteCandidate = {
          id: randomUUID(),
          kind: input.kind,
          masterVersionId: current.masterVersionId,
          sourceSha256: current.sourceSha256,
          transcriptVersionId: current.id,
          transcriptRevision: current.revision,
          segmentIds: input.segmentIds,
          startMs: input.startMs,
          endMs: input.endMs,
          text: input.text.trim(),
          revision: 1,
          review: null,
          provenance: input.provenance,
        };
        if (candidate.kind === "EXACT_QUOTE") {
          const valid = quoteReviewDecision({ quote: candidate, transcript: current });
          if (!valid.allowed) throw new Error(valid.reason);
        }
        await client.query(
          "INSERT INTO distribution.quote_candidate(id,is_test,master_version_id,transcript_version_id,candidate,created_by) VALUES ($1,$2,$3,$4,$5,$6)",
          [
            candidate.id,
            distributionWorld(ctx),
            current.masterVersionId,
            current.id,
            candidate,
            ctx.userId,
          ],
        );
        return candidate;
      }),
    reviewQuote: (
      ctx: DistributionContext,
      id: string,
      input: { expectedRevision: number; decision: EditorialReview["decision"] },
    ) =>
      run(ctx, "content.review", async (client) => {
        let current = await quote(client, ctx, id);
        const currentTranscript = await transcript(client, ctx, current.transcriptVersionId, true);
        current = await quote(client, ctx, id);
        requireContentRevision(current.revision, input.expectedRevision);
        await requireIndependentEditorialReview(client, {
          isTest: ctx.isTest,
          kind: "quote",
          id,
          reviewerId: ctx.userId,
        });
        const reviewedAt = new Date().toISOString();
        const reviewed = decideQuoteReview({
          quote: current,
          transcript: currentTranscript,
          ...input,
          reviewerId: ctx.userId,
          reviewedAt,
        });
        await client.query(
          "INSERT INTO distribution.quote_review(quote_id,is_test,revision,decision,reviewer_id,created_at) VALUES ($1,$2,$3,$4,$5,$6)",
          [id, distributionWorld(ctx), reviewed.revision, input.decision, ctx.userId, reviewedAt],
        );
        await invalidateSource(client, ctx, current.masterVersionId, "EDITORIAL_REVIEW_CHANGED");
        return reviewed;
      }),
    listGlossary: (ctx: DistributionContext, language: string) =>
      run(ctx, null, async (client): Promise<GlossaryEntry[]> => {
        if (!languages.includes(language)) throw new Error("INVALID_LANGUAGE");
        const result = await client.query(
          "SELECT g.id,g.term,g.preferred,g.language FROM distribution.glossary_version g WHERE g.is_test=$1 AND g.language=$2 AND NOT EXISTS (SELECT 1 FROM distribution.glossary_version child WHERE child.parent_version_id=g.id AND child.is_test=g.is_test) ORDER BY g.term,g.id LIMIT 1000",
          [distributionWorld(ctx), language],
        );
        return result.rows as GlossaryEntry[];
      }),
    addGlossary: (ctx: DistributionContext, input: GlossaryInput) =>
      run(ctx, "content.review", (client) => writeGlossary(client, ctx, input, null)),
    reviseGlossary: (ctx: DistributionContext, id: string, input: GlossaryInput) =>
      run(ctx, "content.review", async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `distribution:glossary:${distributionWorld(ctx)}:${id}`,
        ]);
        const current = await client.query(
          "SELECT id FROM distribution.glossary_version WHERE id=$1 AND is_test=$2",
          [id, distributionWorld(ctx)],
        );
        if (!current.rowCount) throw new Error("NOT_FOUND");
        const child = await client.query(
          "SELECT id FROM distribution.glossary_version WHERE parent_version_id=$1 AND is_test=$2",
          [id, distributionWorld(ctx)],
        );
        if (child.rowCount) throw new Error("GLOSSARY_SUPERSEDED");
        return writeGlossary(client, ctx, input, id);
      }),
  };
}
export type DistributionEditorialRepository = ReturnType<
  typeof createDistributionEditorialRepository
>;
