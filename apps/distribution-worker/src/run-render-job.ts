import { isAbsolute } from "node:path";
import { parseAssetStoreConfig } from "@satsang/distribution-assets";
import type {
  RenderClaim,
  RenderOutput,
  createDistributionRenderRepository,
} from "@satsang/distribution-db";
import type { LocalRenderResult, RenderSource } from "./renderer.js";
import { workerPlan } from "./worker.js";

type Repository = Pick<
  ReturnType<typeof createDistributionRenderRepository>,
  "claim" | "succeed" | "fail"
>;
type Renderer = {
  render(input: {
    source: RenderSource;
    recipe: RenderClaim["recipe"];
    signal?: AbortSignal;
  }): Promise<LocalRenderResult>;
  discard(output: LocalRenderResult): Promise<void>;
};
type Ports = { repository: Repository; renderer: Renderer; workerId: string; signal: AbortSignal };
export type RenderRunResult =
  | { status: "idle" }
  | { status: "rendered"; jobId: string }
  | { status: "stale" | "failed" | "uncertain"; jobId: string; reason: string };
const failureCodes = new Set([
  "RENDER_TIMEOUT",
  "RENDER_PROCESS_FAILED",
  "RENDER_PROCESS_UNAVAILABLE",
  "RENDER_CANCELLED",
  "RENDER_VALIDATION_FAILED",
  "SOURCE_INTEGRITY_FAILED",
  "SOURCE_SPAN_UNAVAILABLE",
]);
const failureCode = (error: unknown) =>
  error instanceof Error && failureCodes.has(error.message) ? error.message : "RENDER_FAILED";

/** Local TEST authority only; S3 storage requires explicit configuration. */
export function localWorkerConfig(env: Record<string, string | undefined>) {
  const plan = workerPlan(env.DISTRIBUTION_HUB_STAGE, env.DISTRIBUTION_HUB_ENABLED === "true");
  if (!plan.start) return null;
  if (plan.stage !== "TEST") throw new Error("LOCAL_TEST_WORKER_ONLY");
  let database: URL;
  try {
    database = new URL(env.DISTRIBUTION_DATABASE_URL ?? "");
  } catch {
    throw new Error("LOCAL_DISTRIBUTION_DATABASE_REQUIRED");
  }
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) ||
    database.port !== "5442" ||
    database.search ||
    database.hash ||
    !/^\/(?:[a-z0-9_]*distribution[a-z0-9_]*)$/i.test(database.pathname)
  )
    throw new Error("LOCAL_DISTRIBUTION_DATABASE_REQUIRED");
  const assets = parseAssetStoreConfig(env);
  const assetRoot = assets.backend === "local" ? assets.root : env.DISTRIBUTION_RENDER_SCRATCH_ROOT;
  const ffmpegPath = env.DISTRIBUTION_FFMPEG_PATH;
  const ffprobePath = env.DISTRIBUTION_FFPROBE_PATH;
  if (
    !assetRoot ||
    !ffmpegPath ||
    !ffprobePath ||
    ![assetRoot, ffmpegPath, ffprobePath].every(isAbsolute)
  )
    throw new Error("LOCAL_RENDER_PATHS_REQUIRED");
  return {
    databaseUrl: database.toString(),
    assetBackend: assets.backend,
    assetRoot,
    ffmpegPath,
    ffprobePath,
  };
}

/** At-most-one active render. A uncertain database commit must never delete durable media. */
export async function runRenderJob(ports: Ports): Promise<RenderRunResult> {
  if (ports.signal.aborted) return { status: "idle" };
  const claim = await ports.repository.claim({
    isTest: true,
    workerId: ports.workerId,
    leaseMs: 240000,
  });
  if (!claim) return { status: "idle" };
  let output: RenderOutput;
  try {
    if (claim.source.mimeType !== "video/mp4") throw new Error("SOURCE_INTEGRITY_FAILED");
    output = await ports.renderer.render({
      source: { ...claim.source, masterId: claim.masterId, mimeType: "video/mp4" },
      recipe: claim.recipe,
      signal: ports.signal,
    });
  } catch (error) {
    const reason = failureCode(error);
    try {
      await ports.repository.fail(claim, reason);
    } catch {
      return { status: "uncertain", jobId: claim.id, reason: "FAILURE_COMMIT_UNCONFIRMED" };
    }
    return { status: "failed", jobId: claim.id, reason };
  }
  let saved: Awaited<ReturnType<Repository["succeed"]>>;
  try {
    saved = await ports.repository.succeed(claim, output);
  } catch {
    // Lost response may follow a successful COMMIT. Preserve output until reconciled.
    return { status: "uncertain", jobId: claim.id, reason: "RESULT_COMMIT_UNCONFIRMED" };
  }
  if (saved.accepted) return { status: "rendered", jobId: claim.id };
  try {
    await ports.renderer.discard(output);
  } catch {
    return { status: "stale", jobId: claim.id, reason: "STALE_OUTPUT_CLEANUP_PENDING" };
  }
  return { status: "stale", jobId: claim.id, reason: saved.reason };
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}
export async function runRenderLoop(
  ports: Ports & {
    pollMs?: number;
    onResult?: (result: RenderRunResult) => void;
    onUnavailable?: () => void;
  },
): Promise<void> {
  const pollMs = ports.pollMs ?? 2000;
  if (!Number.isInteger(pollMs) || pollMs < 1 || pollMs > 60000)
    throw new Error("INVALID_POLL_INTERVAL");
  while (!ports.signal.aborted) {
    try {
      ports.onResult?.(await runRenderJob(ports));
    } catch {
      ports.onUnavailable?.();
    }
    await wait(pollMs, ports.signal);
  }
}
