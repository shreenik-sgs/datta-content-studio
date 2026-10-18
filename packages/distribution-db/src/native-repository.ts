import { randomUUID } from "node:crypto";
import {
  type NativeAnalysis,
  type NativeReview,
  type TranscriptVersion,
  nativeApprovalDecision,
  validateNativeAnalysis,
} from "@satsang/distribution-domain";
import type { Pool, PoolClient } from "pg";
import { invalidateActivations } from "./activation-invalidation.js";
import type { DistributionRoleAuthority } from "./operator-authority.js";
import {
  type DistributionContext,
  distributionCapabilities,
  distributionWorld,
  requireDistributionCapability,
} from "./repository.js";
import { requireIndependentEditorialReview } from "./review-integrity.js";
async function nativeTranscript(
  client: PoolClient,
  ctx: DistributionContext,
  masterId: string,
  transcriptId: string,
): Promise<TranscriptVersion> {
  const locked = await client.query(
    "SELECT id,state,current_version_number FROM distribution.content_master WHERE id=$1 AND is_test=$2 FOR UPDATE",
    [masterId, distributionWorld(ctx)],
  );
  const master = locked.rows[0];
  if (!master) throw new Error("NOT_FOUND");
  if (master.state !== "APPROVED" && master.state !== "PUBLISHED") throw new Error("NOT_APPROVED");
  const result = await client.query(
    "SELECT t.transcript,v.number,v.sha256,r.revision,r.decision,r.reviewer_id,r.created_at,\n EXISTS(SELECT 1 FROM distribution.transcript_version c WHERE c.parent_version_id=t.id AND c.is_test=t.is_test) AS superseded\n FROM distribution.transcript_version t JOIN distribution.content_version v ON v.id=t.master_version_id AND v.is_test=t.is_test\n LEFT JOIN LATERAL (SELECT * FROM distribution.transcript_review WHERE transcript_version_id=t.id AND is_test=t.is_test ORDER BY revision DESC LIMIT 1) r ON true\n WHERE t.id=$1 AND t.is_test=$2 AND v.master_id=$3",
    [transcriptId, distributionWorld(ctx), masterId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("NOT_FOUND");
  if (
    row.superseded ||
    row.number !== master.current_version_number ||
    row.transcript.sourceSha256 !== row.sha256
  )
    throw new Error("SOURCE_DEPENDENCY_CHANGED");
  return {
    ...row.transcript,
    revision: row.revision ?? 1,
    review: row.decision
      ? {
          decision: row.decision,
          revision: row.revision,
          reviewerId: row.reviewer_id,
          reviewedAt: new Date(row.created_at).toISOString(),
        }
      : null,
  };
}
async function languages(
  client: PoolClient,
  userId: string,
  isTest: boolean,
  reviewAuthorized: boolean,
): Promise<string[]> {
  // A language qualification is never an authority grant. Both fresh Admin authority AND
  // the world-scoped explicit language assignment are required on every call.
  if (!reviewAuthorized) return [];
  const rows = await client.query(
    "SELECT language FROM distribution.native_reviewer WHERE user_id=$1 AND is_test=$2",
    [userId, isTest],
  );
  return rows.rows.map((r) => r.language);
}
/** Called under the existing source lock at enqueue, worker claim/completion, review and export. */
export async function nativeRenderApproval(
  client: PoolClient,
  ctx: DistributionContext,
  masterId: string,
  transcript: TranscriptVersion,
  startMs: number,
  endMs: number,
  authorize?: DistributionRoleAuthority,
) {
  const governed = await client.query(
    "SELECT 1 FROM distribution.native_source WHERE master_id=$1 AND is_test=$2",
    [masterId, distributionWorld(ctx)],
  );
  if (!governed.rowCount) return undefined;
  const rows = await client.query(
    "SELECT id,analysis FROM distribution.native_analysis WHERE master_id=$1 AND is_test=$2 AND transcript_id=$3 ORDER BY sequence DESC LIMIT 100",
    [masterId, distributionWorld(ctx), transcript.id],
  );
  for (const row of rows.rows) {
    const analysis: NativeAnalysis = row.analysis;
    if (
      analysis.transcriptRevision !== transcript.revision ||
      analysis.sourceSha256 !== transcript.sourceSha256
    )
      continue;
    for (const candidate of analysis.candidates.filter(
      (c) => c.startMs === startMs && c.endMs === endMs,
    )) {
      const reviews = await client.query(
        "SELECT review FROM distribution.native_review WHERE analysis_id=$1 AND is_test=$2 AND candidate_id=$3 ORDER BY revision DESC LIMIT 1",
        [row.id, distributionWorld(ctx), candidate.id],
      );
      const review: NativeReview | null = reviews.rows[0]?.review ?? null;
      let allowed: string[] = [];
      if (review) {
        if (!authorize) throw new Error("OPERATOR_AUTHORITY_UNAVAILABLE");
        allowed = await languages(
          client,
          review.reviewerId,
          distributionWorld(ctx),
          await authorize({
            userId: review.reviewerId,
            isTest: ctx.isTest,
            capability: "content.review",
          }),
        );
      }
      if (nativeApprovalDecision(analysis, candidate, review, allowed).allowed) {
        await requireIndependentEditorialReview(client, {
          isTest: ctx.isTest,
          kind: "native",
          id: row.id,
          reviewerId: requiredValue(review).reviewerId,
        });
        return {
          analysisId: row.id as string,
          candidateId: candidate.id,
          reviewRevision: requiredValue(review).revision,
        };
      }
      // A newer proposal supersedes older approvals, including after rejection.
      throw new Error("NATIVE_REVIEW_REQUIRED");
    }
    // Changed boundaries cannot resurrect an older approval for the previous range.
    throw new Error("NATIVE_REVIEW_REQUIRED");
  }
  throw new Error("NATIVE_REVIEW_REQUIRED");
}
export function createNativeIntelligenceRepository(pool: Pool) {
  async function run<T>(
    ctx: DistributionContext,
    capability: "content.create" | "content.review" | null,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await requireDistributionCapability(
        client,
        ctx,
        capability ? [capability] : ["content.create", "content.review", "content.publish"],
      );
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  return {
    governed: (
      ctx: DistributionContext,
      reference: { masterId: string } | { artifactId: string },
    ) =>
      run(ctx, null, async (client) => {
        const query =
          "masterId" in reference
            ? await client.query(
                "SELECT 1 FROM distribution.native_source WHERE master_id=$1 AND is_test=$2",
                [reference.masterId, distributionWorld(ctx)],
              )
            : await client.query(
                "SELECT 1 FROM distribution.native_source n JOIN distribution.render_job j ON j.master_id=n.master_id AND j.is_test=n.is_test JOIN distribution.render_artifact a ON a.job_id=j.id AND a.is_test=j.is_test WHERE a.id=$1 AND a.is_test=$2",
                [reference.artifactId, distributionWorld(ctx)],
              );
        return Boolean(query.rowCount);
      }),
    list: (ctx: DistributionContext, masterId: string) =>
      run(ctx, null, async (client) => {
        const rows = await client.query(
          "SELECT id,analysis,created_at FROM distribution.native_analysis WHERE master_id=$1 AND is_test=$2 ORDER BY sequence DESC LIMIT 30",
          [masterId, distributionWorld(ctx)],
        );
        const reviews = await client.query(
          "SELECT DISTINCT ON (r.analysis_id,r.candidate_id) r.analysis_id,r.candidate_id,r.review FROM distribution.native_review r JOIN distribution.native_analysis a ON a.id=r.analysis_id AND a.is_test=r.is_test WHERE a.master_id=$1 AND a.is_test=$2 ORDER BY r.analysis_id,r.candidate_id,r.revision DESC",
          [masterId, distributionWorld(ctx)],
        );
        return {
          analyses: rows.rows,
          reviews: reviews.rows,
          reviewerLanguages: await languages(
            client,
            ctx.userId,
            distributionWorld(ctx),
            (await distributionCapabilities(client, ctx)).includes("content.review"),
          ),
        };
      }),
    propose: (
      ctx: DistributionContext,
      masterId: string,
      requestId: string,
      analysis: NativeAnalysis,
    ) =>
      run(ctx, "content.create", async (client) => {
        const transcript = await nativeTranscript(
          client,
          ctx,
          masterId,
          analysis.transcriptVersionId,
        );
        validateNativeAnalysis(analysis, transcript);
        const existing = await client.query(
          "SELECT id,master_id,analysis FROM distribution.native_analysis WHERE created_by=$1 AND is_test=$2 AND request_id=$3",
          [ctx.userId, distributionWorld(ctx), requestId],
        );
        if (existing.rows[0]) {
          if (
            existing.rows[0].master_id !== masterId ||
            JSON.stringify(existing.rows[0].analysis) !==
              JSON.stringify(JSON.parse(JSON.stringify(analysis)))
          ) {
            // JSONB key order is not significant; compare in PostgreSQL.
            const equal = await client.query(
              "SELECT analysis=$1::jsonb AS matches FROM distribution.native_analysis WHERE id=$2",
              [JSON.stringify(analysis), existing.rows[0].id],
            );
            if (existing.rows[0].master_id !== masterId || !equal.rows[0]?.matches)
              throw new Error("IDEMPOTENCY_CONFLICT");
          }
          return existing.rows[0].id as string;
        }
        if (analysis.glossaryVersionIds.length) {
          const glossary = await client.query(
            "SELECT id FROM distribution.glossary_version WHERE id=ANY($1::uuid[]) AND is_test=$2",
            [analysis.glossaryVersionIds, distributionWorld(ctx)],
          );
          if (glossary.rowCount !== new Set(analysis.glossaryVersionIds).size)
            throw new Error("NATIVE_SOURCE_MISMATCH");
        }
        const id = randomUUID();
        await client.query(
          "INSERT INTO distribution.native_source(master_id,is_test) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [masterId, distributionWorld(ctx)],
        );
        await client.query(
          "INSERT INTO distribution.native_analysis(id,is_test,master_id,transcript_id,request_id,created_by,analysis) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [id, distributionWorld(ctx), masterId, transcript.id, requestId, ctx.userId, analysis],
        );
        await invalidateActivations(client, {
          masterId,
          isTest: ctx.isTest,
          actorId: ctx.userId,
          reason: "NATIVE_GOVERNANCE_ADDED",
        });
        return id;
      }),
    review: (
      ctx: DistributionContext,
      masterId: string,
      input: {
        analysisId: string;
        candidateId: string;
        requestId: string;
        expectedRevision: number;
        decision: "APPROVED" | "REJECTED";
        reason: string;
        checks: NativeReview["checks"];
      },
    ) =>
      run(ctx, "content.review", async (client) => {
        const rows = await client.query(
          "SELECT analysis FROM distribution.native_analysis WHERE id=$1 AND is_test=$2 AND master_id=$3",
          [input.analysisId, distributionWorld(ctx), masterId],
        );
        const analysis: NativeAnalysis | undefined = rows.rows[0]?.analysis;
        if (!analysis) throw new Error("NOT_FOUND");
        const transcript = await nativeTranscript(
          client,
          ctx,
          masterId,
          analysis.transcriptVersionId,
        );
        validateNativeAnalysis(analysis, transcript);
        const qualified = await languages(
          client,
          ctx.userId,
          distributionWorld(ctx),
          (await distributionCapabilities(client, ctx)).includes("content.review"),
        );
        if (!qualified.includes(analysis.language)) throw new Error("NATIVE_REVIEWER_REQUIRED");
        const candidate = analysis.candidates.find((c) => c.id === input.candidateId);
        if (!candidate) throw new Error("NOT_FOUND");
        await requireIndependentEditorialReview(client, {
          isTest: ctx.isTest,
          kind: "native",
          id: input.analysisId,
          reviewerId: ctx.userId,
        });
        const previous = await client.query(
          "SELECT review,request_id FROM distribution.native_review WHERE analysis_id=$1 AND is_test=$2 AND candidate_id=$3 ORDER BY revision DESC LIMIT 1",
          [input.analysisId, distributionWorld(ctx), input.candidateId],
        );
        const held: NativeReview | undefined = previous.rows[0]?.review;
        const retry = await client.query(
          "SELECT review FROM distribution.native_review WHERE analysis_id=$1 AND is_test=$2 AND candidate_id=$3 AND request_id=$4",
          [input.analysisId, distributionWorld(ctx), input.candidateId, input.requestId],
        );
        if (retry.rows[0]) {
          const held: NativeReview = retry.rows[0].review;
          if (
            held?.reviewerId !== ctx.userId ||
            held?.decision !== input.decision ||
            held?.reason !== input.reason ||
            held?.checks.length !== input.checks.length ||
            held?.checks.some(
              (c, i) =>
                c.check !== input.checks[i]?.check || c.evidence !== input.checks[i]?.evidence,
            )
          )
            throw new Error("IDEMPOTENCY_CONFLICT");
          return held;
        }
        if ((held?.revision ?? 0) !== input.expectedRevision) throw new Error("REVISION_CONFLICT");
        const review: NativeReview = {
          decision: input.decision,
          reason: input.reason,
          checks: input.checks,
          reviewerId: ctx.userId,
          language: analysis.language,
          reviewedAt: new Date().toISOString(),
          revision: input.expectedRevision + 1,
        };
        if (input.decision === "APPROVED") {
          const result = nativeApprovalDecision(analysis, candidate, review, qualified);
          if (!result.allowed) throw new Error(result.reason);
        }
        await client.query(
          "INSERT INTO distribution.native_review(analysis_id,is_test,candidate_id,revision,request_id,review) VALUES($1,$2,$3,$4,$5,$6)",
          [
            input.analysisId,
            distributionWorld(ctx),
            input.candidateId,
            review.revision,
            input.requestId,
            review,
          ],
        );
        await invalidateActivations(client, {
          masterId,
          isTest: ctx.isTest,
          actorId: ctx.userId,
          reason: "NATIVE_REVIEW_CHANGED",
        });
        return review;
      }),
  };
}

function requiredValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("REQUIRED_VALUE_MISSING");
  return value;
}
