import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { Pool } from "pg";
import { refreshStudioClosingOutputs } from "../apps/distribution-worker/src/studio-closing-refresh.ts";
import {
  refreshStudioPreviewClosings,
  studioPreviewClosingCandidates,
} from "../apps/distribution-worker/src/studio-preview-closing.ts";
import { createAssetStore } from "../packages/distribution-assets/src/index.ts";
import { createStudioRoleAuthority } from "../packages/distribution-db/src/studio-authority.ts";
import { createIntelligentContentRepository } from "../packages/distribution-db/src/studio-repository.ts";
import {
  type StudioOutput,
  type StudioPackage,
  replaceStudioYoutubeFooter,
  studioYoutubeClosing,
} from "../packages/distribution-domain/src/index.ts";

// Explicitly authorized closing-only maintenance while older generation jobs finish.
// No worker/lease restart, AI request, publishing action, or approval is permitted.
const env = process.env;
const database = new URL(env.DISTRIBUTION_DATABASE_URL ?? "");
const origin = env.DISTRIBUTION_APP_ORIGIN;
const isTest = env.DISTRIBUTION_HUB_STAGE === "TEST";
const local =
  isTest &&
  origin === "http://localhost:3070" &&
  database.pathname === "/datta_content_studio_local";
const hosted =
  !isTest &&
  env.DISTRIBUTION_HUB_STAGE === "ON" &&
  origin === "https://gbadpt.sgsdattasannidhi.org" &&
  database.pathname === "/datta_content_studio_gbadpt_live" &&
  process.argv.includes("--allow-live-drafts");
if (
  env.STUDIO_IDENTITY !== "gbadpt" ||
  !["localhost", "127.0.0.1"].includes(database.hostname) ||
  (!local && !hosted)
)
  throw Error("WRONG_TARGET");
const bundleId = env.STUDIO_BUNDLE_ID ?? "";
if (!/^[a-f0-9-]{36}$/.test(bundleId)) throw Error("BUNDLE_REQUIRED");
const target = studioYoutubeClosing({
  label: env.STUDIO_CLOSING_LABEL ?? "",
  url: env.STUDIO_CLOSING_URL ?? "",
  ...(env.STUDIO_FULL_VIDEOS_URL ? { fullVideosUrl: env.STUDIO_FULL_VIDEOS_URL } : {}),
});
const apply = process.argv.includes("--apply");
const watch = process.argv.includes("--watch");
const expectedOutputs = env.STUDIO_EXPECTED_OUTPUTS ? Number(env.STUDIO_EXPECTED_OUTPUTS) : null;
if (expectedOutputs !== null && (!Number.isSafeInteger(expectedOutputs) || expectedOutputs < 1))
  throw Error("EXPECTED_OUTPUTS_INVALID");
const directory = env.STUDIO_CLOSING_AUDIT_DIRECTORY;
if (apply && (!directory || !isAbsolute(directory))) throw Error("BACKUP_REQUIRED");
if (directory) await mkdir(directory, { recursive: true, mode: 0o700 });
const pool = new Pool({ connectionString: database.toString(), max: 2 });
const repository = createIntelligentContentRepository(pool, {
  authorize: createStudioRoleAuthority(env, pool),
});
const store = createAssetStore(env);
const identity = `${Date.now()}`;
const resume = process.argv.includes("--resume");
if (resume && (!apply || !directory || expectedOutputs === null))
  throw Error("RESUME_SCOPE_INVALID");
let originalOutputs: Map<string, StudioOutput> | undefined;
if (resume) {
  const names = (await readdir(directory ?? "")).filter(
    (n) => n.startsWith("before-") && n.endsWith(".json"),
  );
  if (names.length !== 1) throw Error("RESUME_BASELINE_AMBIGUOUS");
  const before = JSON.parse(await readFile(join(directory ?? "", names[0] ?? ""), "utf8")) as {
    origin: string;
    bundleId: string;
    target: unknown;
    rows: { snapshot: StudioPackage }[];
  };
  if (
    before.origin !== origin ||
    before.bundleId !== bundleId ||
    !isDeepStrictEqual(before.target, target)
  )
    throw Error("RESUME_BASELINE_TARGET_CHANGED");
  originalOutputs = new Map(
    before.rows.flatMap((row) => row.snapshot.outputs.map((o) => [o.id, o] as const)),
  );
  if (originalOutputs.size !== expectedOutputs) throw Error("RESUME_BASELINE_COUNT_CHANGED");
}
let backedUp = resume;
let restored = false;
const completed: unknown[] = [];
const reportedFailures = new Set<string>();
let finished = false;
const evidence = (pkg: StudioPackage, output: StudioOutput) => ({
  packageId: pkg.id,
  outputId: output.id,
  asset: output.asset,
  target: output.presentationReview?.closingCard?.youtubeClosing,
  generatedAt: output.generatedAt,
  preserved: output.presentationReview?.closingRefresh,
  approved: false,
});
try {
  for (let attempt = 0; attempt < (watch ? 1440 : 1); attempt++) {
    const actor = (
      await pool.query(
        "SELECT id,roles FROM distribution.operator WHERE email=$1 AND is_test=$2 AND active=true",
        [env.STUDIO_ACTOR_EMAIL, isTest],
      )
    ).rows[0];
    if (!actor?.roles.includes("SUPER_ADMIN")) throw Error("ADMIN_REQUIRED");
    const ctx = { userId: actor.id as string, isTest, roles: actor.roles as string[] };
    const root = (
      await pool.query(
        "SELECT curation FROM distribution.online_import WHERE id=$1 AND is_test=$2 AND deleted_at IS NULL",
        [bundleId, isTest],
      )
    ).rows[0];
    const ids = [
      ...new Set(
        Object.values(root?.curation?.items ?? {})
          .map((item) => (item as { packageId?: string }).packageId)
          .filter(Boolean),
      ),
    ];
    if (ids.length !== Number(env.STUDIO_EXPECTED_PACKAGES)) throw Error("PACKAGE_COUNT_CHANGED");
    const rows = (
      await pool.query(
        "SELECT p.id,r.snapshot,p.generation_checkpoint FROM distribution.studio_package p JOIN distribution.studio_revision r ON r.package_id=p.id AND r.is_test=p.is_test AND r.revision=p.revision WHERE p.id=ANY($1::uuid[]) AND p.is_test=$2 AND p.deleted_at IS NULL ORDER BY p.id",
        [ids, isTest],
      )
    ).rows as {
      id: string;
      snapshot: StudioPackage;
      generation_checkpoint: Record<string, { fingerprint: string; value: unknown }>;
    }[];
    if (rows.length !== ids.length) throw Error("PACKAGE_COUNT_CHANGED");
    if (
      expectedOutputs !== null &&
      rows.reduce((count, row) => count + row.snapshot.outputs.length, 0) !== expectedOutputs
    )
      throw Error("OUTPUT_COUNT_CHANGED");
    if (
      expectedOutputs !== null &&
      !backedUp &&
      rows.some(
        ({ snapshot: p }) =>
          p.outputs.length > 0 && (["QUEUED", "GENERATING"].includes(p.status) || p.generation),
      )
    )
      throw Error("PRIOR_CLOSING_BATCH_ACTIVE");
    if (
      rows.some(
        ({ snapshot: p }) =>
          p.request.youtubeClosing?.url !== target.url ||
          p.request.sourceBranding !== "bala-swamiji",
      )
    )
      throw Error("STUDIO_TARGET_SETTINGS_CHANGED");
    if (originalOutputs && !restored) {
      const current = rows.flatMap((row) => row.snapshot.outputs);
      if (
        current.length !== originalOutputs.size ||
        current.some((o) => !originalOutputs?.has(o.id))
      )
        throw Error("RESUME_OUTPUT_IDS_CHANGED");
      for (const { snapshot: pkg } of rows)
        for (const o of pkg.outputs) {
          const original = originalOutputs.get(o.id);
          if (!original?.asset || !o.asset) throw Error("RESUME_ASSET_MISSING");
          const matched = isDeepStrictEqual(
            o.presentationReview?.closingCard?.youtubeClosing,
            target,
          );
          if (matched) {
            if (o.presentationReview?.closingRefresh?.previousSha256 !== original.asset.sha256)
              throw Error("RESUME_PRESERVATION_BASELINE_CHANGED");
            completed.push(evidence(pkg, o));
          } else if (o.asset.sha256 !== original.asset.sha256)
            throw Error("RESUME_NEWER_MEDIA_RETAINED");
        }
      await writeFile(
        join(directory ?? "", `completed-${identity}.json`),
        JSON.stringify(completed),
        { mode: 0o600, flag: "wx" },
      );
      restored = true;
      console.info(
        JSON.stringify({
          resumedVerifiedOutputs: completed.length,
          originalBaselinePreserved: true,
        }),
      );
    }
    if (apply && !backedUp) {
      await writeFile(
        join(directory ?? "", `before-${identity}.json`),
        JSON.stringify({ at: new Date().toISOString(), origin, bundleId, target, root, rows }),
        { mode: 0o600, flag: "wx" },
      );
      backedUp = true;
    }
    let pending = 0;
    const blocked: { packageId: string; failure: unknown }[] = [];
    for (const { snapshot: pkg, generation_checkpoint: entries } of rows) {
      try {
        // Completed-output maintenance must not reinterpret source recordings that
        // never produced an excerpt. Their existing result and history stay intact.
        if (
          expectedOutputs !== null &&
          !pkg.outputs.length &&
          pkg.status === "FAILED" &&
          pkg.failure === "STUDIO_NO_SUITABLE_CHANNELS"
        )
          continue;
        if (pkg.outputs.length && ["QUEUED", "GENERATING"].includes(pkg.status)) {
          pending++;
          continue;
        }
        if (["QUEUED", "GENERATING", "FAILED"].includes(pkg.status) && !pkg.outputs.length) {
          const virtual = { ...pkg, request: { ...pkg.request, youtubeClosing: target } };
          const candidates = studioPreviewClosingCandidates(virtual, entries);
          if (candidates.length)
            console.info(
              JSON.stringify({
                packageId: pkg.id,
                previewCards: candidates.length,
                dryRun: !apply,
              }),
            );
          if (apply)
            await refreshStudioPreviewClosings({
              pkg: virtual,
              entries,
              store,
              env,
              persist: async (key, before, after) => {
                await repository.replaceGenerationPreview(ctx, pkg.id, {
                  expectedRevision: pkg.revision,
                  target,
                  key,
                  before,
                  after,
                });
                completed.push(evidence(pkg, after.value as StudioOutput));
                await writeFile(
                  join(directory ?? "", `completed-${identity}.json`),
                  JSON.stringify(completed),
                  { mode: 0o600 },
                );
                console.info(JSON.stringify({ previewUpdated: (after.value as StudioOutput).id }));
              },
            });
          if (pkg.status === "FAILED") {
            const failure = { packageId: pkg.id, failure: pkg.failure };
            blocked.push(failure);
            if (!reportedFailures.has(pkg.id)) {
              console.info(JSON.stringify({ sourceFailed: failure, generationUnchanged: true }));
              reportedFailures.add(pkg.id);
            }
          } else pending++;
          continue;
        }
        const mismatched = pkg.outputs.filter(
          (o) => !isDeepStrictEqual(o.presentationReview?.closingCard?.youtubeClosing, target),
        );
        if (!mismatched.length) continue;
        if (pkg.status !== "DRAFT" || pkg.approval || pkg.generation)
          throw Error(`REVIEW_LOCKED:${pkg.id}`);
        console.info(
          JSON.stringify({ packageId: pkg.id, draftCards: mismatched.length, dryRun: !apply }),
        );
        if (!apply) continue;
        const outputs: StudioOutput[] = [];
        for (const prior of pkg.outputs) {
          if (!mismatched.includes(prior)) {
            outputs.push(prior);
            continue;
          }
          const before = prior.presentationReview?.closingCard?.youtubeClosing;
          if (!before) throw Error("STUDIO_PRESENTATION_REVIEW_INVALID");
          const repaired = await refreshStudioClosingOutputs({
            pkg: {
              ...pkg,
              request: { ...pkg.request, youtubeClosing: target },
              outputs: [{ ...prior, body: replaceStudioYoutubeFooter(prior.body, before, target) }],
            },
            store,
            env,
          });
          if (!repaired[0]) throw Error("STUDIO_PRESENTATION_REVIEW_INVALID");
          outputs.push(repaired[0]);
        }
        await repository.replaceDraftClosingCards(ctx, pkg.id, {
          expectedRevision: pkg.revision,
          target,
          outputs,
        });
        for (const output of outputs) {
          if (!completed.some((item) => (item as { outputId?: string }).outputId === output.id))
            completed.push(evidence(pkg, output));
        }
        await writeFile(
          join(directory ?? "", `completed-${identity}.json`),
          JSON.stringify(completed),
          { mode: 0o600 },
        );
      } catch (error) {
        const code = error instanceof Error ? error.message : "CLOSING_REFRESH_FAILED";
        if (!["REVISION_CONFLICT", "STUDIO_PREVIEW_CHANGED"].includes(code)) throw error;
        pending++;
        console.info(JSON.stringify({ packageId: pkg.id, retainedNewerWork: true, code }));
      }
    }
    console.info(
      JSON.stringify({
        at: new Date().toISOString(),
        pendingRecordings: pending,
        blockedRecordings: blocked,
        verifiedReplacements: completed.length,
      }),
    );
    if (!pending) {
      if (blocked.length) {
        if (apply)
          await writeFile(
            join(directory ?? "", "blocked-recordings.json"),
            JSON.stringify({ at: new Date().toISOString(), bundleId, target, blocked, completed }),
            { mode: 0o600 },
          );
        if (apply) throw Error("SOURCE_GENERATION_FAILED_AVAILABLE_CARDS_REPAIRED");
        finished = true;
        break;
      }
      if (apply) {
        if (
          rows.some(
            ({ snapshot: p }) =>
              (expectedOutputs === null || p.outputs.length > 0) &&
              (p.approval || p.status !== "DRAFT"),
          )
        )
          throw Error("REVIEW_STATE_CHANGED");
        if (resume && completed.length !== expectedOutputs)
          throw Error("RESUME_COMPLETION_COUNT_CHANGED");
        const curation = {
          ...root.curation,
          request: { ...root.curation.request, youtubeClosing: target },
        };
        const changed = await pool.query(
          "UPDATE distribution.online_import SET curation=$3,updated_at=clock_timestamp() WHERE id=$1 AND is_test=$2 AND curation=$4::jsonb",
          [bundleId, isTest, curation, root.curation],
        );
        if (changed.rowCount !== 1) throw Error("BUNDLE_SETTINGS_CHANGED_RELOAD_AND_RETRY");
        await writeFile(
          join(directory ?? "", "all-recordings-verified.json"),
          JSON.stringify({
            at: new Date().toISOString(),
            origin,
            bundleId,
            target,
            packages: ids.length,
            expectedOutputs,
            allUnapproved: true,
            completed,
          }),
          { mode: 0o600 },
        );
      }
      finished = true;
      break;
    }
    if (watch) await wait(60000);
  }
  if (!finished)
    throw Error(watch ? "CLOSING_MAINTENANCE_TIMED_OUT" : "CLOSING_MAINTENANCE_INCOMPLETE");
} finally {
  await pool.end();
}
