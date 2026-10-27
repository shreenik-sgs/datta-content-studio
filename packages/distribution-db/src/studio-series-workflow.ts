import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as same } from "node:util";
import {
  type PlaylistCuration,
  type StudioGenerationRequest,
  type StudioPackage,
  type StudioSeriesWorkflow,
  assertStudioDiscoveryIsolation,
  isOnlineBundle,
  requireSeriesDraft,
  requireSeriesStoryRequest,
  seriesStoryCoverage,
} from "@satsang/distribution-domain";
import type { PoolClient } from "pg";
import type { DistributionContext } from "./repository";
import { validateStudioClosingReplacement } from "./studio-closing-replacement";
import { STUDIO_QUEUE_FENCE } from "./studio-queue-fence.js";

type Dependencies = {
  transaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
  access: (
    client: PoolClient,
    ctx: DistributionContext,
    capability?: "content.create",
  ) => Promise<unknown>;
  fresh: (id: string, isTest: boolean, capability: "content.create") => Promise<boolean>;
  sourceCurrent: (client: PoolClient, pkg: StudioPackage) => Promise<unknown>;
  load: (client: PoolClient, isTest: boolean, id: string, lock?: boolean) => Promise<StudioPackage>;
  requestGeneration: (
    client: PoolClient,
    ctx: DistributionContext,
    id: string,
    input: {
      expectedRevision: number;
      request?: StudioGenerationRequest;
      mode: "discover" | "closing";
      outputIds?: string[];
    },
  ) => Promise<StudioPackage>;
};

/** Uses the same checked application queue as individual curation. The plan and
 * all accepted jobs commit atomically, so a lost response cannot duplicate a batch. */
export function createStudioSeriesWorkflow(deps: Dependencies) {
  const revision = async (client: PoolClient, pkg: StudioPackage, number: number) => {
    const result = await client.query(
      "SELECT snapshot FROM distribution.studio_revision WHERE package_id=$1 AND is_test=$2 AND revision=$3",
      [pkg.id, pkg.isTest, number],
    );
    if (!result.rows[0]) throw Error("STUDIO_SERIES_CONTENT_CHANGED");
    return result.rows[0].snapshot as StudioPackage;
  };
  const save = async (
    client: PoolClient,
    id: string,
    isTest: boolean,
    plan: PlaylistCuration,
    action: string,
  ) => {
    const workflow = plan.workflow;
    if (!workflow) throw Error("STUDIO_SERIES_WORKFLOW_CHANGED");
    workflow.version++;
    workflow.updatedAt = new Date().toISOString();
    workflow.history.push({ at: workflow.updatedAt, action, actorId: workflow.requestedBy });
    await client.query(
      "UPDATE distribution.online_import SET curation=$3,updated_at=now() WHERE id=$1 AND is_test=$2",
      [id, isTest, plan],
    );
  };
  const requireMemberSet = (ids: string[], workflow: StudioSeriesWorkflow) => {
    if (!same([...ids].sort(), [...workflow.sourceIds].sort()))
      throw Error("STUDIO_SERIES_MEMBERS_CHANGED");
  };
  const assertCompletedJob = async (client: PoolClient, pkg: StudioPackage, started: number) => {
    const original = await revision(client, pkg, started);
    const history = await client.query(
      "SELECT action,snapshot,revision FROM distribution.studio_revision WHERE package_id=$1 AND is_test=$2 AND revision >= $3 ORDER BY revision",
      [pkg.id, pkg.isTest, started],
    );
    // Explicit native retries may produce more revisions; edits, approvals and
    // destination changes always require a new human review instead of being overwritten.
    if (
      history.rows.some(
        (row) =>
          !["GENERATION_REQUESTED", "GENERATION_FAILED", "GENERATED"].includes(row.action) ||
          !same(row.snapshot.request, original.request) ||
          (row.action === "GENERATION_REQUESTED" &&
            !same(row.snapshot.generation, original.generation)),
      )
    )
      throw Error("STUDIO_SERIES_CONTENT_CHANGED");
    const latest = history.rows.filter((row) => row.action === "GENERATION_REQUESTED").at(-1);
    const jobs = await client.query(
      "SELECT status FROM distribution.studio_generation_job WHERE package_id=$1 AND is_test=$2 AND package_revision=$3",
      [pkg.id, pkg.isTest, latest?.revision ?? started],
    );
    if (jobs.rows[0]?.status !== "SUCCEEDED")
      throw Error(pkg.failure ?? "STUDIO_SERIES_WORKFLOW_FAILED");
    if (history.rows.at(-1)?.action !== "GENERATED") throw Error("STUDIO_SERIES_CONTENT_CHANGED");
  };
  return {
    configureSeriesWorkflow: (
      ctx: DistributionContext,
      id: string,
      input: {
        action: "start" | "pause" | "resume" | "rebase";
        workflowId?: string | undefined;
        expectedVersion?: number | undefined;
      },
    ) =>
      deps.transaction(async (client) => {
        await deps.access(client, ctx, "content.create");
        if (!(await deps.fresh(ctx.userId, ctx.isTest, "content.create")))
          throw Error("REQUESTER_ROLE_REVOKED");
        const row = (
          await client.query(
            "SELECT * FROM distribution.online_import WHERE id=$1 AND is_test=$2 AND deleted_at IS NULL FOR UPDATE",
            [id, ctx.isTest],
          )
        ).rows[0];
        if (!row || !isOnlineBundle(row.source) || !row.curation || !row.child_ids?.length)
          throw Error("PLAYLIST_NOT_READY");
        const plan = row.curation as PlaylistCuration;
        if (plan.pausedForCleanup || plan.pausedForSettings)
          throw Error("PLAYLIST_SETTINGS_PAUSED");
        if (input.action === "start" || input.action === "rebase") {
          if (input.action === "start" && plan.workflow) return plan.workflow;
          if (
            input.action === "rebase" &&
            (!plan.workflow ||
              plan.workflow.id !== input.workflowId ||
              plan.workflow.version !== input.expectedVersion ||
              !["blocked", "complete"].includes(plan.workflow.state))
          )
            throw Error("STUDIO_SERIES_WORKFLOW_CHANGED");
          if (
            plan.request.channels.length !== 1 ||
            plan.request.channels[0] !== "youtube" ||
            !plan.request.captions ||
            !plan.request.allCompleteMessages
          )
            throw Error("STUDIO_SERIES_STORY_SETTINGS_REQUIRED");
          for (const member of Object.values(plan.items)) {
            if (!member.packageId) continue;
            const pkg = await deps.load(client, ctx.isTest, member.packageId, true);
            if (input.action === "rebase") requireSeriesDraft(pkg);
            if (
              pkg.approval ||
              pkg.outputs.some((o) => o.included && o.workflow && o.workflow.status !== "DRAFT") ||
              !["QUEUED", "GENERATING", "DRAFT", "FAILED"].includes(pkg.status)
            )
              throw Error("STUDIO_SERIES_DRAFT_REQUIRED");
          }
          const at = new Date().toISOString();
          if (plan.workflow)
            plan.workflowHistory = [
              ...(plan.workflowHistory ?? []),
              structuredClone(plan.workflow),
            ];
          plan.workflow = {
            id: randomUUID(),
            version: 0,
            state: "running",
            phase: "shorts",
            requestedBy: ctx.userId,
            createdAt: at,
            updatedAt: at,
            sourceIds: [...row.child_ids],
            members: {},
            history: [],
          };
        } else {
          const workflow = plan.workflow;
          if (
            !workflow ||
            workflow.id !== input.workflowId ||
            workflow.version !== input.expectedVersion ||
            workflow.state === "complete"
          )
            throw Error("STUDIO_SERIES_WORKFLOW_CHANGED");
          requireMemberSet(row.child_ids, workflow);
          workflow.requestedBy = ctx.userId;
          workflow.state = input.action === "pause" ? "paused" : "running";
          Reflect.deleteProperty(workflow, "error");
        }
        await save(client, id, ctx.isTest, plan, input.action);
        return plan.workflow;
      }),
    advanceSeriesWorkflow: (isTest: boolean) =>
      deps.transaction(async (client) => {
        // Try the exclusive queue fence without waiting for any other transaction.
        // It prevents a new job being accepted between our idle check and dispatch.
        if (
          !(
            await client.query(
              "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked",
              [STUDIO_QUEUE_FENCE],
            )
          ).rows[0]?.locked
        )
          return false;
        const active = await client.query(
          `SELECT
        EXISTS(SELECT 1 FROM distribution.studio_generation_job WHERE status IN ('QUEUED','RUNNING')) OR
        EXISTS(SELECT 1 FROM distribution.studio_publication_job WHERE status IN ('QUEUED','RUNNING','PROCESSING')) OR
        EXISTS(SELECT 1 FROM distribution.online_import WHERE deleted_at IS NULL AND status IN ('QUEUED','DOWNLOADING')) AS busy`,
        );
        if (active.rows[0]?.busy) return false;
        const row = (
          await client.query(
            `SELECT * FROM distribution.online_import WHERE is_test=$1 AND deleted_at IS NULL
        AND curation->'workflow'->>'state'='running' AND curation->>'pausedForSettings' IS DISTINCT FROM 'true'
        AND curation->>'pausedForCleanup' IS DISTINCT FROM 'true' ORDER BY updated_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
            [isTest],
          )
        ).rows[0];
        if (!row) return false;
        const plan = row.curation as PlaylistCuration;
        const workflow = plan.workflow as StudioSeriesWorkflow;
        const unchanged = structuredClone(plan);
        await client.query("SAVEPOINT series_step");
        try {
          if (!(await deps.fresh(workflow.requestedBy, isTest, "content.create")))
            throw Error("REQUESTER_ROLE_REVOKED");
          requireMemberSet(row.child_ids, workflow);
          const ids = workflow.sourceIds.map((id) => plan.items[id]?.packageId);
          if (ids.some((id) => !id) || new Set(ids).size !== ids.length)
            throw Error("STUDIO_SERIES_MEMBERS_CHANGED");
          const packages: StudioPackage[] = [];
          for (const id of (ids as string[]).sort()) {
            const pkg = await deps.load(client, isTest, id, true);
            await deps.sourceCurrent(client, pkg);
            if (pkg.failure) throw Error(pkg.failure);
            requireSeriesDraft(pkg);
            requireSeriesStoryRequest(pkg);
            packages.push(pkg);
          }
          const ctx = { userId: workflow.requestedBy, isTest, roles: ["CONTENT_COORDINATOR"] };
          if (workflow.phase === "shorts") {
            for (const pkg of packages) {
              const member = {
                baselineRevision: pkg.revision,
                shorts: pkg.outputs.filter((o) => o.included && o.format === "short").length,
                stories: pkg.outputs.filter((o) => o.included && o.format === "video").length,
              } as StudioSeriesWorkflow["members"][string];
              workflow.members[pkg.id] = member;
              if (!seriesStoryCoverage(pkg)) {
                if (pkg.outputs.some((o) => o.included && o.format === "video"))
                  throw Error("STUDIO_SERIES_STORY_COVERAGE_REQUIRED");
                const queued = await deps.requestGeneration(client, ctx, pkg.id, {
                  expectedRevision: pkg.revision,
                  mode: "discover",
                  request: { ...pkg.request, youtubeFormat: "video", allCompleteMessages: true },
                });
                member.storyRevision = queued.revision;
              }
            }
            workflow.phase = "stories";
          } else if (workflow.phase === "stories") {
            for (const pkg of packages) {
              const member = workflow.members[pkg.id];
              if (!member) throw Error("STUDIO_SERIES_MEMBERS_CHANGED");
              if (member.storyRevision) await assertCompletedJob(client, pkg, member.storyRevision);
              else if (pkg.revision !== member.baselineRevision)
                throw Error("STUDIO_SERIES_CONTENT_CHANGED");
              if (!seriesStoryCoverage(pkg)) throw Error("STUDIO_SERIES_STORY_COVERAGE_REQUIRED");
              assertStudioDiscoveryIsolation(
                (await revision(client, pkg, member.baselineRevision)).outputs,
                pkg.outputs,
              );
              member.shorts = pkg.outputs.filter((o) => o.included && o.format === "short").length;
              member.stories = pkg.outputs.filter((o) => o.included && o.format === "video").length;
              member.noSuitableStory = member.stories === 0;
              member.exclusions = [
                ...(pkg.provenance?.discovery?.sections.flatMap((s) =>
                  s.reason ? [s.reason] : [],
                ) ?? []),
                ...(pkg.provenance?.excludedMessages?.flatMap((e) => e.reasons) ?? []),
              ];
              const queued = await deps.requestGeneration(client, ctx, pkg.id, {
                expectedRevision: pkg.revision,
                mode: "closing",
                outputIds: pkg.outputs
                  .filter((o) => o.included && ["short", "video", "reel"].includes(o.format))
                  .map((o) => o.id),
              });
              member.closingRevision = queued.revision;
            }
            workflow.phase = "closings";
          } else if (workflow.phase === "closings") {
            for (const pkg of packages) {
              const member = workflow.members[pkg.id];
              if (!member?.closingRevision) throw Error("STUDIO_SERIES_CONTENT_CHANGED");
              await assertCompletedJob(client, pkg, member.closingRevision);
              const before = await revision(client, pkg, member.closingRevision);
              const checkpoint =
                (
                  await client.query(
                    "SELECT generation_checkpoint FROM distribution.studio_package WHERE id=$1 AND is_test=$2",
                    [pkg.id, isTest],
                  )
                ).rows[0]?.generation_checkpoint ?? {};
              if (before.outputs.length !== pkg.outputs.length)
                throw Error("STUDIO_SERIES_CONTENT_CHANGED");
              for (const old of before.outputs) {
                const current = pkg.outputs.find((o) => o.id === old.id);
                if (!current) throw Error("STUDIO_SERIES_CONTENT_CHANGED");
                if (!same(old, current)) {
                  if (!pkg.request.youtubeClosing) throw Error("STUDIO_SERIES_CONTENT_CHANGED");
                  validateStudioClosingReplacement(
                    pkg,
                    old,
                    { ...current, ...(old.workflow ? { workflow: old.workflow } : {}) },
                    pkg.request.youtubeClosing,
                  );
                }
                if (!current.included) continue;
                const proof = checkpoint[`media-verification:${current.id}`]?.value;
                if (
                  proof?.policy !== "studio-export-verification-v1" ||
                  !current.asset ||
                  proof.renderedSha256 !== current.asset.sha256 ||
                  proof.fileVersion !== (current.fileVersion ?? 1) ||
                  !proof.audioSha256 ||
                  proof.language !== current.language ||
                  proof.captionSha256 !==
                    current.captions.find((c) => c.language === current.language)?.asset.sha256 ||
                  (current.presentationReview?.closingRefresh &&
                    proof.audioSha256 !== current.presentationReview.closingRefresh.audioSha256) ||
                  !proof.cardPixelsVerified ||
                  !proof.captionsVerified ||
                  !proof.decoded ||
                  !same(proof.closingCard, current.presentationReview?.closingCard)
                )
                  throw Error("STUDIO_SERIES_MEDIA_VERIFICATION_REQUIRED");
              }
              member.completedRevision = pkg.revision;
            }
            workflow.phase = "complete";
            workflow.state = "complete";
          }
          await save(client, row.id, isTest, plan, workflow.phase);
          await client.query("RELEASE SAVEPOINT series_step");
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT series_step");
          // No partially dispatched batch survives a failure. Preserve the previous
          // journal and show a safe, actionable failure; never automatically retry AI.
          const saved = unchanged.workflow as StudioSeriesWorkflow;
          const code = error instanceof Error ? error.message : "";
          saved.state = "blocked";
          saved.error = /^[A-Z][A-Z0-9_]{0,99}$/.test(code)
            ? code
            : "STUDIO_SERIES_WORKFLOW_FAILED";
          await save(client, row.id, isTest, unchanged, "blocked");
        }
        return true;
      }),
  };
}
