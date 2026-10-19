import {
  type ContentMaster,
  type DistributionChannel,
  contentExportDecision,
  validateContentRights,
} from "./content";
import {
  STUDIO_CHANNELS,
  STUDIO_LANGUAGES,
  type StudioAsset,
  type StudioGenerationRequest,
  type StudioOutput,
  type StudioPackage,
  type StudioProvenance,
  studioSourceMatches,
} from "./intelligent-content";
import { parseStudioAssetKey } from "./studio-assets";
import { validateStudioAiReviewEvidence } from "./studio-content-review";
import { studioRenderedDurationMs, studioYoutubeClosing } from "./studio-ending";
import { studioCaptionsEnabled, validateStudioMediaEdits } from "./studio-media-edits";
import {
  STUDIO_BRAND_NAME,
  STUDIO_COPY_LIMITS,
  STUDIO_LEGACY_BRAND_NAME,
  STUDIO_LEGACY_BRAND_SIGNATURE,
  STUDIO_TITLE_LIMITS,
  studioCopyLength,
  studioFormatForChannel,
  studioOutputKey,
  studioSourceRange,
  studioVideoDurationLimitMs,
  validStudioMessageId,
} from "./studio-planner";
import { validateStudioPostArt } from "./studio-post-art";
import { validateStudioPresentationReview } from "./studio-presentation";
import { studioSourceBranding } from "./studio-source-branding";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const validId = (value: unknown): value is string => typeof value === "string" && uuid.test(value);
const bounded = (value: unknown, maximum: number, allowEmpty = false): value is string =>
  typeof value === "string" &&
  value.length <= maximum &&
  (allowEmpty || value.trim().length > 0) &&
  !value.includes("\u0000");
/** External AI receives source bytes only after explicit current public distribution rights. */
export function studioExternalProcessingDecision(
  master: ContentMaster,
  request: StudioGenerationRequest,
  now: string,
): { allowed: boolean; reason: string | null } {
  const refuse = (reason: string) => ({ allowed: false, reason });
  if (master.state === "WITHDRAWN") return refuse("WITHDRAWN");
  if (!master.rights) return refuse("RIGHTS_MISSING");
  try {
    validateContentRights(master.rights);
  } catch {
    return refuse("INVALID_RIGHTS");
  }
  if (master.rights.privacyClass !== "PUBLIC")
    return refuse("STUDIO_EXTERNAL_PROCESSING_NOT_AUTHORIZED");
  const time = Date.parse(now);
  if (!Number.isFinite(time)) return refuse("INVALID_TIME");
  if (master.rights.releaseAt && time < Date.parse(master.rights.releaseAt))
    return refuse("RELEASE_PENDING");
  if (master.rights.expiresAt && time >= Date.parse(master.rights.expiresAt))
    return refuse("RIGHTS_EXPIRED");
  if (!master.rights.territories.includes("WORLDWIDE")) return refuse("TERRITORY_NOT_PERMITTED");
  if (
    request.channels.some(
      (channel) => !master.rights?.channels.includes(channel as DistributionChannel),
    )
  )
    return refuse("CHANNEL_NOT_PERMITTED");
  return { allowed: true, reason: null };
}
export function validateStudioGenerationRequest(input: StudioGenerationRequest): void {
  if (
    !input ||
    !Array.isArray(input.languages) ||
    !input.languages.length ||
    input.languages.length > 8 ||
    new Set(input.languages).size !== input.languages.length ||
    input.languages.some((value) => !STUDIO_LANGUAGES.includes(value)) ||
    !Array.isArray(input.channels) ||
    !input.channels.length ||
    input.channels.length > STUDIO_CHANNELS.length ||
    new Set(input.channels).size !== input.channels.length ||
    input.channels.some((value) => !STUDIO_CHANNELS.includes(value)) ||
    typeof input.captions !== "boolean" ||
    (input.allCompleteMessages !== undefined && typeof input.allCompleteMessages !== "boolean") ||
    !bounded(input.instructions, 8000, true)
  )
    throw new Error("INVALID_STUDIO_REQUEST");
  if (input.youtubeClosing !== undefined) studioYoutubeClosing(input.youtubeClosing);
  studioSourceBranding(input.sourceBranding);
  if (
    input.sourceBranding &&
    (input.channels.length !== 1 || input.channels[0] !== "youtube" || !input.youtubeClosing)
  )
    throw Error("INVALID_STUDIO_REQUEST");
}
export function validateStudioAsset(
  asset: StudioAsset,
  binding?: { masterId: string; versionId: string; packageId: string; outputId: string },
): void {
  const parts = asset?.storageKey?.split("/");
  const parsed = asset && parseStudioAssetKey(asset.storageKey);
  const types = {
    "video/mp4": ["mp4", 100 * 1024 * 1024],
    "image/png": ["png", 10 * 1024 * 1024],
    "text/markdown": ["md", 2 * 1024 * 1024],
    "text/plain": ["txt", 2 * 1024 * 1024],
    "text/vtt": ["vtt", 2 * 1024 * 1024],
    "application/json": ["json", 2 * 1024 * 1024],
  } as const;
  const spec = asset && types[asset.mimeType as keyof typeof types];
  if (
    !parsed ||
    !parts ||
    !spec ||
    !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    !Number.isSafeInteger(asset.byteSize) ||
    asset.byteSize < 1 ||
    asset.byteSize > spec[1] ||
    !bounded(asset.filename, 200) ||
    asset.filename !== parsed.filename ||
    !asset.filename.endsWith(`.${spec[0]}`) ||
    (binding &&
      (parts[2] !== binding.masterId ||
        parts[3] !== binding.versionId ||
        parts[4] !== binding.packageId ||
        parts[5] !== binding.outputId))
  )
    throw new Error("INVALID_STUDIO_ASSET");
}
export function validateStudioProvenance(input: StudioProvenance): void {
  const sourceBrand = studioSourceBranding(input?.sourceBranding);
  const transcript = input?.transcript;
  if (
    !input ||
    !["local", "openai", "gemini"].includes(input.provider) ||
    (input.draftingProviders !== undefined &&
      (!Array.isArray(input.draftingProviders) ||
        input.draftingProviders.length > 2 ||
        input.draftingProviders.some(
          (entry) =>
            !entry || !["gemini", "openai"].includes(entry.provider) || !bounded(entry.model, 200),
        ))) ||
    (input.inputMode !== undefined &&
      !["transcript", "transcript_and_audio"].includes(input.inputMode)) ||
    (transcript?.recognition !== undefined &&
      (!transcript.recognition ||
        typeof transcript.recognition !== "object" ||
        Array.isArray(transcript.recognition) ||
        !["sarvam", "openai"].includes(transcript.recognition.provider) ||
        !bounded(transcript.recognition.model, 200))) ||
    !bounded(input.model, 200) ||
    !bounded(input.promptVersion, 100) ||
    (input.sourceBranding
      ? input.brandName !== sourceBrand.name || input.brandLogoSha256 !== null
      : ![STUDIO_BRAND_NAME, STUDIO_LEGACY_BRAND_NAME].includes(input.brandName) ||
        !/^[a-f0-9]{64}$/.test(input.brandLogoSha256 ?? "")) ||
    !Number.isFinite(Date.parse(input.generatedAt)) ||
    !Array.isArray(input.skippedChannels) ||
    input.skippedChannels.length > STUDIO_CHANNELS.length ||
    input.skippedChannels.some(
      (item) => !STUDIO_CHANNELS.includes(item.channel) || !bounded(item.reason, 500),
    ) ||
    (input.excludedMessages !== undefined &&
      (!Array.isArray(input.excludedMessages) ||
        input.excludedMessages.length > 200 ||
        input.excludedMessages.some(
          (item) =>
            !item ||
            !validStudioMessageId(item.messageId) ||
            !bounded(item.title, 500) ||
            !Array.isArray(item.reasons) ||
            !item.reasons.length ||
            item.reasons.length > 200 ||
            item.reasons.some((reason) => !bounded(reason, 4000)),
        ))) ||
    !transcript ||
    !bounded(transcript.language, 20) ||
    !Number.isSafeInteger(transcript.durationMs) ||
    transcript.durationMs < 1 ||
    transcript.durationMs > 86400000 ||
    !["APPROVED_TRANSCRIPT", "MACHINE_TRANSCRIPT"].includes(transcript.provenance) ||
    (transcript.provenance === "APPROVED_TRANSCRIPT" && !validId(transcript.sourceTranscriptId)) ||
    (transcript.sourceTranscriptId !== null && !validId(transcript.sourceTranscriptId)) ||
    !Array.isArray(transcript.segments) ||
    !transcript.segments.length ||
    transcript.segments.length > 10000 ||
    JSON.stringify(transcript).length > 2 * 1024 * 1024
  )
    throw new Error("INVALID_STUDIO_PROVENANCE");
  const ids = new Set<string>();
  let previous = -1;
  for (const segment of transcript.segments) {
    if (
      !bounded(segment.id, 100) ||
      ids.has(segment.id) ||
      !bounded(segment.text, 10000) ||
      !Number.isSafeInteger(segment.startMs) ||
      !Number.isSafeInteger(segment.endMs) ||
      segment.startMs < 0 ||
      segment.startMs < previous ||
      segment.endMs <= segment.startMs ||
      segment.endMs > transcript.durationMs
    )
      throw new Error("INVALID_STUDIO_TRANSCRIPT");
    ids.add(segment.id);
    previous = segment.startMs;
  }
}
export function validateStudioOutputs(
  outputs: StudioOutput[],
  input: {
    packageId: string;
    source: StudioPackage["source"];
    request: StudioGenerationRequest;
    provenance: StudioProvenance | null;
  },
): void {
  if (
    !Array.isArray(outputs) ||
    outputs.length > 200 ||
    JSON.stringify(outputs).length > 4 * 1024 * 1024
  )
    throw new Error("INVALID_STUDIO_OUTPUTS");
  if (input.provenance && input.provenance.sourceBranding !== input.request.sourceBranding)
    throw Error("INVALID_STUDIO_PROVENANCE");
  const ids = new Set<string>();
  const segments = new Map(
    input.provenance?.transcript.segments.map((item) => [item.id, item]) ?? [],
  );
  const destinations = new Set<string>();
  for (const output of outputs) {
    if (output.mediaEdits !== undefined) {
      if (!["short", "reel"].includes(output.format)) throw Error("INVALID_STUDIO_MEDIA_EDITS");
      validateStudioMediaEdits(output.mediaEdits);
    }
    if (
      !validId(output.id) ||
      (output.messageId !== undefined && !validStudioMessageId(output.messageId)) ||
      (input.request.allCompleteMessages && !validStudioMessageId(output.messageId)) ||
      ids.has(output.id) ||
      !input.request.channels.includes(output.channel) ||
      !input.request.languages.includes(output.language) ||
      !["short", "reel", "post", "blog"].includes(output.format) ||
      !["9:16", "4:5", "1:1", "16:9", "prose"].includes(output.aspect) ||
      !bounded(output.title, 200) ||
      !bounded(output.body, 40000, true) ||
      !bounded(output.rationale, 2000, true) ||
      typeof output.included !== "boolean" ||
      !Array.isArray(output.warnings) ||
      output.warnings.length > 20 ||
      output.warnings.some((value) => !bounded(value, 1000)) ||
      !Array.isArray(output.sourceSegmentIds) ||
      !output.sourceSegmentIds.length ||
      output.sourceSegmentIds.length > 10000 ||
      new Set(output.sourceSegmentIds).size !== output.sourceSegmentIds.length ||
      output.sourceSegmentIds.some((value) => !segments.has(value)) ||
      !Array.isArray(output.captions) ||
      output.captions.length > 8 ||
      new Set(output.captions.map((item) => item.language)).size !== output.captions.length
    )
      throw new Error("INVALID_STUDIO_OUTPUT");
    if (output.presentationReview) {
      if (!output.asset || output.startMs === null || output.endMs === null)
        throw Error("STUDIO_PRESENTATION_REVIEW_INVALID");
      validateStudioPresentationReview(output.presentationReview, {
        sourceSha256: input.source.sha256,
        renderedSha256: output.asset.sha256,
        fileVersion: output.fileVersion ?? 1,
        durationMs: output.endMs - output.startMs,
      });
      const closing = output.presentationReview.closingCard;
      const requestedClosing = input.request.youtubeClosing
        ? studioYoutubeClosing(input.request.youtubeClosing)
        : undefined;
      if (
        closing?.sourceBranding !== input.request.sourceBranding ||
        closing?.youtubeClosing?.label !== requestedClosing?.label ||
        closing?.youtubeClosing?.url !== requestedClosing?.url ||
        (requestedClosing &&
          (closing?.destination !== "youtube" || closing.channelUrl !== requestedClosing.url))
      )
        throw Error("STUDIO_CLOSING_CARD_INVALID");
      for (const shot of output.presentationReview.source.illustrations ?? []) {
        if (!shot.generated) continue;
        const parsed = parseStudioAssetKey(shot.generated.asset.storageKey);
        if (
          !parsed ||
          parsed.extension !== "png" ||
          parsed.identity.masterId !== input.source.masterId ||
          parsed.identity.sourceVersionId !== input.source.versionId ||
          parsed.identity.packageId !== input.packageId
        )
          throw Error("STUDIO_ILLUSTRATION_INVALID");
      }
    }
    if (output.postArt)
      validateStudioPostArt(output, input.source.sha256, {
        masterId: input.source.masterId,
        versionId: input.source.versionId,
        packageId: input.packageId,
      });
    if (output.aiReview)
      validateStudioAiReviewEvidence(output.aiReview, {
        channel: output.channel,
        language: output.language,
        ...(output.messageId ? { messageId: output.messageId } : {}),
        fileVersion: output.fileVersion ?? 1,
        sourceSha256: input.source.sha256,
        startMs: output.startMs,
        endMs: output.endMs,
      });
    const format = studioFormatForChannel(output.channel);
    if (
      output.format !== format ||
      output.title.length > STUDIO_TITLE_LIMITS[output.channel] ||
      !(
        output.body.includes(studioSourceBranding(input.request.sourceBranding).signature) ||
        (input.provenance?.brandName === STUDIO_LEGACY_BRAND_NAME &&
          output.body.includes(STUDIO_LEGACY_BRAND_SIGNATURE))
      ) ||
      studioCopyLength(output.channel, output.body) > STUDIO_COPY_LIMITS[output.channel] ||
      (output.channel === "youtube" &&
        input.request.youtubeClosing &&
        !output.body.includes(studioYoutubeClosing(input.request.youtubeClosing).url)) ||
      !output.rationale.trim() ||
      destinations.has(studioOutputKey(output))
    )
      throw new Error("INVALID_STUDIO_COPY");
    destinations.add(studioOutputKey(output));
    if (!input.provenance) throw new Error("INVALID_STUDIO_PROVENANCE");
    const range = studioSourceRange(
      output.sourceSegmentIds,
      input.provenance.transcript,
      output.format,
    );
    if (input.source.liveWindow && range.startMs >= input.source.liveWindow.ownedEndMs)
      throw new Error("STUDIO_LIVE_OVERLAP");
    const video = output.format === "short" || output.format === "reel";
    if (
      video &&
      (output.startMs !== range.startMs ||
        output.endMs !== range.endMs ||
        studioRenderedDurationMs(output) > studioVideoDurationLimitMs(output.channel))
    )
      throw new Error("INVALID_STUDIO_SPAN");
    if (
      video
        ? !Number.isSafeInteger(output.startMs) ||
          !Number.isSafeInteger(output.endMs) ||
          output.startMs === null ||
          output.endMs === null ||
          output.startMs < 0 ||
          output.endMs <= output.startMs ||
          output.endMs > (input.provenance?.transcript.durationMs ?? 0) ||
          output.aspect === "prose"
        : output.startMs !== null || output.endMs !== null
    )
      throw new Error("INVALID_STUDIO_SPAN");
    const binding = {
      masterId: input.source.masterId,
      versionId: input.source.versionId,
      packageId: input.packageId,
      outputId: output.id,
    };
    if (output.asset) {
      validateStudioAsset(output.asset, binding);
      const identity = parseStudioAssetKey(output.asset.storageKey)?.identity;
      if (
        identity?.channel !== output.channel ||
        identity.format !== output.format ||
        identity.language !== output.language ||
        identity.aspect !== output.aspect
      )
        throw new Error("INVALID_STUDIO_ASSET");
      if (
        video
          ? output.asset.mimeType !== "video/mp4"
          : output.format === "post"
            ? output.asset.mimeType !== "image/png"
            : !["text/markdown", "text/plain"].includes(output.asset.mimeType)
      )
        throw new Error("INVALID_STUDIO_ASSET");
    }
    if (output.thumbnail) {
      validateStudioAsset(output.thumbnail, binding);
      const identity = parseStudioAssetKey(output.thumbnail.storageKey)?.identity;
      if (
        !video ||
        !output.asset ||
        output.thumbnail.mimeType !== "image/png" ||
        identity?.channel !== output.channel ||
        identity.format !== output.format ||
        identity.language !== output.language ||
        identity.aspect !== output.aspect ||
        identity.fileVersion !== output.fileVersion
      )
        throw new Error("INVALID_STUDIO_ASSET");
    }
    for (const caption of output.captions) {
      if (
        !video ||
        !STUDIO_LANGUAGES.includes(caption.language) ||
        typeof caption.translated !== "boolean" ||
        caption.asset.mimeType !== "text/vtt"
      )
        throw new Error("INVALID_STUDIO_CAPTION");
      validateStudioAsset(caption.asset, binding);
      const parsed = parseStudioAssetKey(caption.asset.storageKey);
      if (
        parsed?.identity.channel !== output.channel ||
        parsed.identity.format !== output.format ||
        parsed.identity.language !== output.language ||
        parsed.identity.aspect !== output.aspect ||
        parsed.captionLanguage !== caption.language
      )
        throw new Error("INVALID_STUDIO_CAPTION");
    }
    if (
      video &&
      output.language !== input.provenance.transcript.language &&
      !output.captions.some(
        (caption) => caption.language === output.language && caption.translated,
      ) &&
      // Editing invalidates old media. Complete source-bound translated cues can be
      // saved for re-rendering; the missing asset still blocks review/publication.
      !(
        (!output.asset ||
          (output.mediaEdits &&
            !studioCaptionsEnabled(output.mediaEdits, input.request.captions))) &&
        Array.isArray(output.captionCues) &&
        output.captionCues.length === range.segments.length &&
        output.captionCues.every((cue, index) => {
          const source = range.segments[index];
          return (
            source &&
            cue &&
            cue.id === source.id &&
            cue.startMs === source.startMs &&
            cue.endMs === source.endMs &&
            bounded(cue.text, 4000)
          );
        })
      )
    )
      throw new Error("STUDIO_TRANSLATION_INCOMPLETE");
    if (
      video &&
      studioCaptionsEnabled(output.mediaEdits, input.request.captions) &&
      output.asset &&
      !output.captions.some((caption) => caption.language === output.language)
    )
      throw new Error("STUDIO_CAPTIONS_REQUIRED");
    ids.add(output.id);
  }
  if (input.provenance) {
    const skipped = new Set<string>();
    for (const item of input.provenance.skippedChannels) {
      if (
        !input.request.channels.includes(item.channel) ||
        skipped.has(item.channel) ||
        outputs.some((output) => output.channel === item.channel)
      )
        throw new Error("INVALID_STUDIO_SKIP");
      skipped.add(item.channel);
    }
    if (
      input.request.channels.some(
        (channel) => !skipped.has(channel) && !outputs.some((output) => output.channel === channel),
      )
    )
      throw new Error("STUDIO_CHANNEL_COVERAGE_REQUIRED");
  }
}
export function studioPackageBlockers(
  pkg: StudioPackage,
  master?: ContentMaster,
  now?: string,
): string[] {
  const reasons: string[] = [];
  if (!pkg.provenance) reasons.push("GENERATION_REQUIRED");
  if (!pkg.outputs.some((output) => output.included)) reasons.push("NO_INCLUDED_OUTPUTS");
  if (pkg.outputs.some((output) => output.included && !output.asset))
    reasons.push("ASSETS_REQUIRE_REGENERATION");
  if (
    pkg.outputs.some(
      (output) =>
        output.included &&
        (output.format === "short" || output.format === "reel") &&
        output.startMs !== null &&
        output.endMs !== null &&
        studioRenderedDurationMs(output) > studioVideoDurationLimitMs(output.channel),
    )
  )
    reasons.push("STUDIO_CLIP_TOO_LONG");
  if (master && !studioSourceMatches(pkg.source, master)) reasons.push("SOURCE_DEPENDENCY_CHANGED");
  if (master && now)
    for (const output of pkg.outputs.filter((value) => value.included)) {
      const decision = contentExportDecision({
        content: master,
        channel: output.channel as DistributionChannel,
        territory: "WORLDWIDE",
        now,
      });
      if (!decision.allowed) reasons.push(decision.reason);
    }
  return [...new Set(reasons)];
}
