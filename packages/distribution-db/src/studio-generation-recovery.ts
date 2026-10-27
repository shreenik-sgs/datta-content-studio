import {
  STUDIO_RECOVERABLE_GENERATION_FAILURES,
  type StudioGenerationRecoveryRecord,
  type StudioPackage,
  studioGenerationRecovery,
  studioGenerationRecoveryDeferred,
  studioGenerationRecoveryRequest,
} from "@satsang/distribution-domain";
import type { PoolClient } from "pg";
import type { DistributionContext } from "./repository";
import { STUDIO_QUEUE_FENCE } from "./studio-queue-fence.js";

type Dependencies = {
  transaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
  fresh: (id: string, isTest: boolean, capability: "content.create") => Promise<boolean>;
  load: (client: PoolClient, isTest: boolean, id: string, lock?: boolean) => Promise<StudioPackage>;
  requestGeneration: (
    client: PoolClient,
    ctx: DistributionContext,
    id: string,
    input: ReturnType<typeof studioGenerationRecoveryRequest>,
  ) => Promise<StudioPackage>;
};

export type StudioGenerationRecoveryResult = {
  packageId: string;
  failure: string;
  outcome: "requeued" | "declined";
  code?: string;
};

const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,99}$/;

/** A newer worker retries, once per media pipeline, the recordings an older pipeline's
 * rendering or final media gate failed. The retry is the same checked request a curator
 * would make, under the original requester's current authority, resuming saved work. */
export function createStudioGenerationRecovery(deps: Dependencies) {
  const stamp = async (
    client: PoolClient,
    jobId: string,
    isTest: boolean,
    recovery: StudioGenerationRecoveryRecord,
  ) => {
    await client.query(
      "UPDATE distribution.studio_generation_job SET progress=coalesce(progress,'{}'::jsonb)||jsonb_build_object('recovery',$3::jsonb),updated_at=clock_timestamp() WHERE id=$1 AND is_test=$2",
      [jobId, isTest, JSON.stringify(recovery)],
    );
  };
  return {
    recoverFailedGenerations: (input: { isTest: boolean; mediaPipeline: string }) =>
      deps.transaction(async (client): Promise<StudioGenerationRecoveryResult[]> => {
        const results: StudioGenerationRecoveryResult[] = [];
        // Share the series queue fence so a recovery never slips between a series
        // step's idle check and its dispatch.
        if (
          !(
            await client.query(
              "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked",
              [STUDIO_QUEUE_FENCE],
            )
          ).rows[0]?.locked
        )
          return results;
        // The latest job of each package decides; an older failure that a curator has
        // already retried is not a candidate.
        const candidates = await client.query(
          `SELECT p.id, j.id AS job_id, j.requested_by, j.last_error, j.progress
           FROM distribution.studio_package p
           JOIN LATERAL (
             SELECT * FROM distribution.studio_generation_job j
             WHERE j.package_id=p.id AND j.is_test=p.is_test
             ORDER BY j.created_at DESC, j.id DESC LIMIT 1
           ) j ON TRUE
           WHERE p.is_test=$1 AND p.deleted_at IS NULL AND j.status='FAILED'
             AND j.last_error=ANY($2::text[])
             AND (j.progress->>'mediaPipeline') IS DISTINCT FROM $3
             AND (j.progress->'recovery'->>'mediaPipeline') IS DISTINCT FROM $3
           ORDER BY j.updated_at, j.id LIMIT 20`,
          [input.isTest, [...STUDIO_RECOVERABLE_GENERATION_FAILURES], input.mediaPipeline],
        );
        for (const row of candidates.rows) {
          const at = new Date().toISOString();
          await client.query("SAVEPOINT studio_recovery");
          try {
            const pkg = await deps.load(client, input.isTest, row.id, true);
            if (
              pkg.status !== "FAILED" ||
              pkg.failure !== row.last_error ||
              studioGenerationRecovery({
                failure: pkg.failure,
                progress: row.progress,
                currentPipeline: input.mediaPipeline,
              }) !== "retry"
            ) {
              await client.query("RELEASE SAVEPOINT studio_recovery");
              continue;
            }
            if (!(await deps.fresh(row.requested_by, input.isTest, "content.create")))
              throw Error("REQUESTER_ROLE_REVOKED");
            const ctx: DistributionContext = {
              userId: row.requested_by,
              isTest: input.isTest,
              roles: ["CONTENT_COORDINATOR"],
            };
            await deps.requestGeneration(client, ctx, pkg.id, studioGenerationRecoveryRequest(pkg));
            await stamp(client, row.job_id, input.isTest, {
              mediaPipeline: input.mediaPipeline,
              at,
              outcome: "requeued",
            });
            await client.query("RELEASE SAVEPOINT studio_recovery");
            results.push({ packageId: pkg.id, failure: row.last_error, outcome: "requeued" });
          } catch (error) {
            await client.query("ROLLBACK TO SAVEPOINT studio_recovery");
            await client.query("RELEASE SAVEPOINT studio_recovery");
            const code =
              error instanceof Error && SAFE_CODE.test(error.message)
                ? error.message
                : "STUDIO_RECOVERY_FAILED";
            // A paused series or an unreachable authority is checked again later; any
            // other refusal is final for this pipeline and left for the curator.
            if (studioGenerationRecoveryDeferred(code)) continue;
            await stamp(client, row.job_id, input.isTest, {
              mediaPipeline: input.mediaPipeline,
              at,
              outcome: "declined",
              code,
            });
            results.push({ packageId: row.id, failure: row.last_error, outcome: "declined", code });
          }
        }
        return results;
      }),
  };
}
