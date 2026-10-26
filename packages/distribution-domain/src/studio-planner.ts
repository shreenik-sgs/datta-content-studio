import {
  STUDIO_CHANNELS,
  STUDIO_LANGUAGES,
  type StudioChannel,
  type StudioFormat,
  type StudioGenerationRequest,
  type StudioLanguage,
  type StudioPackage,
  type StudioReadiness,
  type StudioSegment,
  type StudioTranscript,
} from "./intelligent-content";
import type { StudioExcludedMessage } from "./studio-content-review";
import { STUDIO_CLOSING_HOLD_MS, studioYoutubeClosing, studioYoutubeFooter } from "./studio-ending";

import { studioSourceBranding } from "./studio-source-branding";
export { STUDIO_BRAND_NAME, STUDIO_BRAND_SIGNATURE } from "./studio-source-branding";
/** Historical approval snapshots remain readable; new generation always uses the official channel. */
export const STUDIO_LEGACY_BRAND_NAME = "Sri Ganapathy Sachchidananda Ashrama";
export const STUDIO_LEGACY_BRAND_SIGNATURE = "SGS Datta Sannidhi";
/** Matches the persisted Studio provenance reason bound. */
export const STUDIO_SKIP_REASON_LIMIT = 500;
/** Conservative UTF-16 bounds; Pinterest specifies 100 characters for Pin titles.
 * https://business.pinterest.com/creative-best-practices/ */
export const STUDIO_TITLE_LIMITS: Record<StudioChannel, number> = {
  youtube: 100,
  instagram: 200,
  facebook: 200,
  x: 200,
  reddit: 200,
  tiktok: 200,
  threads: 200,
  linkedin: 200,
  pinterest: 100,
  telegram: 200,
  whatsapp: 200,
  bluesky: 200,
  website: 200,
};
/** Telegram sendPhoto accepts 1024 characters. Keep 24 units of headroom and
 * count UTF-16 units, matching our delivery guard even for supplementary Unicode.
 * https://core.telegram.org/bots/api#sendphoto */
export const STUDIO_IMAGE_CAPTION_LIMITS = { telegram: 1000 } as const;
export const STUDIO_COPY_LIMITS: Record<StudioChannel, number> = {
  youtube: 4500,
  instagram: 2000,
  facebook: 5000,
  x: 260,
  reddit: 15000,
  tiktok: 2000,
  threads: 460,
  linkedin: 2800,
  pinterest: 450,
  telegram: STUDIO_IMAGE_CAPTION_LIMITS.telegram,
  whatsapp: 1000,
  bluesky: 280,
  website: 20000,
};
/** Facebook is published as a Reel through Buffer, which accepts at most 90 seconds.
 * https://support.buffer.com/articles/sharing-videos-through-buffer-LOe2p2rnAI */
export function studioVideoDurationLimitMs(channel: StudioChannel): number {
  return channel === "facebook" ? 90_000 : 180_000;
}
/** New source selection reserves the clean ending without truncating speech later. */
export function studioVideoSourceDurationLimitMs(channel: StudioChannel): number {
  return studioVideoDurationLimitMs(channel) - STUDIO_CLOSING_HOLD_MS;
}
export function studioCopyLength(channel: StudioChannel, text: string): number {
  return ["telegram", "whatsapp"].includes(channel) ? text.length : [...text].length;
}
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Truncate display text only at whole grapheme boundaries, leaving source timings intact. */
function truncateCopy(text: string, limit: number, length: (value: string) => number): string {
  if (length(text) <= limit) return text;
  let result = "";
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const size = length(segment);
    if (used + size > limit - 1) break;
    result += segment;
    used += size;
  }
  return `${result.trimEnd()}…`;
}
/** Legacy outputs have one implicit message per channel/language. */
export function studioOutputKey(output: {
  channel: string;
  language: string;
  messageId?: string;
}): string {
  return `${output.channel}:${output.language}${output.messageId ? `:${output.messageId}` : ""}`;
}
export function validStudioMessageId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
}
export type StudioPlannedOutput = {
  sourceTrim?: { startMs: number; endMs: number } | null;
  messageId?: string;
  channel: StudioChannel;
  format: StudioFormat;
  language: StudioLanguage;
  title: string;
  body: string;
  rationale: string;
  sourceSegmentIds: string[];
};
export type StudioPlan = {
  discovery?: import("./studio-discovery").StudioDiscoveryCoverage;
  excludedMessages?: StudioExcludedMessage[];
  outputs: StudioPlannedOutput[];
  skippedChannels: { channel: StudioChannel; reason: string }[];
  translations: { language: StudioLanguage; segments: { id: string; text: string }[] }[];
};

/** A package has one caption text per language/source segment; review exactly what will render. */
export function reuseStudioPlanTranslations(plan: StudioPlan, reference?: StudioPlan): StudioPlan {
  return {
    ...plan,
    translations: plan.translations.map((translation) => ({
      ...translation,
      segments: translation.segments.map(
        (segment) =>
          reference?.translations
            .find((t) => t.language === translation.language)
            ?.segments.find((s) => s.id === segment.id) ?? segment,
      ),
    })),
  };
}

/** Reserve the subscription link in posting copy; a video file cannot contain clickable links. */
export function studioCopyFooter(
  channel: StudioChannel,
  request?: StudioGenerationRequest,
): string {
  const target =
    channel === "youtube" && request?.youtubeClosing
      ? studioYoutubeClosing(request.youtubeClosing)
      : undefined;
  return `${target ? `\n\n${studioYoutubeFooter(target)}` : ""}\n\n${studioSourceBranding(request?.sourceBranding).signature}`;
}
/** Add fixed branding metadata only; leave empty/malformed copy and length errors for validation. */
export function enforceStudioPlanBranding(
  plan: StudioPlan,
  request?: StudioGenerationRequest,
): StudioPlan {
  if (!plan || !Array.isArray(plan.outputs)) return plan;
  const signature = studioSourceBranding(request?.sourceBranding).signature;
  return {
    ...plan,
    outputs: plan.outputs.map((output) => {
      if (!output || typeof output.body !== "string" || !output.body.trim()) return output;
      let body = output.body.replace(/\n\nSGS Datta Sannidhi\s*$/u, "").trim();
      if (request?.sourceBranding) body = body.replace(/\n\n@sgsswamiji\s*$/u, "").trim();
      const target =
        output.channel === "youtube" && request?.youtubeClosing
          ? studioYoutubeClosing(request.youtubeClosing)
          : undefined;
      const subscribe = target ? studioYoutubeFooter(target) : undefined;
      if (subscribe && !body.includes(subscribe)) body += `\n\n${subscribe}`;
      return {
        ...output,
        body: body.includes(signature) ? body : `${body}\n\n${signature}`,
      };
    }),
  };
}

/** Pending copy corrections retain their source evidence; a new plan cannot silently drop them. */
export function preserveStudioEditorialEdits(plan: StudioPlan, pkg: StudioPackage): StudioPlan {
  const edits = pkg.outputs.filter(
    (output) =>
      output.asset === null &&
      pkg.request.channels.includes(output.channel) &&
      pkg.request.languages.includes(output.language),
  );
  if (
    edits.some(
      (edit) => !plan.outputs.some((output) => studioOutputKey(output) === studioOutputKey(edit)),
    )
  )
    throw new Error("STUDIO_EDITED_OUTPUT_OMITTED");
  return {
    ...plan,
    outputs: plan.outputs.map((output) => {
      const edit = edits.find(
        (candidate) => studioOutputKey(candidate) === studioOutputKey(output),
      );
      return edit
        ? {
            ...output,
            title: edit.title,
            body: edit.body,
            format: edit.format,
            rationale: edit.rationale,
            sourceSegmentIds: [...edit.sourceSegmentIds],
            sourceTrim: edit.sourceTrim ?? null,
          }
        : { ...output };
    }),
  };
}

export function studioGenerationReadiness(
  env: Record<string, string | undefined>,
): StudioReadiness["generation"] {
  const provider = env.STUDIO_INTELLIGENCE_PROVIDER ?? "local";
  const enabled = env.STUDIO_GENERATION_ENABLED === "true";
  // Readiness flags are a server-only projection from the credential bootstrap.
  // They never authorize an API call: the worker still requires the actual key.
  const configured =
    provider === "local" ||
    (provider === "openai" && Boolean(env.STUDIO_OPENAI_API_KEY && env.STUDIO_OPENAI_MODEL)) ||
    (provider === "gemini" &&
      Boolean(
        (env.STUDIO_GEMINI_API_KEY || env.STUDIO_GEMINI_CONFIGURED === "true") &&
          env.STUDIO_GEMINI_MODEL,
      ));
  const transcriptionProvider = env.STUDIO_TRANSCRIPTION_PROVIDER;
  const asr =
    transcriptionProvider === "sarvam"
      ? env.STUDIO_SARVAM_API_KEY?.trim() || env.STUDIO_SARVAM_CONFIGURED === "true"
        ? "Sarvam timed transcription"
        : "Sarvam transcription not configured; saved approved transcript required"
      : transcriptionProvider === "openai"
        ? env.STUDIO_OPENAI_API_KEY?.trim()
          ? "OpenAI timed transcription"
          : "OpenAI transcription not configured; saved approved transcript required"
        : transcriptionProvider
          ? "Selected transcription provider not supported; saved approved transcript required"
          : env.STUDIO_WHISPER_COMMAND
            ? "Local timed transcription"
            : env.STUDIO_TRANSCRIPT_CACHE_ROOT
              ? "Saved transcript or source-verified transcript cache"
              : "Saved approved transcript required";
  return {
    available: enabled && configured,
    transcription: asr,
    intelligence:
      provider === "gemini"
        ? "Gemini source analysis and channel drafting"
        : provider === "openai"
          ? "AI source analysis and channel drafting"
          : "Local source-based drafting",
    translation: enabled && ["openai", "gemini"].includes(provider) && configured,
    reason: !enabled
      ? "STUDIO_GENERATION_DISABLED"
      : !configured
        ? "STUDIO_INTELLIGENCE_NOT_CONFIGURED"
        : null,
  };
}

/** Whole source segments are evidence. Videos require continuity; written outputs may cite ordered passages. */
export function studioSourceRange(
  ids: readonly string[],
  transcript: StudioTranscript,
  format: StudioFormat = "short",
  trim?: { startMs: number; endMs: number } | null,
): { startMs: number; endMs: number; segments: StudioSegment[] } {
  if (!Array.isArray(ids)) throw new Error("STUDIO_SOURCE_EVIDENCE_REQUIRED");
  const contiguous = format !== "post" && format !== "blog";
  const indices = ids.map((id) => transcript.segments.findIndex((s) => s.id === id));
  if (
    !ids.length ||
    new Set(ids).size !== ids.length ||
    indices.some(
      (n, i) =>
        n < 0 ||
        (i > 0 &&
          (n <= (indices[i - 1] ?? -2) || (contiguous && n !== (indices[i - 1] ?? -2) + 1))),
    )
  )
    throw new Error("STUDIO_SOURCE_EVIDENCE_REQUIRED");
  const segments = indices.map((i) => transcript.segments[i] as StudioSegment);
  if (trim != null) {
    if (
      !["short", "reel"].includes(format) ||
      !Number.isSafeInteger(trim.startMs) ||
      !Number.isSafeInteger(trim.endMs) ||
      trim.startMs < (segments[0] as StudioSegment).startMs ||
      trim.endMs > (segments[segments.length - 1] as StudioSegment).endMs ||
      trim.endMs - trim.startMs < 1000
    )
      throw new Error("INVALID_STUDIO_TRIM");
    const clipped = segments
      .filter((segment) => segment.endMs > trim.startMs && segment.startMs < trim.endMs)
      .map((segment) => ({
        ...segment,
        startMs: Math.max(segment.startMs, trim.startMs),
        endMs: Math.min(segment.endMs, trim.endMs),
      }));
    if (!clipped.length) throw new Error("INVALID_STUDIO_TRIM");
    return { startMs: trim.startMs, endMs: trim.endMs, segments: clipped };
  }
  return {
    startMs: (segments[0] as StudioSegment).startMs,
    endMs: (segments[segments.length - 1] as StudioSegment).endMs,
    segments,
  };
}
export const studioFormatForChannel = (channel: StudioChannel): StudioFormat =>
  channel === "youtube"
    ? "short"
    : ["instagram", "facebook", "tiktok"].includes(channel)
      ? "reel"
      : channel === "website" || channel === "reddit"
        ? "blog"
        : "post";
export function validateStudioPlan(
  plan: StudioPlan,
  pkg: StudioPackage,
  transcript: StudioTranscript,
  allowAllSkipped = false,
): void {
  if (
    !plan ||
    !Array.isArray(plan.outputs) ||
    (!plan.outputs.length && !allowAllSkipped && !pkg.source.liveWindow) ||
    plan.outputs.length > 200 ||
    !Array.isArray(plan.skippedChannels) ||
    !Array.isArray(plan.translations)
  )
    throw new Error("INVALID_STUDIO_PLAN");
  const seen = new Set<string>();
  for (const output of plan.outputs) {
    if (
      !pkg.request.channels.includes(output.channel) ||
      !pkg.request.languages.includes(output.language) ||
      !STUDIO_CHANNELS.includes(output.channel) ||
      !STUDIO_LANGUAGES.includes(output.language) ||
      output.format !== studioFormatForChannel(output.channel)
    )
      throw new Error("INVALID_STUDIO_PLAN");
    if (
      !output.title?.trim() ||
      output.title.length > STUDIO_TITLE_LIMITS[output.channel] ||
      !output.body?.trim() ||
      studioCopyLength(output.channel, output.body) > STUDIO_COPY_LIMITS[output.channel] ||
      !output.body.includes(studioSourceBranding(pkg.request.sourceBranding).signature) ||
      (output.channel === "youtube" &&
        pkg.request.youtubeClosing &&
        !output.body.includes(studioYoutubeClosing(pkg.request.youtubeClosing).url)) ||
      !output.rationale?.trim() ||
      output.rationale.length > 2000
    )
      throw new Error("INVALID_STUDIO_COPY");
    if (
      (pkg.request.allCompleteMessages && !validStudioMessageId(output.messageId)) ||
      (output.messageId !== undefined && !validStudioMessageId(output.messageId))
    )
      throw new Error("INVALID_STUDIO_MESSAGE");
    const identity = pkg.request.allCompleteMessages
      ? studioOutputKey(output)
      : `${output.channel}:${output.language}`;
    if (seen.has(identity)) throw new Error("DUPLICATE_STUDIO_OUTPUT");
    seen.add(identity);
    const range = studioSourceRange(
      output.sourceSegmentIds,
      transcript,
      output.format,
      output.sourceTrim,
    );
    if (pkg.source.liveWindow && range.startMs >= pkg.source.liveWindow.ownedEndMs)
      throw new Error("STUDIO_LIVE_OVERLAP");
    if (
      (output.format === "short" || output.format === "reel") &&
      range.endMs - range.startMs > studioVideoDurationLimitMs(output.channel)
    )
      throw new Error("STUDIO_CLIP_TOO_LONG");
  }
  if (pkg.request.allCompleteMessages) validateStudioMessagePassages(plan.outputs);
  const translated = new Set<string>();
  for (const translation of plan.translations) {
    if (
      !pkg.request.languages.includes(translation.language) ||
      translation.language === transcript.language ||
      translated.has(translation.language) ||
      !Array.isArray(translation.segments)
    )
      throw new Error("INVALID_STUDIO_TRANSLATION");
    translated.add(translation.language);
    const ids = new Set<string>();
    for (const segment of translation.segments) {
      if (
        ids.has(segment.id) ||
        !transcript.segments.some((s) => s.id === segment.id) ||
        !segment.text?.trim() ||
        segment.text.length > 8000
      )
        throw new Error("INVALID_STUDIO_TRANSLATION");
      ids.add(segment.id);
    }
    for (const o of plan.outputs.filter(
      (o) => o.language === translation.language && (o.format === "short" || o.format === "reel"),
    )) {
      if (
        studioSourceRange(o.sourceSegmentIds, transcript, o.format, o.sourceTrim).segments.some(
          (s) => !ids.has(s.id),
        )
      )
        throw new Error("STUDIO_TRANSLATION_INCOMPLETE");
    }
  }
  for (const o of plan.outputs) {
    if (
      o.language !== transcript.language &&
      (o.format === "short" || o.format === "reel") &&
      !translated.has(o.language)
    )
      throw new Error("STUDIO_TRANSLATION_INCOMPLETE");
  }
  const skipped = new Set<string>();
  for (const s of plan.skippedChannels) {
    if (
      !pkg.request.channels.includes(s.channel) ||
      !s.reason?.trim() ||
      s.reason.length > STUDIO_SKIP_REASON_LIMIT ||
      skipped.has(s.channel) ||
      plan.outputs.some((o) => o.channel === s.channel)
    )
      throw new Error("INVALID_STUDIO_SKIP");
    skipped.add(s.channel);
  }
  if (
    pkg.request.channels.some(
      (channel) =>
        !skipped.has(channel) &&
        pkg.request.languages.some(
          (language) => !plan.outputs.some((o) => o.channel === channel && o.language === language),
        ),
    )
  )
    throw new Error("STUDIO_CHANNEL_COVERAGE_REQUIRED");
}

/** A repaired teaching must remain distinct from retained messages and agree across channels. */
export function validateStudioMessagePassages(outputs: StudioPlan["outputs"]): void {
  const passages = new Set<string>();
  const messages = new Map<string, string>();
  for (const output of outputs.filter((o) => ["short", "reel"].includes(o.format))) {
    if (!output.messageId) throw new Error("INVALID_STUDIO_MESSAGE");
    const ids = JSON.stringify(output.sourceSegmentIds);
    const key = `${output.channel}:${output.language}:${ids}`;
    if (passages.has(key)) throw new Error("DUPLICATE_STUDIO_PASSAGE");
    passages.add(key);
    if (messages.has(output.messageId) && messages.get(output.messageId) !== ids)
      throw new Error("STUDIO_MESSAGE_SOURCE_MISMATCH");
    messages.set(output.messageId, ids);
  }
}

/** An honest offline fallback: exact source excerpts and format rules, never invented summaries or translations. */
export function createLocalStudioPlan(
  pkg: StudioPackage,
  transcript: StudioTranscript,
): StudioPlan {
  if (pkg.request.languages.some((l) => l !== transcript.language))
    throw new Error("STUDIO_TRANSLATION_PROVIDER_REQUIRED");
  const first = transcript.segments[0];
  if (!first) throw new Error("STUDIO_TRANSCRIPT_REQUIRED");
  const selected: StudioSegment[] = [];
  for (const segment of transcript.segments) {
    if (segment.endMs - first.startMs > studioVideoSourceDurationLimitMs("facebook")) break;
    selected.push(segment);
    if (segment.endMs - first.startMs >= 25000 && /[.!?।॥]\s*$/.test(segment.text)) break;
  }
  if (!selected.length) selected.push(first);
  const plan: StudioPlan = { outputs: [], skippedChannels: [], translations: [] };
  for (const channel of pkg.request.channels) {
    if (channel === "linkedin" && pkg.source.category !== "seva") {
      plan.skippedChannels.push({
        channel,
        reason:
          "LinkedIn is reserved for service and community activity; this recording is devotional content.",
      });
      continue;
    }
    const format = studioFormatForChannel(channel);
    if (
      (format === "short" || format === "reel") &&
      (selected[selected.length - 1]?.endMs ?? first.endMs) - first.startMs >
        studioVideoSourceDurationLimitMs(channel)
    ) {
      plan.skippedChannels.push({
        channel,
        reason:
          "No complete timed source segment fits the short-video limit; use the full recording.",
      });
      continue;
    }
    const footer = studioCopyFooter(channel, pkg.request);
    const length = (value: string) => studioCopyLength(channel, value);
    const budget = STUDIO_COPY_LIMITS[channel] - length(footer);
    const prose = (format === "blog" ? transcript.segments.slice(0, 35) : selected)
      .map((s) => s.text.trim())
      .join(format === "blog" ? "\n\n" : " ");
    const body = truncateCopy(prose, budget, length) + footer;
    const evidence = format === "blog" ? transcript.segments.slice(0, 35) : selected;
    plan.outputs.push({
      channel,
      format,
      language: transcript.language as StudioLanguage,
      title: truncateCopy(pkg.source.title, STUDIO_TITLE_LIMITS[channel], (value) => value.length),
      body,
      rationale:
        format === "blog"
          ? "Source transcript reading for long-form discussion. Review wording and context before publishing."
          : `Source excerpt adapted to ${channel}'s ${format} format. Review the complete teaching context.`,
      sourceSegmentIds: evidence.map((s) => s.id),
    });
  }
  validateStudioPlan(plan, pkg, transcript);
  return plan;
}
