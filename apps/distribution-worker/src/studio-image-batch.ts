import { createHash } from "node:crypto";
import type { PrivateAssetStore } from "@satsang/distribution-assets";
import {
  STUDIO_STORYBOARD_CONTINUITY_POLICY,
  type StudioAssetIdentity,
  type StudioSegment,
  type StudioSourceScreen,
  alignStudioIllustration,
  studioAssetName,
  studioVisualPreference,
} from "@satsang/distribution-domain";
import { type StudioCheckpoints, studioFingerprint } from "./studio-checkpoints.js";
import {
  type ContinuityReference,
  STUDIO_IMAGE_RESPONSE_MAX_BYTES,
  type StudioIllustrationEvidence,
  type StudioIllustrationShot,
  decodeStudioImageResponse,
  reviewStudioContextImage,
  studioImageFingerprint,
  studioImageRequestBody,
} from "./studio-context-images.js";
import { providerJson } from "./studio-intelligence.js";
import {
  STUDIO_GENERATIVE_REQUEST_TIMEOUT_MS,
  fetchGeminiWithRetry,
} from "./studio-provider-retry.js";

/** Scene images are queued in the provider's batch mode (half price, hours). The job parks
 * itself until they arrive; nothing waits inside the worker process. */
export const STUDIO_IMAGE_BATCH_POLICY = "gemini-batch-v1" as const;
/** How long a parked job waits before checking the batch again. */
export const STUDIO_IMAGE_BATCH_CHECK_MS = 10 * 60 * 1000;
/** Provider limit is 100 concurrent batch jobs; leave room for other work. */
export const STUDIO_IMAGE_BATCH_MAX_ACTIVE = 80;
/** Keep the aggregate read bounded even for callers submitting more than a storyboard. */
export const STUDIO_IMAGE_BATCH_RESPONSE_MAX_BYTES = 512 * 1024 * 1024;
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export class StudioImageBatchPending extends Error {
  constructor(
    readonly retryAfterMs: number,
    readonly batch: { round: number; images: number; submittedAt: string },
  ) {
    super("STUDIO_IMAGE_BATCH_PENDING");
  }
}

type Connection = { apiKey: string; model: string; signal?: AbortSignal; fetcher?: typeof fetch };
const BATCH_NAME = /^batches\/[A-Za-z0-9_-]{1,120}$/;
const base = "https://generativelanguage.googleapis.com/v1beta";
function headers(apiKey: string) {
  return { "x-goog-api-key": apiKey, "Content-Type": "application/json" };
}
function signalFor(input: { signal?: AbortSignal }) {
  return input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(STUDIO_GENERATIVE_REQUEST_TIMEOUT_MS)])
    : AbortSignal.timeout(STUDIO_GENERATIVE_REQUEST_TIMEOUT_MS);
}
const record = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);

/** Submit one batch of generateContent requests; the provider answers with the job name only. */
export async function createStudioImageBatch(
  input: Connection & { displayName: string; requests: { key: string; body: unknown }[] },
): Promise<{ name: string }> {
  if (!input.apiKey || !/^gemini-[A-Za-z0-9._-]{1,120}$/.test(input.model))
    throw Error("STUDIO_IMAGE_NOT_CONFIGURED");
  if (!input.requests.length || input.requests.length > 200)
    throw Error("STUDIO_IMAGE_BATCH_INVALID");
  const body = JSON.stringify({
    batch: {
      display_name: input.displayName.slice(0, 120),
      input_config: {
        requests: {
          requests: input.requests.map((r) => ({ request: r.body, metadata: { key: r.key } })),
        },
      },
    },
  });
  // Inline requests must stay under the provider's 20 MB limit.
  if (Buffer.byteLength(body) > 19 * 1024 * 1024) throw Error("STUDIO_IMAGE_BATCH_TOO_LARGE");
  const response = await providerJson(
    (url, init) => fetchGeminiWithRetry(input.fetcher ?? fetch, String(url), init ?? {}),
    `${base}/models/${input.model}:batchGenerateContent`,
    {
      method: "POST",
      redirect: "error",
      signal: signalFor(input),
      headers: headers(input.apiKey),
      body,
    },
    1024 * 1024,
  );
  const name = record(response) && typeof response.name === "string" ? response.name : "";
  if (!BATCH_NAME.test(name)) throw Error("STUDIO_IMAGE_BATCH_INVALID");
  return { name };
}

export type StudioImageBatchState =
  | { done: false; state: string }
  | {
      done: true;
      state: "JOB_STATE_SUCCEEDED";
      responses: Map<string, { response?: unknown; error?: unknown }>;
    }
  | { done: true; state: "JOB_STATE_FAILED" | "JOB_STATE_CANCELLED" | "JOB_STATE_EXPIRED" };

/** Read a batch job. Finished responses are keyed by the request key the job was created with. */
export async function readStudioImageBatch(
  input: Omit<Connection, "model"> & { name: string; keys: string[] },
): Promise<StudioImageBatchState> {
  if (
    !BATCH_NAME.test(input.name) ||
    !input.keys.length ||
    input.keys.length > 200 ||
    new Set(input.keys).size !== input.keys.length
  )
    throw Error("STUDIO_IMAGE_BATCH_INVALID");
  // Inline results contain all requested images. Reuse the single-image envelope
  // budget so a valid 14-scene storyboard can be read from its saved batch name.
  // This is a GET: neither a larger allowance nor native recovery resubmits images.
  const maximum = Math.min(
    STUDIO_IMAGE_BATCH_RESPONSE_MAX_BYTES,
    Math.max(64 * 1024 * 1024, input.keys.length * STUDIO_IMAGE_RESPONSE_MAX_BYTES + 1024 * 1024),
  );
  const job = await providerJson(
    (url, init) => fetchGeminiWithRetry(input.fetcher ?? fetch, String(url), init ?? {}),
    `${base}/${input.name}`,
    { method: "GET", redirect: "error", signal: signalFor(input), headers: headers(input.apiKey) },
    maximum,
  );
  if (!record(job)) throw Error("STUDIO_IMAGE_BATCH_INVALID");
  const metadata = record(job.metadata) ? job.metadata : {};
  // The live API reports BATCH_STATE_*; the documentation shows JOB_STATE_*. Accept both.
  const reported = String(metadata.state ?? job.state ?? "");
  if (!/^(JOB|BATCH)_STATE_[A-Z_]{1,40}$/.test(reported)) throw Error("STUDIO_IMAGE_BATCH_INVALID");
  const state = reported.replace(/^BATCH_STATE_/, "JOB_STATE_");
  if (["JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED"].includes(state))
    return { done: true, state: state as "JOB_STATE_FAILED" };
  if (state !== "JOB_STATE_SUCCEEDED") return { done: false, state };
  const container = record(job.response) ? job.response : record(job.dest) ? job.dest : {};
  const inlined = container.inlinedResponses;
  const items = Array.isArray(inlined)
    ? inlined
    : record(inlined) && Array.isArray(inlined.inlinedResponses)
      ? inlined.inlinedResponses
      : [];
  if (items.length !== input.keys.length) throw Error("STUDIO_IMAGE_BATCH_INVALID");
  const responses = new Map<string, { response?: unknown; error?: unknown }>();
  items.forEach((item, index) => {
    if (!record(item)) throw Error("STUDIO_IMAGE_BATCH_INVALID");
    const key =
      record(item.metadata) && typeof item.metadata.key === "string"
        ? item.metadata.key
        : input.keys[index];
    if (!key || !input.keys.includes(key) || responses.has(key))
      throw Error("STUDIO_IMAGE_BATCH_INVALID");
    responses.set(key, {
      ...(item.response !== undefined ? { response: item.response } : {}),
      ...(item.error !== undefined ? { error: item.error } : {}),
    });
  });
  return { done: true, state: "JOB_STATE_SUCCEEDED", responses };
}

/** Jobs still queued or running under this workspace's display-name prefix. */
export async function countActiveStudioImageBatches(
  input: Omit<Connection, "model"> & { prefix: string },
): Promise<number> {
  const listing = await providerJson(
    (url, init) => fetchGeminiWithRetry(input.fetcher ?? fetch, String(url), init ?? {}),
    `${base}/batches?pageSize=100`,
    { method: "GET", redirect: "error", signal: signalFor(input), headers: headers(input.apiKey) },
    8 * 1024 * 1024,
  );
  const batches = record(listing) && Array.isArray(listing.batches) ? listing.batches : [];
  return batches.filter((b) => {
    if (!record(b)) return false;
    const metadata = record(b.metadata) ? b.metadata : {};
    const name = String(metadata.displayName ?? metadata.display_name ?? b.displayName ?? "");
    const state = String(metadata.state ?? b.state ?? "").replace(/^BATCH_STATE_/, "JOB_STATE_");
    return (
      name.startsWith(input.prefix) && ["JOB_STATE_PENDING", "JOB_STATE_RUNNING"].includes(state)
    );
  }).length;
}

type Planned = StudioIllustrationShot & {
  segments: StudioSegment[];
  context: unknown;
};
type Attempt = {
  fingerprint: string;
  round: number;
  /** Accumulated findings sent with the next request. */
  repair?: string;
  /** The latest review reason alone, for progress and learning. */
  reason?: string;
  rejected?: Buffer;
};
type SavedImage = Omit<StudioIllustrationEvidence, "checks" | "reviewedAt" | "reviewerModel">;

/** Batch counterpart of studioContextIllustrationShots: every pending scene of a round goes into one
 * provider batch job; the job parks (STUDIO_IMAGE_BATCH_PENDING) until the images exist, then each
 * image is reviewed in real time exactly as in immediate mode, and the rejected ones form the next
 * round's correction batch. At most three rounds; a scene that still fails is dropped or holds the file. */
export async function studioBatchedContextIllustrationShots(input: {
  screen: StudioSourceScreen;
  segments: StudioSegment[];
  clipStartMs: number;
  sourceSha256: string;
  sourceTitle: string;
  identity: StudioAssetIdentity;
  store: PrivateAssetStore;
  checkpoints: StudioCheckpoints;
  apiKey: string;
  imageModel: string;
  reviewerModel: string;
  visualPreference?: string;
  aspectRatio?: "3:4" | "9:16";
  /** Display-name prefix that identifies this workspace's jobs at the provider. */
  batchPrefix: string;
  learnedRules?: string;
  onReviewRejected?: (finding: { reason: string; brief: string }) => Promise<void>;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  onRejected?: (shot: StudioIllustrationShot) => void;
}) {
  const connection = {
    apiKey: input.apiKey,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
  };
  const planned: Planned[] = (input.screen.illustrations ?? [])
    .map((shot) =>
      alignStudioIllustration(
        shot,
        input.segments,
        input.clipStartMs,
        input.screen.illustrationPolicy,
      ),
    )
    .sort((a, b) => a.startMs - b.startMs)
    .map((shot) => {
      const segments = input.segments.filter((s) => shot.sourceSegmentIds.includes(s.id));
      if (
        !shot.prompt?.trim() ||
        shot.prompt.length > 2000 ||
        !segments.length ||
        shot.sourceSegmentIds.some((id) => !segments.some((s) => s.id === id)) ||
        input.clipStartMs + shot.startMs < Math.min(...segments.map((s) => s.startMs)) ||
        input.clipStartMs + shot.endMs > Math.max(...segments.map((s) => s.endMs))
      )
        throw Error("STUDIO_ILLUSTRATION_INVALID");
      return { ...shot, segments, context: undefined };
    });
  const storyboard = planned.map((shot) => ({
    assetId: shot.assetId,
    startMs: shot.startMs,
    endMs: shot.endMs,
    sourceSegmentIds: shot.sourceSegmentIds,
    brief: shot.prompt,
    rationale: shot.reason,
  }));
  for (const shot of planned)
    shot.context = {
      sourceTitle: input.sourceTitle,
      sourceSha256: input.sourceSha256,
      nativeSegments: shot.segments,
      rationale: shot.reason,
      storyboardPolicy: STUDIO_STORYBOARD_CONTINUITY_POLICY,
      storyboard,
      currentSceneId: shot.assetId,
      imageDelivery: STUDIO_IMAGE_BATCH_POLICY,
    };
  const style = studioVisualPreference(input.visualPreference);
  const request = (shot: Planned, attempt: Attempt) => ({
    prompt: shot.prompt as string,
    context: shot.context,
    visualPreference: style,
    ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
    ...(input.learnedRules ? { learnedRules: input.learnedRules } : {}),
    ...(attempt.repair ? { repair: attempt.repair } : {}),
    ...(attempt.rejected ? { previousImage: attempt.rejected } : {}),
  });
  const identity = (shot: Planned, attempt: Attempt) =>
    studioImageFingerprint(
      {
        prompt: shot.prompt as string,
        context: shot.context,
        imageModel: input.imageModel,
        reviewerModel: input.reviewerModel,
        visualPreference: style,
        ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
        ...(input.learnedRules ? { learnedRules: input.learnedRules } : {}),
        delivery: "batch",
      },
      attempt.repair,
      attempt.round,
    );
  const accepted = new Map<string, { bytes: Buffer; generated: StudioIllustrationEvidence }>();
  const open = new Map<string, Attempt>(
    planned.map((s) => [s.assetId, { fingerprint: "", round: 0 }]),
  );
  for (const [id, attempt] of open) {
    const shot = planned.find((s) => s.assetId === id) as Planned;
    attempt.fingerprint = identity(shot, attempt);
  }
  for (let round = 0; round < 3 && open.size; round++) {
    // Images this round still needs from the provider.
    const missing = [...open].filter(
      ([, attempt]) =>
        !input.checkpoints.get<SavedImage>(`image:${attempt.fingerprint}`, attempt.fingerprint),
    );
    if (missing.length) {
      const keys = missing.map(([id]) => id);
      const batchFingerprint = studioFingerprint({
        policy: STUDIO_IMAGE_BATCH_POLICY,
        round,
        images: missing.map(([id, attempt]) => ({ id, fingerprint: attempt.fingerprint })),
      });
      const jobKey = `image-batch:${batchFingerprint}`;
      let job = input.checkpoints.get<{ name: string; submittedAt: string }>(
        jobKey,
        batchFingerprint,
      );
      if (!job) {
        const active = await countActiveStudioImageBatches({
          ...connection,
          prefix: input.batchPrefix,
        });
        if (active >= STUDIO_IMAGE_BATCH_MAX_ACTIVE)
          throw new StudioImageBatchPending(STUDIO_IMAGE_BATCH_CHECK_MS, {
            round,
            images: missing.length,
            submittedAt: "",
          });
        const created = await createStudioImageBatch({
          ...connection,
          model: input.imageModel,
          displayName: `${input.batchPrefix}-${batchFingerprint.slice(0, 12)}-r${round}`,
          requests: missing.map(([id, attempt]) => ({
            key: id,
            body: studioImageRequestBody(
              request(planned.find((s) => s.assetId === id) as Planned, attempt),
            ),
          })),
        });
        job = { name: created.name, submittedAt: new Date().toISOString() };
        await input.checkpoints.set(jobKey, batchFingerprint, job);
        throw new StudioImageBatchPending(STUDIO_IMAGE_BATCH_CHECK_MS, {
          round,
          images: missing.length,
          submittedAt: job.submittedAt,
        });
      }
      const state = await readStudioImageBatch({ ...connection, name: job.name, keys });
      if (!state.done)
        throw new StudioImageBatchPending(STUDIO_IMAGE_BATCH_CHECK_MS, {
          round,
          images: missing.length,
          submittedAt: job.submittedAt,
        });
      if (state.state !== "JOB_STATE_SUCCEEDED") {
        // The provider gave up on the whole job: forget it so the next claim submits afresh.
        await input.checkpoints.set(jobKey, `${batchFingerprint}-expired`, {
          name: job.name,
          failed: true,
        });
        throw Error("STUDIO_IMAGE_BATCH_FAILED");
      }
      for (const [id, attempt] of missing) {
        const item = state.responses.get(id);
        let bytes: Buffer | undefined;
        try {
          if (!item || item.error !== undefined || item.response === undefined)
            throw Error("STUDIO_IMAGE_GENERATION_INVALID");
          bytes = await decodeStudioImageResponse(item.response);
        } catch {
          // A failed request becomes a rejection with a provider reason; the next round retries it.
          await input.checkpoints.set(`image-review:${attempt.fingerprint}`, attempt.fingerprint, {
            checks: null,
            reviewedAt: new Date().toISOString(),
            providerFailed: true,
          });
          continue;
        }
        const asset = {
          ...studioAssetName(
            { ...input.identity, renderId: attempt.fingerprint.slice(0, 8) },
            "png",
          ),
          sha256: hash(bytes),
          byteSize: bytes.length,
          mimeType: "image/png",
        };
        await input.store.writeDerivedDescriptor(asset, bytes);
        const saved: SavedImage = {
          asset,
          provider: "gemini",
          model: input.imageModel,
          generatedAt: new Date().toISOString(),
        };
        await input.checkpoints.set(`image:${attempt.fingerprint}`, attempt.fingerprint, saved);
      }
    }
    // Review this round's images in storyboard order, against the latest accepted earlier scene.
    for (const shot of planned) {
      const attempt = open.get(shot.assetId);
      if (!attempt) continue;
      const saved = input.checkpoints.get<SavedImage>(
        `image:${attempt.fingerprint}`,
        attempt.fingerprint,
      );
      const reviewKey = `image-review:${attempt.fingerprint}`;
      let review = input.checkpoints.get<{
        checks: StudioIllustrationEvidence["checks"] | null;
        reviewedAt: string;
        providerFailed?: boolean;
      }>(reviewKey, attempt.fingerprint);
      if (!saved) {
        if (!review?.providerFailed) throw Error("STUDIO_ILLUSTRATION_INVALID");
        open.set(shot.assetId, {
          fingerprint: "",
          round: attempt.round + 1,
          repair: "The provider returned no usable image for this brief; create it again.",
        });
        const next = open.get(shot.assetId) as Attempt;
        next.fingerprint = identity(shot, next);
        continue;
      }
      const bytes = await input.store.readDerivedDescriptor(saved.asset);
      if (hash(bytes) !== saved.asset.sha256) throw Error("STUDIO_ILLUSTRATION_INVALID");
      const previous = [...accepted.entries()]
        .filter(([id]) => planned.findIndex((s) => s.assetId === id) < planned.indexOf(shot))
        .at(-1)?.[1];
      const continuityReference: ContinuityReference | undefined = previous
        ? {
            bytes: previous.bytes,
            sha256: previous.generated.asset.sha256,
            context: { sourceSha256: input.sourceSha256, brief: "previous accepted scene" },
          }
        : undefined;
      if (!review) {
        const checks = await reviewStudioContextImage({
          ...connection,
          model: input.reviewerModel,
          bytes: Buffer.from(bytes),
          prompt: shot.prompt as string,
          context: shot.context,
          ...(continuityReference ? { continuityReference } : {}),
          ...(input.learnedRules ? { learnedRules: input.learnedRules } : {}),
        });
        review = { checks, reviewedAt: new Date().toISOString() };
        await input.checkpoints.set(reviewKey, attempt.fingerprint, review);
      }
      const checks = review.checks;
      if (
        checks &&
        [
          checks.iconographyAccurate,
          checks.photorealistic,
          checks.continuityConsistent,
          checks.contextFaithful,
          checks.nonDeceptive,
          checks.noInventedText,
          checks.visualQuality,
          checks.safeComposition,
        ].every((v) => v === true)
      ) {
        accepted.set(shot.assetId, {
          bytes: Buffer.from(bytes),
          generated: {
            ...saved,
            checks,
            reviewedAt: review.reviewedAt,
            reviewerModel: input.reviewerModel,
          },
        });
        open.delete(shot.assetId);
        continue;
      }
      const reason = checks?.reason ?? "The illustration did not pass review.";
      const next: Attempt = {
        fingerprint: "",
        round: attempt.round + 1,
        reason,
        repair: attempt.repair
          ? `${attempt.repair} Previous correction still failed: ${reason}`
          : reason,
        // The first correction edits the rejected picture; the last draws afresh with the findings.
        ...(attempt.round === 0 ? { rejected: Buffer.from(bytes) } : {}),
      };
      next.fingerprint = identity(shot, next);
      open.set(shot.assetId, next);
      if (checks?.reason && !review.providerFailed)
        await input
          .onReviewRejected?.({ reason: checks.reason, brief: shot.prompt as string })
          .catch(() => {});
    }
  }
  const shots: (StudioIllustrationShot & {
    bytes: Buffer;
    generated: StudioIllustrationEvidence;
  })[] = [];
  for (const shot of planned) {
    const done = accepted.get(shot.assetId);
    const { segments: _segments, context: _context, ...plain } = shot;
    if (done) {
      shots.push({ ...plain, bytes: done.bytes, generated: done.generated });
      continue;
    }
    const last = open.get(shot.assetId);
    await input.checkpoints.progress({
      phase: "reviewing",
      provider: "gemini",
      completed: 0,
      total: 1,
      presentationIssues: [
        last?.reason ?? "The custom illustration did not pass contextual review.",
      ],
    });
    if (!input.onRejected) throw Error("STUDIO_IMAGE_REVIEW_REQUIRED");
    input.onRejected(plain);
  }
  return shots;
}
