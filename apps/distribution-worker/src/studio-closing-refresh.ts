import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { PrivateAssetStore } from "@satsang/distribution-assets";
import type { StudioGenerationClaim } from "@satsang/distribution-db";
import {
  STUDIO_SUBTITLE_TOP,
  type StudioAppLinks,
  type StudioOutput,
  type StudioPackage,
  type StudioPresentationReview,
  studioAssetName,
  studioClosingCardPlan,
  studioVideoDurationLimitMs,
  validateStudioAiReviewEvidence,
  validateStudioPresentationReview,
} from "@satsang/distribution-domain";
import sharp from "sharp";
import { createPrivateRenderScratch } from "./renderer.js";
import { type StudioCheckpoints, studioFingerprint } from "./studio-checkpoints.js";
import { spliceClosingVideo } from "./studio-closing-splice.js";
import { studioClosingCard } from "./studio-ending.js";
import { executeStudioSource } from "./studio-process.js";
import { saveSharedStudioAsset } from "./studio-shared-assets.js";

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export class StudioClosingPreservationError extends Error {
  constructor(
    readonly check: "audio" | "picture" | "captions" | "card",
    readonly minimum?: number,
  ) {
    super("STUDIO_CLOSING_PRESERVATION_FAILED");
  }
}
type ClosingReplacementInput = {
  sourcePath: string;
  directory: string;
  ffmpeg: string;
  card: Uint8Array;
  startMs: number;
  endMs: number;
  signal?: AbortSignal;
};
/** Retry compression only, with the same strict visual threshold and original speech. */
export async function replaceStudioClosingCard(input: ClosingReplacementInput) {
  try {
    return await renderClosingReplacement(input, 10);
  } catch (error) {
    if (!(error instanceof StudioClosingPreservationError) || error.check === "audio") throw error;
    await rm(join(input.directory, "closing-refresh.mp4"), { force: true });
    return renderClosingReplacement(input, 6);
  }
}

/** Copy the unchanged GOPs; compare only the re-encoded ending. Original audio stays intact. */
async function renderClosingReplacement(input: ClosingReplacementInput, crf: number) {
  const { directory, startMs } = input;
  const cardPath = join(directory, "closing.png");
  const path = join(directory, "closing-refresh.mp4");
  await writeFile(cardPath, input.card, { mode: 0o600 });
  const execute = (sourcePath: string, args: string[]) =>
    executeStudioSource({
      executable: input.ffmpeg,
      sourcePath,
      mimeType: "video/mp4",
      directory,
      timeoutMs: 1200000,
      ...(input.signal ? { signal: input.signal } : {}),
      args,
    });
  const splice = await spliceClosingVideo({
    sourcePath: input.sourcePath,
    directory,
    ffmpeg: input.ffmpeg,
    cardPath,
    startMs,
    crf,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const tailStart = splice.splitSeconds;
  const audioHash = async (file: string) => {
    const value = await execute(file, [
      "-v",
      "error",
      "-i",
      "__SOURCE__",
      "-map",
      "0:a:0",
      "-c:a",
      "copy",
      "-f",
      "hash",
      "-hash",
      "sha256",
      "-",
    ]);
    const hash = /SHA256=([a-f0-9]{64})/.exec(value)?.[1];
    if (!hash) throw new StudioClosingPreservationError("audio");
    return hash;
  };
  const audioSha256 = await audioHash(input.sourcePath);
  if (audioSha256 !== (await audioHash(path))) throw new StudioClosingPreservationError("audio");
  async function similarity(caption: boolean) {
    const stats = join(directory, caption ? "caption-ssim.txt" : "body-ssim.txt");
    const filter = caption
      ? `crop=1080:${1920 - STUDIO_SUBTITLE_TOP}:0:${STUDIO_SUBTITLE_TOP}`
      : `trim=end=${startMs / 1000 - tailStart}`;
    if (!caption && startMs / 1000 === tailStart) return 1;
    // Both inputs are private, hash-verified MP4s; the generated comparison file has no external references.
    await execute(input.sourcePath, [
      "-v",
      "error",
      "-ss",
      String(tailStart),
      "-i",
      "__SOURCE__",
      "-ss",
      String(tailStart),
      "-i",
      path,
      "-filter_complex_threads",
      "1",
      "-filter_complex",
      `[0:v]${filter},setpts=PTS-STARTPTS[a];[1:v]${filter},setpts=PTS-STARTPTS[b];[a][b]ssim=stats_file='${stats.replaceAll("'", "\\'")}'`,
      "-an",
      "-f",
      "null",
      "-",
    ]);
    const values = [...(await readFile(stats, "utf8")).matchAll(/All:([\d.]+)/g)].map((m) =>
      Number(m[1]),
    );
    // A very short clip may have no picture before the card. Caption/audio checks still apply.
    if (!values.length && !caption && startMs === 0) return 1;
    if (!values.length || values.some((n) => !Number.isFinite(n) || n < 0.995))
      throw new StudioClosingPreservationError(
        caption ? "captions" : "picture",
        values.length ? Math.min(...values) : 0,
      );
    return Math.min(...values);
  }
  const minimumFrameSsim = await similarity(false);
  const minimumCaptionSsim = await similarity(true);
  const framePath = join(directory, "closing-proof.png");
  await execute(path, [
    "-v",
    "error",
    "-y",
    "-ss",
    String((input.endMs - 1000) / 1000),
    "-i",
    "__SOURCE__",
    "-frames:v",
    "1",
    "-update",
    "1",
    framePath,
  ]);
  const region = { left: 100, top: 240, width: 800, height: 1120 };
  const expected = await sharp(input.card).extract(region).removeAlpha().raw().toBuffer();
  const actual = await sharp(await readFile(framePath))
    .extract(region)
    .removeAlpha()
    .raw()
    .toBuffer();
  let difference = 0;
  for (let index = 0; index < actual.length; index++)
    difference += Math.abs((actual[index] ?? 0) - (expected[index] ?? 0));
  const cardMeanAbsoluteDifference = difference / actual.length;
  if (actual.length !== expected.length || cardMeanAbsoluteDifference >= 4)
    throw new StudioClosingPreservationError("card", cardMeanAbsoluteDifference);
  return {
    path,
    audioSha256,
    minimumFrameSsim,
    minimumCaptionSsim,
    cardMeanAbsoluteDifference,
    splice,
  };
}

/** Closing copy changes operate on the reviewed export, never on the raw recording. */
export async function refreshStudioClosingCards(input: {
  claim: StudioGenerationClaim;
  store: PrivateAssetStore;
  env: Record<string, string | undefined>;
  appLinks?: StudioAppLinks;
  closingDestinations?: Record<string, "app" | "youtube">;
  signal?: AbortSignal;
  checkpoints?: StudioCheckpoints;
}) {
  const { claim } = input;
  const pkg = claim.package;
  if (!pkg.provenance || pkg.approval || claim.source.sha256 !== pkg.source.sha256)
    throw Error("SOURCE_DEPENDENCY_CHANGED");
  return {
    outputs: await refreshStudioClosingOutputs({ ...input, pkg }),
    provenance: pkg.provenance,
  };
}

/** Also used for uncommitted preview checkpoints. This never promotes them to draft outputs. */
export async function refreshStudioClosingOutputs(input: {
  pkg: StudioPackage;
  store: PrivateAssetStore;
  env: Record<string, string | undefined>;
  appLinks?: StudioAppLinks;
  closingDestinations?: Record<string, "app" | "youtube">;
  signal?: AbortSignal;
  checkpoints?: StudioCheckpoints;
}) {
  const { pkg, store, env, signal, checkpoints } = input;
  if (pkg.approval) throw Error("SOURCE_DEPENDENCY_CHANGED");
  const scratch = env.STUDIO_SCRATCH_ROOT ?? env.DISTRIBUTION_ASSET_ROOT;
  if (!scratch || !isAbsolute(scratch)) throw Error("STUDIO_PRIVATE_SCRATCH_REQUIRED");
  const outputs: StudioOutput[] = [];
  for (const prior of pkg.outputs) {
    if (
      !prior.asset ||
      !prior.presentationReview ||
      !prior.aiReview ||
      prior.startMs == null ||
      prior.endMs == null ||
      !["short", "reel"].includes(prior.format)
    )
      throw Error("STUDIO_PRESENTATION_REVIEW_INVALID");
    const durationMs = prior.endMs - prior.startMs;
    validateStudioPresentationReview(prior.presentationReview, {
      sourceSha256: pkg.source.sha256,
      renderedSha256: prior.asset.sha256,
      fileVersion: prior.fileVersion ?? 1,
      durationMs,
    });
    validateStudioAiReviewEvidence(prior.aiReview, {
      ...prior,
      fileVersion: prior.fileVersion ?? 1,
      sourceSha256: pkg.source.sha256,
    });
    const destination = pkg.request.youtubeClosing
      ? "youtube"
      : (input.closingDestinations?.[prior.id] ??
        prior.closingDestination ??
        prior.presentationReview.closingCard?.destination ??
        "app");
    const plan = studioClosingCardPlan(durationMs, {
      destination,
      ...(input.appLinks ? { appLinks: input.appLinks } : {}),
      ...(pkg.request.youtubeClosing ? { youtubeClosing: pkg.request.youtubeClosing } : {}),
      ...(pkg.request.sourceBranding ? { sourceBranding: pkg.request.sourceBranding } : {}),
    });
    // Old timelines with a different hold need the explicit full-render action. Never trim speech.
    if (
      prior.presentationReview.closingCard?.endMs !== plan.endMs ||
      prior.presentationReview.closingCard.startMs !== plan.startMs ||
      plan.endMs > studioVideoDurationLimitMs(prior.channel)
    )
      throw Error("STUDIO_CLOSING_TIMELINE_CHANGED");
    const photo = await readFile(
      new URL("../assets/sri-bala-swamiji-portrait.jpg", import.meta.url),
    );
    const logo =
      destination === "app"
        ? await readFile(new URL("../assets/sannidhi-app-icon.png", import.meta.url))
        : pkg.request.sourceBranding === "bala-swamiji"
          ? photo
          : await readFile(
              env.STUDIO_BRAND_LOGO_PATH ??
                new URL("../assets/sri-bala-swamiji-portrait.jpg", import.meta.url),
            );
    const card = await studioClosingCard(
      logo,
      "forest",
      destination,
      pkg.request.youtubeClosing,
      pkg.request.sourceBranding,
    );
    const fingerprint = studioFingerprint({
      policy: "preserved-export-closing-v1",
      prior,
      plan,
      card: sha(card),
    });
    const cacheKey = `preserved-closing:${prior.id}`;
    const cached = checkpoints?.get<StudioOutput>(cacheKey, fingerprint);
    if (
      cached?.asset &&
      sha(await store.readDerivedDescriptor(cached.asset)) === cached.asset.sha256
    ) {
      outputs.push(cached);
      continue;
    }
    await checkpoints?.progress({
      phase: "rendering",
      provider: "local",
      completed: outputs.length,
      total: pkg.outputs.length,
      channel: prior.channel,
      language: prior.language,
    });
    const directory = await createPrivateRenderScratch(scratch);
    try {
      const bytes = await store.readDerivedDescriptor(prior.asset);
      if (sha(bytes) !== prior.asset.sha256) throw Error("INVALID_STUDIO_ASSET");
      const sourcePath = join(directory, "reviewed-export.mp4");
      await writeFile(sourcePath, bytes, { mode: 0o600 });
      const result = await replaceStudioClosingCard({
        sourcePath,
        directory,
        ffmpeg: env.DISTRIBUTION_FFMPEG_PATH ?? "ffmpeg",
        card,
        startMs: plan.startMs,
        endMs: plan.endMs,
        ...(signal ? { signal } : {}),
      });
      const rendered = await readFile(result.path);
      const fileVersion = (prior.fileVersion ?? 1) + 1;
      const identity = {
        fileVersion,
        renderId: randomUUID().slice(0, 8),
        masterId: pkg.source.masterId,
        sourceVersionId: pkg.source.versionId,
        packageId: pkg.id,
        outputId: prior.id,
        channel: prior.channel,
        format: prior.format,
        language: prior.language,
        aspect: prior.aspect,
      };
      const name = studioAssetName(identity, "mp4");
      const asset = await saveSharedStudioAsset(
        store,
        {
          ...name,
          sha256: sha(rendered),
          byteSize: rendered.length,
          mimeType: "video/mp4",
        },
        rendered,
      );
      let thumbnail = prior.thumbnail;
      if (thumbnail) {
        const bytes = await store.readDerivedDescriptor(thumbnail);
        if (sha(bytes) !== thumbnail.sha256) throw Error("INVALID_STUDIO_ASSET");
        thumbnail = await saveSharedStudioAsset(
          store,
          {
            ...studioAssetName(identity, "png"),
            sha256: thumbnail.sha256,
            byteSize: thumbnail.byteSize,
            mimeType: thumbnail.mimeType,
          },
          bytes,
        );
      }
      const verifiedAt = new Date().toISOString();
      const closingRefresh: NonNullable<StudioPresentationReview["closingRefresh"]> = {
        policy: "preserved-export-closing-v1",
        previousSha256: prior.asset.sha256,
        previousFileVersion: prior.fileVersion ?? 1,
        cardSha256: sha(card),
        verifiedAt,
        unchangedUntilMs: plan.startMs,
        audioSha256: result.audioSha256,
        minimumFrameSsim: result.minimumFrameSsim,
        minimumCaptionSsim: result.minimumCaptionSsim,
        cardMeanAbsoluteDifference: result.cardMeanAbsoluteDifference,
        splice: {
          method: "h264-tail-copy-v1",
          startMs: result.splice.splitSeconds * 1000,
          copiedPackets: result.splice.copiedPackets,
          encodedPackets: result.splice.encodedPackets,
          ...(result.splice.prefixSha256 ? { prefixSha256: result.splice.prefixSha256 } : {}),
          timingSha256: result.splice.timingSha256,
        },
      };
      const output: StudioOutput = {
        ...prior,
        asset,
        ...(thumbnail ? { thumbnail } : {}),
        fileVersion,
        generatedAt: verifiedAt,
        closingDestination: destination,
        // Retain the original AI review date and findings; this is not a new editorial AI review.
        aiReview: { ...prior.aiReview, fileVersion },
        presentationReview: {
          ...prior.presentationReview,
          closingCard: plan,
          closingRefresh,
          renderedSha256: asset.sha256,
          fileVersion,
        },
      };
      if (!output.presentationReview) throw Error("STUDIO_PRESENTATION_REVIEW_INVALID");
      validateStudioPresentationReview(output.presentationReview, {
        sourceSha256: pkg.source.sha256,
        renderedSha256: asset.sha256,
        fileVersion,
        durationMs,
      });
      await checkpoints?.set(cacheKey, fingerprint, output);
      outputs.push(output);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return outputs;
}
