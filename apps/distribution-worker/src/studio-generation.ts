import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { PrivateAssetStore } from "@satsang/distribution-assets";
import {
  type StudioGenerationClaim,
  loadStudioProviderConfig,
  studioSettingsPath,
} from "@satsang/distribution-db";
import {
  STUDIO_AUDIO_POLICY,
  STUDIO_BOUNDARY_EVIDENCE_POLICY,
  STUDIO_BOUNDARY_REVIEW_POLICY,
  STUDIO_CLOSING_CARD_POLICY,
  STUDIO_ICONOGRAPHY_POLICY,
  STUDIO_OPENING_CARD_POLICY,
  STUDIO_POST_ART_POLICY,
  STUDIO_PRESENTATION_POLICY,
  STUDIO_PRESENTATION_REVIEWER_VERSION,
  STUDIO_RENDERER_VERSION,
  STUDIO_SINGLE_TRANSCRIPTION_MS,
  STUDIO_SOURCE_FRAMING_POLICY,
  STUDIO_STORYBOARD_CONTINUITY_POLICY,
  STUDIO_VIDEO_ILLUSTRATION_POLICY,
  STUDIO_VISUAL_STYLE_POLICY,
  type StudioAiReviewEvidence,
  type StudioAppLinks,
  type StudioAsset,
  type StudioBoundaryReview,
  type StudioContentReview,
  type StudioIllustrationTiming,
  type StudioLanguage,
  type StudioOutput,
  type StudioPlan,
  type StudioPresentationReview,
  type StudioProvenance,
  type StudioSourceScreen,
  type StudioTranscript,
  applyStudioBoundaryReview,
  assertStudioDiscoveryIsolation,
  canExcludeRenderedStudioCandidate,
  enforceStudioPlanBranding,
  preserveStudioEditorialEdits,
  retimeStudioIllustrations,
  safeStudioPortraitScenes,
  selectInitialStudioCandidates,
  studioAppLinks,
  studioAssetName,
  studioBoundaryPasses,
  studioCaptionsEnabled,
  studioCardStyle,
  studioClosingCardPlan,
  studioContentReviewIssues,
  studioDiscoveryOverlaps,
  studioFullPictureRegion,
  studioGenerationReadiness,
  studioOpeningCardPlan,
  studioOutputKey,
  studioScopedGenerationProgress,
  studioSelectedMessageGroups,
  studioSourceBranding,
  studioSourceRange,
  studioVideoDurationLimitMs,
  studioVisualPreference,
  validateStudioMessagePassages,
  validateStudioOutputs,
  validateStudioPlan,
  validateStudioPresentationReview,
  validateStudioProvenance,
  validateStudioSourceScreen,
} from "@satsang/distribution-domain";
import { createPrivateRenderScratch } from "./renderer.js";
import { transcribeAdaptiveSarvam } from "./studio-adaptive-transcription.js";
import { createStudioReviewAudio } from "./studio-analysis-audio.js";
import { reviewStudioClipBoundaries } from "./studio-boundary-review.js";
import {
  type StudioCheckpoints,
  generateCheckpointedStudioPlan,
  studioFingerprint,
} from "./studio-checkpoints.js";
import { refreshStudioClosingCards } from "./studio-closing-refresh.js";
import {
  STUDIO_EDITORIAL_REVIEW_POLICY,
  StudioContentQualityError,
  reviewStudioContent,
} from "./studio-content-review.js";
import {
  STUDIO_CONTEXT_IMAGE_MODEL,
  studioContextIllustrationShots,
} from "./studio-context-images.js";
import { studioClosingCard, studioOpeningCard } from "./studio-ending.js";
import { normalizeStudioTranscription, transcribeStudioAudio } from "./studio-intelligence.js";
import {
  STUDIO_VIDEO_FRAME,
  renderStudioVideo,
  studioArtwork,
  studioCaptionPages,
  studioVideoThumbnail,
  studioVtt,
} from "./studio-media.js";
import { createStudioIllustratedPost } from "./studio-post-art.js";
import {
  reviewStudioPresentation,
  screenStudioSource,
  studioReviewFramePairs,
  studioReviewProxy,
} from "./studio-presentation-review.js";
import { executeStudioSource, validateStudioSourceDimensions } from "./studio-process.js";
import { saveSharedStudioAsset } from "./studio-shared-assets.js";

const run = promisify(execFile);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Env = Record<string, string | undefined>;
async function privateJson(path: string, maximum = 20 * 1024 * 1024): Promise<unknown> {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await f.stat();
    if (!s.isFile() || s.size > maximum || (s.mode & 0o077) !== 0)
      throw new Error("STUDIO_CACHE_INVALID");
    return JSON.parse(await f.readFile("utf8"));
  } finally {
    await f.close();
  }
}
async function sourceAudio(
  claim: StudioGenerationClaim,
  sourcePath: string,
  directory: string,
  env: Env,
  signal?: AbortSignal,
): Promise<Buffer> {
  const path = join(directory, "source.mp3");
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await executeStudioSource({
    executable: env.DISTRIBUTION_FFMPEG_PATH ?? "ffmpeg",
    sourcePath,
    mimeType: claim.source.mimeType,
    directory,
    timeoutMs: 180000,
    ...(signal ? { signal } : {}),
    args: [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-n",
      "-i",
      "__SOURCE__",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      "24k",
      path,
    ],
  });
  return readFile(path);
}
async function transcriptFor(
  claim: StudioGenerationClaim,
  sourcePath: string,
  directory: string,
  durationMs: number,
  env: Env,
  signal?: AbortSignal,
  checkpoints?: StudioCheckpoints,
  transcriptFingerprint?: string,
): Promise<StudioTranscript> {
  if (claim.transcript) return claim.transcript;
  if (
    env.STUDIO_TRANSCRIPTION_PROVIDER &&
    !["openai", "sarvam"].includes(env.STUDIO_TRANSCRIPTION_PROVIDER)
  )
    throw new Error("STUDIO_TRANSCRIPTION_PROVIDER_UNSUPPORTED");
  if (
    !env.STUDIO_TRANSCRIPTION_PROVIDER &&
    env.STUDIO_TRANSCRIPT_CACHE_ROOT &&
    isAbsolute(env.STUDIO_TRANSCRIPT_CACHE_ROOT)
  ) {
    try {
      const cache = (await privateJson(
        join(env.STUDIO_TRANSCRIPT_CACHE_ROOT, `${claim.package.source.sha256}.json`),
      )) as { sourceSha256?: string; raw?: unknown };
      if (cache.sourceSha256 !== claim.package.source.sha256)
        throw new Error("STUDIO_CACHE_SOURCE_MISMATCH");
      return normalizeStudioTranscription(cache.raw, claim.package.source.language, durationMs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  if (["openai", "sarvam"].includes(env.STUDIO_TRANSCRIPTION_PROVIDER ?? "")) {
    if (!claim.externalProcessing.allowed)
      throw new Error("STUDIO_EXTERNAL_PROCESSING_NOT_AUTHORIZED");
    const provider = env.STUDIO_TRANSCRIPTION_PROVIDER;
    const apiKey = provider === "sarvam" ? env.STUDIO_SARVAM_API_KEY : env.STUDIO_OPENAI_API_KEY;
    if (!apiKey) throw new Error("TRANSCRIPTION_NOT_CONFIGURED");
    const input = {
      language: claim.package.source.language,
      durationMs,
      apiKey,
      fetcher: fetch,
      ...(signal ? { signal } : {}),
    };
    if (provider === "sarvam") {
      let keyterms: string[] | undefined;
      if (env.STUDIO_SARVAM_KEYTERMS) {
        try {
          const raw: unknown = JSON.parse(env.STUDIO_SARVAM_KEYTERMS);
          if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string")) throw new Error();
          keyterms = raw;
        } catch {
          throw new Error("STUDIO_SARVAM_KEYTERMS_INVALID");
        }
      }
      return transcribeAdaptiveSarvam({
        sourcePath,
        mimeType: claim.source.mimeType,
        directory,
        ffmpeg: env.DISTRIBUTION_FFMPEG_PATH ?? "ffmpeg",
        durationMs,
        fingerprint:
          transcriptFingerprint ??
          studioFingerprint({ source: claim.source.sha256, language: input.language }),
        ...(checkpoints ? { checkpoints } : {}),
        audio: () => sourceAudio(claim, sourcePath, directory, env, signal),
        provider: {
          ...input,
          model: env.STUDIO_SARVAM_MODEL ?? "saaras:v4",
          ...(keyterms ? { keyterms } : {}),
        },
      });
    }
    return {
      ...(await transcribeStudioAudio({
        ...input,
        bytes: await sourceAudio(claim, sourcePath, directory, env, signal),
      })),
      recognition: { provider: "openai", model: "whisper-1" },
    };
  }
  if (env.STUDIO_WHISPER_COMMAND && isAbsolute(env.STUDIO_WHISPER_COMMAND)) {
    const output = join(directory, "transcription.json");
    // Operator-owned executable. No shell expansion or model-selected command/path is used.
    await run(
      env.STUDIO_WHISPER_COMMAND,
      ["--input", sourcePath, "--language", claim.package.source.language, "--output", output],
      { timeout: 1200000, maxBuffer: 1024 * 1024, ...(signal ? { signal } : {}) },
    );
    const raw = await privateJson(output);
    return normalizeStudioTranscription(raw, claim.package.source.language, durationMs);
  }
  throw new Error("TRANSCRIPTION_NOT_CONFIGURED");
}

export async function generateStudioPackage(input: {
  visualPreference?: string;
  appLinks?: StudioAppLinks;
  renderOnly?: boolean;
  closingOnly?: boolean;
  steadyOpening?: true;
  closingDestinations?: Record<string, "app" | "youtube">;
  illustrationTimings?: StudioIllustrationTiming[];
  applyAiCorrections?: boolean;
  retainedOutputs?: StudioPlan["outputs"];
  discoveryExcludedOutputs?: StudioPlan["outputs"];
  claim: StudioGenerationClaim;
  store: PrivateAssetStore;
  env: Env;
  signal?: AbortSignal;
  checkpoints?: StudioCheckpoints;
}): Promise<{ outputs: StudioOutput[]; provenance: StudioProvenance }> {
  const { claim, store, env, signal, checkpoints } = input;
  const sourceBrand = studioSourceBranding(claim.package.request.sourceBranding);
  const visualPreference = studioVisualPreference(
    input.visualPreference ??
      (
        await loadStudioProviderConfig(
          studioSettingsPath(env, claim.package.isTest),
          env.STUDIO_CHANNEL_CONFIG_KEY,
        )
      ).visualPreference,
  );
  const appLinks =
    input.appLinks ??
    (
      await loadStudioProviderConfig(
        studioSettingsPath(env, claim.package.isTest),
        env.STUDIO_CHANNEL_CONFIG_KEY,
      )
    ).appLinks;
  const scope = claim.package.generation;
  if (input.closingOnly && !input.steadyOpening && !input.illustrationTimings?.length) {
    return refreshStudioClosingCards({ ...input, ...(appLinks ? { appLinks } : {}) });
  }
  if (scope?.mode === "discover") {
    const previous = claim.package;
    const result = await generateStudioPackage({
      ...input,
      discoveryExcludedOutputs: previous.outputs,
      claim: {
        ...claim,
        transcript: claim.transcript ?? previous.provenance?.transcript ?? null,
        package: { ...previous, generation: null, outputs: [] },
      },
    });
    if (
      previous.provenance &&
      studioFingerprint(previous.provenance.transcript) !==
        studioFingerprint(result.provenance.transcript)
    )
      throw Error("SOURCE_DEPENDENCY_CHANGED");
    for (const [index, extra] of result.outputs.entries()) {
      const prior = [
        ...previous.outputs,
        ...result.outputs.slice(0, index).filter((o) => o.messageId !== extra.messageId),
      ];
      if (studioDiscoveryOverlaps(extra, prior, result.provenance.transcript))
        throw Error("DUPLICATE_STUDIO_PASSAGE");
    }
    const outputs = [...previous.outputs, ...result.outputs];
    assertStudioDiscoveryIsolation(previous.outputs, outputs);
    validateStudioMessagePassages(outputs);
    if (!outputs.length) throw Error("STUDIO_NO_SUITABLE_CHANNELS");
    return {
      outputs,
      provenance: {
        ...(previous.provenance ?? result.provenance),
        draftingProviders: [
          ...new Map(
            [
              ...(previous.provenance?.draftingProviders ?? []),
              ...(result.provenance.draftingProviders ?? []),
            ].map((p) => [p.provider, p]),
          ).values(),
        ],
        ...(result.provenance.discovery ? { discovery: result.provenance.discovery } : {}),
        excludedMessages: [
          ...(previous.provenance?.excludedMessages ?? []),
          ...(result.provenance.excludedMessages ?? []),
        ],
      },
    };
  }
  if (scope) {
    const targets = claim.package.outputs.filter((o) => scope.outputIds.includes(o.id));
    if (!targets.length || targets.length !== scope.outputIds.length)
      throw new Error("STUDIO_SELECT_OUTPUTS");
    const replacements = new Map<string, StudioOutput>();
    let provenance = claim.package.provenance;
    const groups = studioSelectedMessageGroups(targets);
    for (const selected of groups) {
      let groupCompleted = 0;
      const targetKey =
        selected.length === 1
          ? (selected[0]?.id ?? "")
          : studioFingerprint(selected.map((output) => output.id).sort()).slice(0, 40);
      const scoped = {
        ...claim.package,
        generation: null,
        outputs: selected,
        request: {
          ...claim.package.request,
          youtubeFormat: selected.some((output) => output.format === "video")
            ? ("video" as const)
            : ("short" as const),
          channels: [...new Set(selected.map((output) => output.channel))],
          languages: [...new Set(selected.map((output) => output.language))],
        },
        feedback: selected.flatMap((prior) =>
          prior.correction
            ? [
                {
                  id: prior.id,
                  actorId: prior.correction.reviewerId,
                  action: "REJECTED" as const,
                  comment: prior.correction.comment,
                  revision: claim.package.revision,
                  createdAt: prior.correction.requestedAt,
                },
              ]
            : [],
        ),
      };
      const result = await generateStudioPackage({
        ...input,
        visualPreference,
        appLinks: studioAppLinks(appLinks),
        // Each selected file resumes its own reviewed draft and render after an interruption.
        ...(checkpoints
          ? {
              checkpoints: {
                get: <T>(key: string, fingerprint: string) =>
                  checkpoints.get<T>(`correction:${targetKey}:${key}`, fingerprint),
                set: (key: string, fingerprint: string, value: unknown) =>
                  checkpoints.set(
                    key.startsWith("media-verification:") ? key : `correction:${targetKey}:${key}`,
                    fingerprint,
                    value,
                  ),
                progress: async (value) => {
                  const merged = studioScopedGenerationProgress(value, {
                    finished: replacements.size,
                    groupSize: selected.length,
                    groupCompleted,
                    total: targets.length,
                  });
                  groupCompleted = merged.groupCompleted;
                  await checkpoints.progress(merged.progress);
                },
              },
            }
          : {}),
        renderOnly: scope.mode !== "ai",
        closingOnly: scope.mode === "closing",
        ...(scope.closingDestinations ? { closingDestinations: scope.closingDestinations } : {}),
        ...(scope.steadyOpening ? { steadyOpening: true } : {}),
        ...(scope.illustrationTimings ? { illustrationTimings: scope.illustrationTimings } : {}),
        applyAiCorrections: scope.mode === "ai",
        retainedOutputs: claim.package.outputs
          .filter((output) => !selected.some((target) => target.id === output.id))
          .map((output) => replacements.get(output.id) ?? output),
        claim: {
          ...claim,
          package: scoped,
          transcript: claim.transcript ?? claim.package.provenance?.transcript ?? null,
        },
      });
      if (result.outputs.length !== selected.length)
        throw new Error("STUDIO_EDITED_OUTPUT_OMITTED");
      for (const prior of selected) {
        const replacement = result.outputs.find(
          (o) => studioOutputKey(o) === studioOutputKey(prior),
        );
        if (!replacement) throw new Error("STUDIO_EDITED_OUTPUT_OMITTED");
        replacements.set(prior.id, {
          ...replacement,
          id: prior.id,
          ...(prior.correction && scope.mode !== "closing"
            ? { correction: { ...prior.correction, state: "revised" } }
            : {}),
        });
      }
      if (
        claim.package.provenance &&
        studioFingerprint(result.provenance.transcript) !==
          studioFingerprint(claim.package.provenance.transcript)
      )
        throw new Error("SOURCE_DEPENDENCY_CHANGED");
      const baseProvenance = provenance ?? result.provenance;
      const used = new Map(
        [
          ...(baseProvenance.draftingProviders ?? []),
          ...(result.provenance.draftingProviders ?? []),
        ].map((entry) => [entry.provider, entry]),
      );
      provenance = {
        ...baseProvenance,
        ...(used.size ? { draftingProviders: [...used.values()] } : {}),
      };
    }
    if (!provenance) throw new Error("GENERATION_REQUIRED");
    const outputs = claim.package.outputs.map((o) => replacements.get(o.id) ?? o);
    if (claim.package.request.allCompleteMessages) validateStudioMessagePassages(outputs);
    return { outputs, provenance };
  }
  const readiness = studioGenerationReadiness(env);
  if (!readiness.available) throw new Error("GENERATION_NOT_CONFIGURED");
  const scratch = env.STUDIO_SCRATCH_ROOT ?? env.DISTRIBUTION_ASSET_ROOT;
  if (!scratch || !isAbsolute(scratch)) throw new Error("STUDIO_PRIVATE_SCRATCH_REQUIRED");
  const directory = await createPrivateRenderScratch(scratch);
  try {
    await checkpoints?.progress({ phase: "source", provider: "local", completed: 0, total: 1 });
    if (claim.source.sha256 !== claim.package.source.sha256)
      throw new Error("SOURCE_INTEGRITY_FAILED");
    const sourcePath = join(
      directory,
      claim.source.mimeType === "video/mp4" ? "source.mp4" : "source-audio",
    );
    if (store.materialize) await store.materialize(claim.source, sourcePath);
    else {
      const bytes = await store.read(claim.source);
      if (sha(bytes) !== claim.package.source.sha256) throw Error("SOURCE_INTEGRITY_FAILED");
      await writeFile(sourcePath, bytes, { mode: 0o600 });
    }
    const stdout = await executeStudioSource({
      executable: env.DISTRIBUTION_FFPROBE_PATH ?? "ffprobe",
      sourcePath,
      mimeType: claim.source.mimeType,
      directory,
      timeoutMs: 30000,
      ...(signal ? { signal } : {}),
      args: [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type,width,height",
        "-of",
        "json",
        "-i",
        "__SOURCE__",
      ],
    });
    const media = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: { codec_type?: string; width?: number; height?: number }[];
    };
    const durationMs = Math.round(Number(media.format?.duration) * 1000);
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 86400000)
      throw new Error("STUDIO_MEDIA_DURATION_INVALID");
    validateStudioSourceDimensions(media.streams ?? []);
    const hasVideo = Boolean(media.streams?.some((s) => s.codec_type === "video"));
    const hasAudio = Boolean(media.streams?.some((s) => s.codec_type === "audio"));
    const provider =
      env.STUDIO_INTELLIGENCE_PROVIDER === "gemini"
        ? "gemini"
        : env.STUDIO_INTELLIGENCE_PROVIDER === "openai"
          ? "openai"
          : "local";
    if (provider !== "local" && !claim.externalProcessing.allowed)
      throw new Error("STUDIO_EXTERNAL_PROCESSING_NOT_AUTHORIZED");
    const apiKey = provider === "gemini" ? env.STUDIO_GEMINI_API_KEY : env.STUDIO_OPENAI_API_KEY;
    const model = provider === "gemini" ? env.STUDIO_GEMINI_MODEL : env.STUDIO_OPENAI_MODEL;
    if (provider !== "local" && (!apiKey?.trim() || !model?.trim()))
      throw new Error("STUDIO_INTELLIGENCE_NOT_CONFIGURED");
    // Retain complete audio for ASR. The Gemini inline limit is a request limit,
    // not a master-duration limit: long masters use selected audio windows below.
    const sourceAudioBytes =
      provider === "gemini" && hasAudio && durationMs <= STUDIO_SINGLE_TRANSCRIPTION_MS
        ? await sourceAudio(claim, sourcePath, directory, env, signal)
        : undefined;
    if (sourceAudioBytes && sourceAudioBytes.length < 1)
      throw new Error("STUDIO_AUDIO_INVALID_OR_TOO_LARGE");
    const originalAudio =
      sourceAudioBytes && sourceAudioBytes.length <= 12 * 1024 * 1024
        ? sourceAudioBytes
        : undefined;
    const transcriptFingerprint = studioFingerprint({
      source: claim.package.source.sha256,
      language: claim.package.source.language,
      durationMs,
      approved: claim.transcript,
      provider: env.STUDIO_TRANSCRIPTION_PROVIDER,
      model: env.STUDIO_SARVAM_MODEL,
      keyterms: env.STUDIO_SARVAM_KEYTERMS,
      version: 1,
      ...(durationMs > STUDIO_SINGLE_TRANSCRIPTION_MS ? { sectionPolicy: "bounded-asr-v1" } : {}),
    });
    await checkpoints?.progress({
      phase: "transcription",
      provider:
        env.STUDIO_TRANSCRIPTION_PROVIDER === "sarvam"
          ? "sarvam"
          : env.STUDIO_TRANSCRIPTION_PROVIDER === "openai"
            ? "openai"
            : "local",
      completed: 0,
      total: 1,
    });
    const transcript =
      claim.transcript ??
      checkpoints?.get<StudioTranscript>("transcript", transcriptFingerprint) ??
      (await transcriptFor(
        claim,
        sourcePath,
        directory,
        durationMs,
        env,
        signal,
        checkpoints,
        transcriptFingerprint,
      ));
    await checkpoints?.set("transcript", transcriptFingerprint, transcript);
    if (transcript.durationMs > durationMs + 1000)
      throw new Error("STUDIO_TRANSCRIPT_DURATION_MISMATCH");
    const reviewAudio =
      provider === "gemini" && hasAudio
        ? createStudioReviewAudio({
            sourcePath,
            mimeType: claim.source.mimeType,
            directory,
            ffmpeg: env.DISTRIBUTION_FFMPEG_PATH ?? "ffmpeg",
            transcript,
            ...(signal ? { signal } : {}),
          })
        : undefined;
    const logoPath = env.STUDIO_BRAND_LOGO_PATH;
    if (sourceBrand.portrait && (!logoPath || !isAbsolute(logoPath)))
      throw new Error("BRAND_NOT_CONFIGURED");
    const logo = sourceBrand.portrait && logoPath ? await readFile(logoPath) : Buffer.alloc(0);
    const postLogo =
      claim.package.request.sourceBranding === "bala-swamiji"
        ? await readFile(new URL("../assets/sri-bala-swamiji-portrait.jpg", import.meta.url))
        : logo;
    const appLogo = await readFile(new URL("../assets/sannidhi-app-icon.png", import.meta.url));
    if (logo.length > 5 * 1024 * 1024) throw new Error("BRAND_NOT_CONFIGURED");
    let analyzedAudio = false;
    const aiReviews = new Map<string, Omit<StudioAiReviewEvidence, "fileVersion">>();
    const recordReviews = (
      checks: StudioContentReview[],
      evidence: {
        provider: "gemini" | "openai";
        model: string;
        audioIncluded: boolean;
        reviewedAt?: string;
      },
    ) => {
      for (const check of checks)
        aiReviews.set(studioOutputKey(check), {
          status: "PASSED",
          policyVersion: "content-integrity-v1",
          provider: evidence.provider,
          model: evidence.model,
          recordedAt: new Date().toISOString(),
          ...(evidence.reviewedAt ? { reviewedAt: evidence.reviewedAt } : {}),
          inputMode: evidence.audioIncluded ? "transcript_and_audio" : "transcript",
          sourceSha256: claim.package.source.sha256,
          humanFeedbackConsidered: claim.package.feedback.some((f) => f.action === "REJECTED"),
          checks: check,
        });
    };
    const draftingProviders: NonNullable<StudioProvenance["draftingProviders"]> = [];
    const fallback =
      env.STUDIO_FALLBACK_ENABLED === "true" && env.STUDIO_OPENAI_API_KEY && env.STUDIO_OPENAI_MODEL
        ? {
            provider: "openai" as const,
            apiKey: env.STUDIO_OPENAI_API_KEY,
            model: env.STUDIO_OPENAI_MODEL,
          }
        : undefined;
    const imageModel = env.STUDIO_GEMINI_IMAGE_MODEL ?? STUDIO_CONTEXT_IMAGE_MODEL;
    // Keep long review proxies on private scratch disk, not one large Buffer per candidate.
    const screenCache = new Map<string, { screen: StudioSourceScreen; proxyPath: string }>();
    const videoConnection = {
      apiKey: env.STUDIO_GEMINI_API_KEY ?? "",
      model: env.STUDIO_GEMINI_MODEL ?? "",
      ...(signal ? { signal } : {}),
    };
    const screenSource = async (planned: StudioPlan["outputs"][number]) => {
      if (!videoConnection.apiKey || !videoConnection.model)
        throw Error("STUDIO_PRESENTATION_NOT_CONFIGURED");
      const range = studioSourceRange(
        planned.sourceSegmentIds,
        transcript,
        planned.format,
        planned.sourceTrim,
      );
      const fingerprint = studioFingerprint({
        editorialReview: STUDIO_EDITORIAL_REVIEW_POLICY,
        openingPolicy: STUDIO_OPENING_CARD_POLICY,
        sourceSpeaker: sourceBrand,
        policy: STUDIO_PRESENTATION_POLICY,
        framingPolicy: STUDIO_SOURCE_FRAMING_POLICY,
        storyboard: "context-rich-v2",
        storyboardContinuity: STUDIO_STORYBOARD_CONTINUITY_POLICY,
        illustrationSelection: STUDIO_VIDEO_ILLUSTRATION_POLICY,
        iconography: STUDIO_ICONOGRAPHY_POLICY,
        illustrationStyle: visualPreference,
        visualStylePolicy: STUDIO_VISUAL_STYLE_POLICY,
        source: claim.source.sha256,
        start: range.startMs,
        end: range.endMs,
        feedback: claim.package.feedback,
        model: videoConnection.model,
      });
      const cached = screenCache.get(fingerprint);
      if (cached) return cached;
      const proxy = await studioReviewProxy({
        ffmpeg: env.DISTRIBUTION_FFMPEG_PATH ?? "ffmpeg",
        sourcePath,
        directory,
        startMs: range.startMs,
        endMs: range.endMs,
        filename: `source-review-${fingerprint}.mp4`,
        ...(signal ? { signal } : {}),
      });
      let screen = checkpoints?.get<StudioSourceScreen>(
        `source-screen:${fingerprint}`,
        fingerprint,
      );
      if (screen) {
        try {
          screen = validateStudioSourceScreen(screen, range.endMs - range.startMs, {
            segments: range.segments,
            clipStartMs: range.startMs,
          });
        } catch {
          // Old checkpoints may contain an invalid storyboard. Repair through
          // the same bounded source-screening path before generating paid images.
          screen = undefined;
        }
      }
      if (!screen) {
        const first = transcript.segments.findIndex((s) => s.id === range.segments[0]?.id);
        const last = transcript.segments.findIndex((s) => s.id === range.segments.at(-1)?.id);
        screen = await screenStudioSource({
          ...videoConnection,
          video: proxy,
          durationMs: range.endMs - range.startMs,
          segments: range.segments,
          clipStartMs: range.startMs,
          context: {
            illustrationStyle: visualPreference,
            visualStylePolicy: STUDIO_VISUAL_STYLE_POLICY,
            sourceTitle: claim.package.source.title,
            sourceSpeaker: sourceBrand,
            language: transcript.language,
            selectedRange: range,
            surroundingSegments: transcript.segments.slice(Math.max(0, first - 2), last + 3),
            humanFeedback: claim.package.feedback
              .filter((f) => f.action === "REJECTED")
              .map((f) => f.comment),
          },
        });
        await checkpoints?.set(`source-screen:${fingerprint}`, fingerprint, screen);
      }
      const result = { screen, proxyPath: join(directory, `source-review-${fingerprint}.mp4`) };
      screenCache.set(fingerprint, result);
      return result;
    };
    const boundaryCache = new Map<string, StudioBoundaryReview>();
    const reviewMedia = async (plan: StudioPlan, checks: StudioContentReview[]) => {
      if (provider === "local") return checks;
      const reviewed: StudioContentReview[] = [];
      for (const check of checks) {
        const planned = plan.outputs.find((o) => studioOutputKey(o) === studioOutputKey(check));
        if (
          !planned ||
          !["short", "reel", "video"].includes(planned.format) ||
          studioContentReviewIssues([check]).length
        ) {
          reviewed.push(check);
          continue;
        }
        if (!hasAudio) throw Error("STUDIO_SOURCE_EVIDENCE_REQUIRED");
        const range = studioSourceRange(
          planned.sourceSegmentIds,
          transcript,
          planned.format,
          planned.sourceTrim,
        );
        const first = transcript.segments.findIndex((s) => s.id === range.segments[0]?.id);
        const last = transcript.segments.findIndex((s) => s.id === range.segments.at(-1)?.id);
        const outside = [
          ...transcript.segments.slice(Math.max(0, first - 2), first),
          ...transcript.segments.slice(last + 1, last + 3),
        ];
        const fingerprint = studioFingerprint({
          policy: STUDIO_BOUNDARY_REVIEW_POLICY,
          evidencePolicy: STUDIO_BOUNDARY_EVIDENCE_POLICY,
          source: claim.source.sha256,
          startMs: range.startMs,
          endMs: range.endMs,
          model: videoConnection.model,
          included: range.segments,
          outside,
        });
        let boundary =
          boundaryCache.get(fingerprint) ??
          checkpoints?.get<StudioBoundaryReview>(`boundary:${fingerprint}`, fingerprint);
        if (!boundary) {
          boundary = await reviewStudioClipBoundaries({
            ...videoConnection,
            ...(signal ? { signal } : {}),
            sourcePath,
            mimeType: claim.source.mimeType,
            directory,
            ffmpeg: env.DISTRIBUTION_FFMPEG_PATH ?? "ffmpeg",
            language: transcript.language,
            startMs: range.startMs,
            endMs: range.endMs,
            included: range.segments,
            outside,
          });
          await checkpoints?.set(`boundary:${fingerprint}`, fingerprint, boundary);
        }
        boundaryCache.set(fingerprint, boundary);
        const bounded = applyStudioBoundaryReview(check, boundary);
        if (!hasVideo || studioContentReviewIssues([bounded]).length) {
          reviewed.push(bounded);
          continue;
        }
        const { screen } = await screenSource(planned);
        reviewed.push({
          ...bounded,
          openingComplete: bounded.openingComplete && screen.openingComplete && screen.naturalStart,
          endingComplete: bounded.endingComplete && screen.endingComplete && screen.naturalEnd,
          reason: `${bounded.reason} Audiovisual boundary check: ${screen.reason}`.slice(0, 3000),
        });
      }
      return reviewed;
    };
    const generatedPlan: StudioPlan = input.renderOnly
      ? {
          ...(claim.package.provenance?.excludedMessages?.length
            ? { excludedMessages: claim.package.provenance.excludedMessages }
            : {}),
          outputs: claim.package.outputs.map((o) => ({
            channel: o.channel,
            language: o.language,
            ...(o.messageId ? { messageId: o.messageId } : {}),
            format: o.format,
            title: o.title,
            body: o.body,
            rationale: o.rationale,
            sourceSegmentIds: o.sourceSegmentIds,
            ...(o.sourceTrim ? { sourceTrim: o.sourceTrim } : {}),
          })),
          skippedChannels: [],
          translations: [
            ...new Set(
              claim.package.outputs
                .filter(
                  (o) =>
                    o.language !== transcript.language &&
                    ["short", "reel", "video"].includes(o.format),
                )
                .map((o) => o.language),
            ),
          ].map((language) => ({
            language,
            segments: [
              ...new Map(
                claim.package.outputs
                  .filter((o) => o.language === language)
                  .flatMap((o) =>
                    (o.captionCues ?? []).map((c) => [c.id, { id: c.id, text: c.text }] as const),
                  ),
              ).values(),
            ],
          })),
        }
      : await generateCheckpointedStudioPlan(
          {
            pkg: claim.package,
            transcript,
            provider,
            ...(input.retainedOutputs ? { retainedOutputs: input.retainedOutputs } : {}),
            ...(input.discoveryExcludedOutputs
              ? { discoveryExcludedOutputs: input.discoveryExcludedOutputs }
              : {}),
            ...(apiKey ? { apiKey } : {}),
            ...(model ? { model } : {}),
            ...(originalAudio ? { originalAudio } : {}),
            ...(reviewAudio ? { reviewAudio } : {}),
            fetcher: fetch,
            ...(signal ? { signal } : {}),
          },
          checkpoints,
          {
            ...(fallback ? { fallback } : {}),
            ...(provider !== "local"
              ? {
                  reviewMedia,
                  mediaReviewPolicy: `${STUDIO_BOUNDARY_EVIDENCE_POLICY}:${STUDIO_SOURCE_FRAMING_POLICY}`,
                }
              : {}),
            onReview: recordReviews,
            onProvider: (usedProvider, usedModel, audioIncluded) => {
              analyzedAudio ||= audioIncluded;
              if (
                !draftingProviders.some(
                  (entry) => entry.provider === usedProvider && entry.model === usedModel,
                )
              )
                draftingProviders.push({ provider: usedProvider, model: usedModel });
            },
          },
        );
    const plan = enforceStudioPlanBranding(
      input.applyAiCorrections
        ? generatedPlan
        : preserveStudioEditorialEdits(generatedPlan, claim.package),
      claim.package.request,
    );
    validateStudioPlan(
      plan,
      claim.package,
      transcript,
      input.discoveryExcludedOutputs !== undefined,
    );
    // Manual edits and render-only jobs must not bypass the check on the final content and source range.
    if (
      provider !== "local" &&
      (input.renderOnly || studioFingerprint(plan) !== studioFingerprint(generatedPlan))
    ) {
      const fingerprint = studioFingerprint({
        version: 7,
        manualCaptions: input.renderOnly
          ? claim.package.outputs.map((o) => ({ id: o.id, cues: o.captionCues }))
          : null,
        boundaryEvidencePolicy: STUDIO_BOUNDARY_EVIDENCE_POLICY,
        framingPolicy: STUDIO_SOURCE_FRAMING_POLICY,
        editorialReview: STUDIO_EDITORIAL_REVIEW_POLICY,
        ...(reviewAudio ? { audioReview: "selected-source-windows-v1" } : {}),
        storyboard: "context-rich-v2",
        storyboardContinuity: STUDIO_STORYBOARD_CONTINUITY_POLICY,
        iconography: STUDIO_ICONOGRAPHY_POLICY,
        presentation: STUDIO_PRESENTATION_POLICY,
        plan,
        transcript,
        provider,
        model,
        source: claim.package.source.sha256,
      });
      let reviewed = checkpoints?.get<{ checks: StudioContentReview[]; reviewedAt: string }>(
        "final-video-review-v6",
        fingerprint,
      );
      if (!reviewed) {
        await checkpoints?.progress({
          phase: "reviewing",
          provider,
          completed: 0,
          total: plan.outputs.length,
          ...(plan.outputs[0]
            ? { channel: plan.outputs[0].channel, language: plan.outputs[0].language }
            : {}),
        });
        const checks = await reviewMedia(
          plan,
          await reviewStudioContent({
            ...(input.renderOnly ? { useManualCaptions: true } : {}),
            pkg: claim.package,
            plan,
            transcript,
            provider,
            ...(apiKey ? { apiKey } : {}),
            ...(model ? { model } : {}),
            ...(originalAudio ? { originalAudio } : {}),
            ...(reviewAudio ? { reviewAudio } : {}),
            fetcher: fetch,
            ...(signal ? { signal } : {}),
          }),
        );
        if (studioContentReviewIssues(checks).length) throw new StudioContentQualityError(checks);
        reviewed = { checks, reviewedAt: new Date().toISOString() };
        await checkpoints?.set("final-video-review-v6", fingerprint, reviewed);
      }
      recordReviews(reviewed.checks, {
        provider,
        model: model ?? "",
        audioIncluded: Boolean(originalAudio || reviewAudio),
        reviewedAt: reviewed.reviewedAt,
      });
    }
    const provenance: StudioProvenance = {
      provider: draftingProviders[0]?.provider ?? provider,
      model:
        draftingProviders[0]?.model ??
        (provider === "local" ? "source-excerpts-v1" : (model ?? "")),
      inputMode: analyzedAudio ? "transcript_and_audio" : "transcript",
      promptVersion:
        provider === "local" ? "ashrama-studio-v2" : "ashrama-studio-v4-video-reviewed",
      ...(draftingProviders.length ? { draftingProviders } : {}),
      generatedAt: new Date().toISOString(),
      brandName: sourceBrand.name,
      brandLogoSha256: sourceBrand.portrait ? sha(logo) : null,
      ...(claim.package.request.sourceBranding
        ? { sourceBranding: claim.package.request.sourceBranding }
        : {}),
      transcript,
      skippedChannels: plan.skippedChannels,
      ...(plan.discovery ? { discovery: plan.discovery } : {}),
      ...(plan.excludedMessages?.length ? { excludedMessages: plan.excludedMessages } : {}),
    };
    validateStudioProvenance(provenance);
    if (input.discoveryExcludedOutputs && !plan.outputs.length) return { outputs: [], provenance };
    const outputs: StudioOutput[] = [];
    const rendered = new Map<
      string,
      {
        path: string;
        presentation?: Omit<StudioPresentationReview, "fileVersion" | "renderedSha256">;
      }
    >();
    const frames = new Map<number, string>();
    async function sourceFrame(
      segments: StudioTranscript["segments"],
    ): Promise<Buffer | undefined> {
      if (!hasVideo) return undefined;
      const representative = segments.reduce((best, segment) =>
        segment.text.length > best.text.length ? segment : best,
      );
      const position = Math.floor((representative.startMs + representative.endMs) / 2);
      const saved = frames.get(position);
      if (saved) return readFile(saved);
      const path = join(directory, `source-${position}.png`);
      await executeStudioSource({
        executable: env.DISTRIBUTION_FFMPEG_PATH ?? "ffmpeg",
        sourcePath,
        mimeType: claim.source.mimeType,
        directory,
        timeoutMs: 60000,
        ...(signal ? { signal } : {}),
        args: [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-n",
          "-ss",
          String(position / 1000),
          "-i",
          "__SOURCE__",
          "-frames:v",
          "1",
          "-vf",
          "scale=1080:608:force_original_aspect_ratio=decrease",
          "-threads",
          "1",
          path,
        ],
      });
      frames.set(position, path);
      return readFile(path);
    }
    const renderFingerprint = studioFingerprint({
      version: 18,
      boundaryPolicy: STUDIO_BOUNDARY_REVIEW_POLICY,
      boundaryEvidencePolicy: STUDIO_BOUNDARY_EVIDENCE_POLICY,
      renderedBoundaryPolicy: STUDIO_BOUNDARY_EVIDENCE_POLICY,
      framingPolicy: STUDIO_SOURCE_FRAMING_POLICY,
      audioPolicy: STUDIO_AUDIO_POLICY,
      visualStylePolicy: STUDIO_VISUAL_STYLE_POLICY,
      closingDestinations: input.closingDestinations,
      appLogo: sha(appLogo),
      postArt: STUDIO_POST_ART_POLICY,
      appLinks,
      openingCard: STUDIO_OPENING_CARD_POLICY,
      steadyOpening: input.steadyOpening,
      closingCard: STUDIO_CLOSING_CARD_POLICY,
      illustrationTimings: input.illustrationTimings,
      visualPreference,
      imageModel,
      storyboard: "context-rich-v2",
      sharedMediaPolicy: "immutable-shared-media-v1",
      storyboardContinuity: STUDIO_STORYBOARD_CONTINUITY_POLICY,
      illustrationSelection: STUDIO_VIDEO_ILLUSTRATION_POLICY,
      iconography: STUDIO_ICONOGRAPHY_POLICY,
      presentation: STUDIO_PRESENTATION_POLICY,
      source: claim.package.source,
      transcript,
      request: claim.package.request,
      logo: sha(logo),
      mode: input.closingOnly ? "closing" : input.renderOnly ? "render" : "ai",
    });
    const canExcludeBoundary = canExcludeRenderedStudioCandidate(
      claim.package,
      Boolean(input.renderOnly || input.retainedOutputs),
    );
    const rejectedBoundaries = new Map<string, string>();
    const rejectedPresentations = new Map<string, string>();
    outputLoop: for (const planned of plan.outputs) {
      if (signal?.aborted) throw new Error("GENERATION_TIMEOUT");
      const video = ["short", "reel", "video"].includes(planned.format);
      const prior = claim.package.outputs.find(
        (o) => studioOutputKey(o) === studioOutputKey(planned),
      );
      const cacheKey = `output:${studioOutputKey(planned)}`;
      const legacyFingerprint = studioFingerprint({
        renderFingerprint,
        ...(video
          ? {
              captionLayout: "centered-72px-three-lines-v3",
              portraitContinuity: "continuous-safe-scenes-v2",
            }
          : {}),
        planned,
        prior,
        translations: plan.translations.find((value) => value.language === planned.language),
      });
      // Repair only unfinished media. Previously passing, hash-verified exports retain
      // their IDs and bytes; failed presentation/render caches must run the new path.
      const fingerprint = video
        ? studioFingerprint({ legacyFingerprint, renderer: STUDIO_RENDERER_VERSION })
        : legacyFingerprint;
      const rejectionKey = `render-boundary-rejection:${studioOutputKey(planned)}`;
      const excludeBoundary = async (reason: string) => {
        if (!canExcludeBoundary) throw Error("STUDIO_PRESENTATION_BOUNDARY_REQUIRED");
        const finding = reason.slice(0, 3000);
        rejectedBoundaries.set(studioOutputKey(planned), finding);
        await checkpoints?.set(rejectionKey, legacyFingerprint, { reason: finding });
      };
      const presentationRejectionKey = `render-presentation-rejection:${studioOutputKey(planned)}`;
      const rejectedPresentation = canExcludeBoundary
        ? checkpoints?.get<{ reason: string }>(presentationRejectionKey, fingerprint)
        : undefined;
      if (rejectedPresentation?.reason?.trim()) {
        rejectedPresentations.set(
          studioOutputKey(planned),
          rejectedPresentation.reason.slice(0, 3000),
        );
        continue;
      }
      const rejected = canExcludeBoundary
        ? checkpoints?.get<{ reason: string }>(rejectionKey, legacyFingerprint)
        : undefined;
      if (rejected && typeof rejected.reason === "string" && rejected.reason.trim()) {
        rejectedBoundaries.set(studioOutputKey(planned), rejected.reason.slice(0, 3000));
        continue;
      }
      await checkpoints?.progress({
        phase: "rendering",
        provider: "local",
        completed: outputs.length,
        total: plan.outputs.length,
        channel: planned.channel,
        language: planned.language,
      });
      const review = aiReviews.get(studioOutputKey(planned));
      const aiReview = review
        ? { ...review, fileVersion: (prior?.fileVersion ?? (prior ? 1 : 0)) + 1 }
        : undefined;
      if (provider !== "local" && !aiReview) throw new Error("STUDIO_VIDEO_REVIEW_INVALID");
      const saved =
        checkpoints?.get<StudioOutput>(cacheKey, fingerprint) ??
        (video ? checkpoints?.get<StudioOutput>(cacheKey, legacyFingerprint) : undefined);
      if (saved?.asset) {
        // Recheck stored bytes: metadata alone is not evidence that rendering survived.
        const assets = [
          saved.asset,
          ...(saved.thumbnail ? [saved.thumbnail] : []),
          ...saved.captions.map((caption) => caption.asset),
        ];
        let intact = true;
        if (video && provider !== "local") {
          try {
            if (!saved.presentationReview) throw Error("STUDIO_PRESENTATION_REVIEW_INVALID");
            validateStudioPresentationReview(saved.presentationReview, {
              sourceSha256: claim.source.sha256,
              renderedSha256: saved.asset.sha256,
              fileVersion: saved.fileVersion ?? 1,
              durationMs: (saved.endMs ?? 0) - (saved.startMs ?? 0),
            });
          } catch {
            intact = false;
          }
        }
        for (const asset of assets) {
          try {
            if (sha(await store.readDerivedDescriptor(asset)) !== asset.sha256) intact = false;
          } catch {
            intact = false;
          }
        }
        if (intact) {
          outputs.push({ ...saved, ...(aiReview ? { aiReview } : {}) });
          continue;
        }
      }
      const id = prior?.id ?? randomUUID();
      const range = studioSourceRange(
        planned.sourceSegmentIds,
        transcript,
        planned.format,
        planned.sourceTrim,
      );
      const output: StudioOutput = {
        ...planned,
        ...(prior?.mediaEdits ? { mediaEdits: prior.mediaEdits } : {}),
        id,
        fileVersion: (prior?.fileVersion ?? (prior ? 1 : 0)) + 1,
        generatedAt: provenance.generatedAt,
        ...(aiReview ? { aiReview } : {}),
        included: prior?.included ?? true,
        startMs: video ? range.startMs : null,
        endMs: video ? range.endMs : null,
        aspect: video ? "9:16" : planned.format === "post" ? "4:5" : "prose",
        asset: null,
        captions: [],
        warnings: [
          "Review the source recording, complete context and attribution before approval.",
          ...(video && studioCaptionsEnabled(prior?.mediaEdits, claim.package.request.captions)
            ? [
                "Long subtitle cues use estimated page timing within the original segment; review caption synchronization.",
              ]
            : []),
          ...(transcript.provenance === "MACHINE_TRANSCRIPT"
            ? ["Machine transcript requires correction and human review."]
            : []),
          ...(planned.language !== transcript.language
            ? ["Translated copy and subtitles require language review; source audio is unchanged."]
            : []),
        ],
      };
      const identity = {
        fileVersion: output.fileVersion ?? 1,
        renderId: randomUUID().slice(0, 8),
        masterId: claim.package.source.masterId,
        sourceVersionId: claim.package.source.versionId,
        packageId: claim.package.id,
        outputId: id,
        channel: output.channel,
        format: output.format,
        language: output.language,
        aspect: output.aspect,
      };
      const save = async (
        data: Uint8Array,
        extension: "mp4" | "png" | "md" | "vtt",
        mimeType: string,
        captionLanguage?: StudioLanguage,
      ): Promise<StudioAsset> => {
        const name = studioAssetName(identity, extension, captionLanguage);
        const asset = { ...name, sha256: sha(data), byteSize: data.length, mimeType };
        return saveSharedStudioAsset(store, asset, data);
      };
      if (video) {
        const translations = new Map(
          plan.translations
            .find((t) => t.language === planned.language)
            ?.segments.map((s) => [s.id, s.text]) ?? [],
        );
        const captions = range.segments.map((s) => ({
          ...s,
          text: input.renderOnly
            ? (prior?.captionCues?.find((c) => c.id === s.id)?.text ??
              (planned.language === transcript.language ? s.text : (translations.get(s.id) ?? "")))
            : planned.language === transcript.language
              ? s.text
              : (translations.get(s.id) ?? ""),
        }));
        output.captionCues = captions;
        if (studioCaptionsEnabled(prior?.mediaEdits, claim.package.request.captions)) {
          output.captions.push({
            language: planned.language,
            asset: await save(
              Buffer.from(studioVtt(captions, range.startMs, range.endMs)),
              "vtt",
              "text/vtt",
              planned.language,
            ),
            translated: planned.language !== transcript.language,
          });
          // Only the selected output language is exported. The native transcript remains
          // in source provenance for review; it is not an unrequested caption track.
        }
        const screened = hasVideo && provider !== "local" ? await screenSource(planned) : undefined;
        const priorPresentation = input.closingOnly ? prior?.presentationReview : undefined;
        const wantsOpening =
          sourceBrand.portrait &&
          (input.steadyOpening ||
            priorPresentation?.openingCard ||
            (!input.closingOnly && screened?.screen.openingCardRecommended));
        const key = JSON.stringify({
          mediaEdits: prior?.mediaEdits,
          title: wantsOpening ? planned.title : undefined,
          // A closing-only repair preserves this exact file's framing/artwork.
          preservedPresentation: input.closingOnly ? priorPresentation : undefined,
          screen: screened?.screen,
          youtubeClosing: claim.package.request.youtubeClosing,
          closingDestination:
            (claim.package.request.youtubeClosing ? "youtube" : undefined) ??
            (prior && input.closingDestinations?.[prior.id]) ??
            prior?.closingDestination ??
            prior?.presentationReview?.closingCard?.destination ??
            "app",
          start: range.startMs,
          end: range.endMs,
          captions: studioCaptionsEnabled(prior?.mediaEdits, claim.package.request.captions)
            ? captions
            : [],
        });
        const style = studioCardStyle(
          `${claim.package.source.masterId}:${planned.messageId ?? planned.sourceSegmentIds.join(":")}`,
        );
        const destination =
          (claim.package.request.youtubeClosing ? "youtube" : undefined) ??
          (prior && input.closingDestinations?.[prior.id]) ??
          prior?.closingDestination ??
          prior?.presentationReview?.closingCard?.destination ??
          "app";
        output.closingDestination = destination;
        const closing = {
          bytes: await studioClosingCard(
            destination === "youtube" ? logo : appLogo,
            style,
            destination,
            claim.package.request.youtubeClosing,
            claim.package.request.sourceBranding,
          ),
          plan: studioClosingCardPlan(range.endMs - range.startMs, {
            style,
            appLinks: studioAppLinks(appLinks),
            destination,
            ...(claim.package.request.sourceBranding
              ? { sourceBranding: claim.package.request.sourceBranding }
              : {}),
            ...(claim.package.request.youtubeClosing
              ? { youtubeClosing: claim.package.request.youtubeClosing }
              : {}),
          }),
        };
        if (closing.plan.endMs > studioVideoDurationLimitMs(planned.channel, planned.format))
          throw Error("STUDIO_CLIP_TOO_LONG");
        let mediaRender = rendered.get(key);
        if (!mediaRender) {
          if (input.closingOnly) {
            if (!priorPresentation || !prior?.asset)
              throw Error("STUDIO_PRESENTATION_REVIEW_INVALID");
            validateStudioPresentationReview(priorPresentation, {
              sourceSha256: claim.source.sha256,
              renderedSha256: prior.asset.sha256,
              fileVersion: prior.fileVersion ?? 1,
              durationMs: range.endMs - range.startMs,
            });
            if (sha(await store.readDerivedDescriptor(prior.asset)) !== prior.asset.sha256)
              throw Error("INVALID_STUDIO_ASSET");
          }
          const preservedScreen = priorPresentation
            ? retimeStudioIllustrations(
                priorPresentation.source,
                input.illustrationTimings ?? [],
                range.segments,
                range.startMs,
                range.endMs - range.startMs,
              )
            : undefined;
          let scenes = preservedScreen
            ? preservedScreen.scenes
            : screened
              ? safeStudioPortraitScenes(screened.screen, range.endMs - range.startMs)
              : [];
          if (
            screened &&
            ![
              screened.screen.openingComplete,
              screened.screen.endingComplete,
              screened.screen.naturalStart,
              screened.screen.naturalEnd,
            ].every(Boolean)
          ) {
            await excludeBoundary(screened.screen.reason);
            continue;
          }
          let rejectedIllustration = false;
          const illustrations = preservedScreen
            ? await Promise.all(
                (preservedScreen.illustrations ?? []).map(async (shot) => {
                  if (!shot.generated) throw Error("STUDIO_ILLUSTRATION_INVALID");
                  const bytes = await store.readDerivedDescriptor(shot.generated.asset);
                  if (sha(bytes) !== shot.generated.asset.sha256)
                    throw Error("STUDIO_ILLUSTRATION_INVALID");
                  return { ...shot, bytes: Buffer.from(bytes), generated: shot.generated };
                }),
              )
            : screened
              ? await studioContextIllustrationShots({
                  screen: screened.screen,
                  segments: range.segments,
                  clipStartMs: range.startMs,
                  sourceSha256: claim.source.sha256,
                  sourceTitle: claim.package.source.title,
                  identity,
                  store,
                  ...(checkpoints ? { checkpoints } : {}),
                  apiKey: videoConnection.apiKey,
                  imageModel,
                  reviewerModel: videoConnection.model,
                  visualPreference,
                  ...(hasVideo
                    ? {
                        onRejected: () => {
                          rejectedIllustration = true;
                          output.warnings.push(
                            "An optional illustration did not pass review. Original source footage was retained and the final video was screened again.",
                          );
                        },
                      }
                    : {}),
                  ...(signal ? { signal } : {}),
                })
              : [];
          // A storyboard can leave a portrait interval gap for an insert. If the
          // insert is omitted, use a consistent uncropped picture throughout;
          // otherwise that gap would briefly shrink and enlarge the speaker.
          if (rejectedIllustration || prior?.mediaEdits?.framing === "full-picture") scenes = [];
          for (let attempt = 0; attempt < 2; attempt++) {
            const openingPlan = wantsOpening
              ? studioOpeningCardPlan(range.endMs - range.startMs, scenes)
              : undefined;
            if (openingPlan && illustrations.some((s) => s.startMs < openingPlan.endMs))
              throw Error("STUDIO_OPENING_CARD_INVALID");
            const opening = openingPlan
              ? { plan: openingPlan, bytes: await studioOpeningCard(logo, planned.title, style) }
              : undefined;
            const folder = join(directory, `${id}-${attempt}`);
            await mkdir(folder, { mode: 0o700 });
            const backdrop = await studioArtwork({
              logo,
              title: planned.title,
              body: planned.body,
              format: "video",
              language: planned.language,
            });
            const videoStream = media.streams?.find((s) => s.codec_type === "video");
            const path = await renderStudioVideo({
              ...(prior?.mediaEdits ? { mediaEdits: prior.mediaEdits } : {}),
              ffmpeg: env.DISTRIBUTION_FFMPEG_PATH ?? "ffmpeg",
              directory: folder,
              sourcePath,
              mimeType: claim.source.mimeType,
              ...(signal ? { signal } : {}),
              backdrop,
              hasVideo,
              hasAudio,
              ...(videoStream?.width ? { sourceWidth: videoStream.width } : {}),
              ...(videoStream?.height ? { sourceHeight: videoStream.height } : {}),
              scenes,
              illustrations,
              closingCard: closing,
              ...(opening ? { openingCard: opening } : {}),
              startMs: range.startMs,
              endMs: range.endMs,
              captions: studioCaptionsEnabled(prior?.mediaEdits, claim.package.request.captions)
                ? captions
                : [],
            });
            if (!screened) {
              mediaRender = { path };
              break;
            }
            const bytes = await readFile(path);
            const qualityFingerprint = studioFingerprint({
              reviewerVersion: STUDIO_PRESENTATION_REVIEWER_VERSION,
              renderedBoundaryPolicy: STUDIO_BOUNDARY_EVIDENCE_POLICY,
              framingPolicy: STUDIO_SOURCE_FRAMING_POLICY,
              policy: STUDIO_PRESENTATION_POLICY,
              rendered: sha(bytes),
              source: claim.source.sha256,
              screen: screened.screen,
              model: videoConnection.model,
            });
            let checks = checkpoints?.get<StudioPresentationReview["checks"]>(
              `render-screen:${qualityFingerprint}`,
              qualityFingerprint,
            );
            if (!checks) {
              const fitRegion = studioFullPictureRegion(
                videoStream?.width ?? 1280,
                videoStream?.height ?? 720,
              );
              const proxy = await studioReviewProxy({
                ffmpeg: env.DISTRIBUTION_FFMPEG_PATH ?? "ffmpeg",
                sourcePath: path,
                directory: folder,
                startMs: 0,
                endMs: closing.plan.endMs,
                filename: "render-review.mp4",
                ...(signal ? { signal } : {}),
              });
              const frames = await studioReviewFramePairs({
                ffmpeg: env.DISTRIBUTION_FFMPEG_PATH ?? "ffmpeg",
                directory: folder,
                sourcePath,
                renderedPath: path,
                startMs: range.startMs,
                durationMs: closing.plan.endMs,
                sourceDurationMs: range.endMs - range.startMs,
                fullPicture: {
                  region: fitRegion,
                  covered: [
                    ...scenes,
                    ...illustrations,
                    closing.plan,
                    ...(opening ? [opening.plan] : []),
                  ],
                },
                timesMs: [
                  ...(closing.plan.speechEndMs !== undefined && closing.plan.cleanHoldMs
                    ? [
                        closing.plan.speechEndMs,
                        closing.plan.speechEndMs + closing.plan.cleanHoldMs / 2,
                      ]
                    : []),
                  ...(opening
                    ? [opening.plan.transitionStartMs - 250, opening.plan.endMs + 250]
                    : []),
                  ...scenes.slice(0, 2).map((s) => Math.min(s.endMs - 1, s.startMs + 2000)),
                  ...illustrations.map((s) => (s.startMs + s.endMs) / 2),
                ],
                ...(signal ? { signal } : {}),
              });
              checks = await reviewStudioPresentation({
                frames,
                ...videoConnection,
                source: await readFile(screened.proxyPath),
                rendered: proxy,
                context: {
                  title: planned.title,
                  sourceSpeaker: sourceBrand,
                  captionsRequested: studioCaptionsEnabled(
                    prior?.mediaEdits,
                    claim.package.request.captions,
                  ),
                  language: planned.language,
                  captions,
                  closingCard: closing.plan,
                  ...(opening ? { openingCard: opening.plan } : {}),
                  captionPages: studioCaptionPages(captions).map((page) => ({
                    ...page,
                    startMs: page.startMs - range.startMs,
                    endMs: page.endMs - range.startMs,
                  })),
                  foregroundPicture: {
                    portraitRegion: STUDIO_VIDEO_FRAME,
                    fitRegion,
                  },
                  scenes,
                  illustrations: illustrations.map(({ bytes: _bytes, ...shot }) => shot),
                  previousRepair:
                    attempt > 0
                      ? "Full source picture retained after a failed portrait check."
                      : null,
                },
              });
              const audibleBoundary = await reviewStudioClipBoundaries({
                ...videoConnection,
                sourcePath: path,
                mimeType: "video/mp4",
                directory: folder,
                ffmpeg: env.DISTRIBUTION_FFMPEG_PATH ?? "ffmpeg",
                language: transcript.language,
                startMs: range.startMs,
                endMs: range.endMs,
                fileStartMs: 0,
                included: range.segments,
                outside: [],
              });
              const incomplete = (["opening", "ending"] as const).filter(
                (edge) => !studioBoundaryPasses(audibleBoundary[edge]),
              );
              checks = {
                ...checks,
                naturalBoundaries: checks.naturalBoundaries && !incomplete.length,
                reason: [
                  ...incomplete.map(
                    (edge) =>
                      `Rendered ${edge}: ${audibleBoundary[edge].audibleWords}. ${audibleBoundary[edge].reason}`,
                  ),
                  checks.reason,
                ]
                  .join(" ")
                  .slice(0, 3000),
              };
              await checkpoints?.set(
                `render-screen:${qualityFingerprint}`,
                qualityFingerprint,
                checks,
              );
            }
            await checkpoints?.set(
              `render-presentation-evidence:${studioOutputKey(planned)}:${qualityFingerprint}`,
              qualityFingerprint,
              {
                renderer: STUDIO_RENDERER_VERSION,
                sourceRange: { startMs: range.startMs, endMs: range.endMs },
                renderedSha256: sha(bytes),
                attempt,
                framing: scenes.length ? "screened-portrait" : "full-picture",
                scenes,
                speechEndMs: closing.plan.speechEndMs,
                cleanHoldMs: closing.plan.cleanHoldMs,
                checks,
              },
            );
            if (
              ![
                checks.illustrationsRelevant,
                checks.textIntact,
                checks.subjectIntact,
                checks.captionsClear,
                checks.naturalBoundaries,
              ].every(Boolean)
            )
              await checkpoints?.progress({
                phase: "reviewing",
                provider: "gemini",
                completed: outputs.length,
                total: plan.outputs.length,
                channel: planned.channel,
                language: planned.language,
                presentationIssues: [checks.reason],
              });
            if (!checks.naturalBoundaries) {
              await excludeBoundary(checks.reason);
              continue outputLoop;
            }
            if (
              [
                checks.illustrationsRelevant,
                checks.textIntact,
                checks.subjectIntact,
                checks.captionsClear,
              ].every(Boolean)
            ) {
              mediaRender = {
                path,
                presentation: {
                  policy: STUDIO_PRESENTATION_POLICY,
                  illustrationMode: "context-generated",
                  closingCard: closing.plan,
                  ...(opening ? { openingCard: opening.plan } : {}),
                  sourceSha256: claim.source.sha256,
                  model: videoConnection.model,
                  reviewedAt: new Date().toISOString(),
                  framing: scenes.length ? "screened-portrait" : "full-picture",
                  repairs: attempt,
                  source: {
                    ...screened.screen,
                    scenes,
                    illustrations: illustrations.map(({ bytes: _bytes, ...shot }) => shot),
                  },
                  checks,
                },
              };
              break;
            }
            if (!checks.illustrationsRelevant) throw Error("STUDIO_IMAGE_REVIEW_REQUIRED");
            if (!input.closingOnly && attempt === 0 && scenes.length) {
              scenes = [];
            } else {
              if (!canExcludeBoundary) throw Error("STUDIO_PRESENTATION_REPAIR_REQUIRED");
              const reason = checks.reason.slice(0, 3000);
              rejectedPresentations.set(studioOutputKey(planned), reason);
              await checkpoints?.set(presentationRejectionKey, fingerprint, { reason });
              continue outputLoop;
            }
          }
          if (!mediaRender) throw Error("STUDIO_PRESENTATION_REPAIR_REQUIRED");
          rendered.set(key, mediaRender);
        }
        output.asset = await save(await readFile(mediaRender.path), "mp4", "video/mp4");
        const thumbnailSource = await sourceFrame(range.segments);
        if (thumbnailSource)
          output.thumbnail = await save(
            await studioVideoThumbnail(thumbnailSource, planned.title),
            "png",
            "image/png",
          );
        if (mediaRender.presentation)
          output.presentationReview = {
            ...mediaRender.presentation,
            fileVersion: output.fileVersion ?? 1,
            renderedSha256: output.asset.sha256,
          };
      } else if (
        planned.format === "post" &&
        planned.channel === "telegram" &&
        provider !== "local"
      ) {
        const post = await createStudioIllustratedPost({
          apiKey: videoConnection.apiKey,
          imageModel,
          reviewerModel: videoConnection.model,
          title: planned.title,
          body: planned.body,
          sourceTitle: claim.package.source.title,
          sourceSha256: claim.source.sha256,
          segments: range.segments,
          identity,
          logo: postLogo,
          sourceBranding: claim.package.request.sourceBranding,
          store,
          visualPreference,
          ...(checkpoints ? { checkpoints } : {}),
          ...(signal ? { signal } : {}),
        });
        output.asset = await save(post.bytes, "png", "image/png");
        output.postArt = {
          ...post.evidence,
          renderedSha256: output.asset.sha256,
          fileVersion: output.fileVersion ?? 1,
        };
      } else if (planned.format === "post") {
        const frame = await sourceFrame(range.segments);
        output.asset = await save(
          await studioArtwork({
            logo: postLogo,
            sourceBranding: claim.package.request.sourceBranding,
            title: planned.title,
            body: planned.body,
            format: "post",
            language: planned.language,
            ...(frame ? { sourceFrame: frame } : {}),
          }),
          "png",
          "image/png",
        );
      } else {
        output.asset = await save(
          Buffer.from(
            `# ${planned.title}\n\n${sourceBrand.name}\n\n${planned.body}\n\n---\nMaster: ${claim.package.source.masterId}\nSource language: ${transcript.language}\n`,
          ),
          "md",
          "text/markdown",
        );
      }
      await checkpoints?.set(cacheKey, fingerprint, output);
      outputs.push(output);
    }
    if (rejectedPresentations.size) {
      // Keep the actual presentation reason. Do not relabel it as an audio-boundary
      // failure or mark a rejected render as passing editorial/media review.
      if (!outputs.length) throw Error("STUDIO_PRESENTATION_REPAIR_REQUIRED");
      provenance.excludedMessages = [
        ...(provenance.excludedMessages ?? []),
        ...plan.outputs.flatMap((planned) => {
          const reason = rejectedPresentations.get(studioOutputKey(planned));
          if (!reason) return [];
          if (!planned.messageId) throw Error("INVALID_STUDIO_MESSAGE");
          return [
            {
              messageId: planned.messageId,
              title: planned.title,
              reasons: [`Final presentation review: ${reason}`],
            },
          ];
        }),
      ];
      validateStudioProvenance(provenance);
    }
    if (rejectedBoundaries.size) {
      const checks = plan.outputs.map((planned) => {
        const key = studioOutputKey(planned);
        const check = aiReviews.get(key)?.checks;
        if (!check) throw Error("STUDIO_VIDEO_REVIEW_INVALID");
        const reason = rejectedBoundaries.get(key);
        return reason ? { ...check, openingComplete: false, endingComplete: false, reason } : check;
      });
      const selected = selectInitialStudioCandidates(plan, checks, claim.package.request);
      // No successful package when every candidate failed the actual-media gate.
      if (!outputs.length) throw Error("STUDIO_PRESENTATION_BOUNDARY_REQUIRED");
      provenance.excludedMessages = [
        ...(provenance.excludedMessages ?? []),
        ...(selected.excludedMessages ?? []),
      ];
      provenance.skippedChannels = selected.skippedChannels;
      validateStudioProvenance(provenance);
    }
    validateStudioOutputs(outputs, {
      packageId: claim.package.id,
      source: claim.package.source,
      request: claim.package.request,
      provenance,
    });
    await checkpoints?.progress({
      phase: "complete",
      provider: "local",
      completed: outputs.length,
      total: outputs.length,
    });
    return { outputs, provenance };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
