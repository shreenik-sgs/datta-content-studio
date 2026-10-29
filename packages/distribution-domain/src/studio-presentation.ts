import type { StudioAsset, StudioSegment } from "./intelligent-content";
import { parseStudioAssetKey } from "./studio-assets";
import {
  type StudioClosingCard,
  type StudioOpeningCard,
  validateStudioClosingCard,
  validateStudioOpeningCard,
} from "./studio-ending";
import { STUDIO_SOURCE_SCENE_MARGIN_MS } from "./studio-timing";
import { STUDIO_NARRATIVE_ILLUSTRATION_POLICY } from "./studio-visual-preferences";
/** Geometry and evidence rules are shared by the renderer and output validation. */
export const STUDIO_PRESENTATION_POLICY = "source-safe-portrait-v1" as const;
/** A devotional backdrop alone does not require shrinking a single live speaker. */
export const STUDIO_SOURCE_FRAMING_POLICY = "speaker-first-framing-v2" as const;
export const STUDIO_PICTURE = { x: 0, y: 72, width: 1080, height: 1280 } as const;
/** The immersive layout fills the whole portrait frame; captions overlay its lower band. */
export const STUDIO_FRAME = { x: 0, y: 0, width: 1080, height: 1920 } as const;
export type StudioPresentationLayout = "immersive" | "classic";
export const STUDIO_SUBTITLE_TOP = STUDIO_PICTURE.y + STUDIO_PICTURE.height + 12;
export type StudioPortraitScene = {
  startMs: number;
  endMs: number;
  /** Source fractions: never split the head; preserve the bottom attribution band in full width. */
  bodyTop: number;
  bodyBottom: number;
};
export const STUDIO_ILLUSTRATION_POLICY = "context-rich-v2" as const;
export const STUDIO_ICONOGRAPHY_POLICY = "deity-identity-v4" as const;
/** Art direction for generated illustrations, not a claim that all traditional forms look alike. */
export const STUDIO_SACRED_ICONOGRAPHY =
  "Deity identity is a mandatory accuracy check. Resolve the central deity from the actual passage, not a name merely mentioned in comparison. Never interchange Durga, Lakshmi, Saraswati, Parvati or other forms of Devi, or combine their attributes into an invented hybrid. For a general depiction of Durga when no particular form is specified, use a serene traditional multi-armed Durga with eight distinct arms, a clearly visible lion or tiger mount, a trident and coherent protective weapons, alongside a gentle blessing gesture. Compose the identifying mount and attributes fully inside the visible illustration area. Count the visible arms when checking this general Durga composition: do not approve an ordinary two-armed figure for this brief. A specifically named traditional form may use its supported count instead. Photorealistic material treatment must preserve the sacred form and its multiple arms; it does not mean reducing a deity to an everyday human. A lotus-seated, lotus-bearing goddess alone is ambiguous and must not be labeled Durga; gold coins, abundance vessels or elephant ablutions can suggest Lakshmi, and a veena or swan can suggest Saraswati. Do not decide identity from one shared object, clothing color, beauty, the caption, or the prompt's claimed name. Evaluate the combination of visible features against the intended form. Traditional forms vary: when a specific form or tradition is named, preserve its supported iconography rather than impose this general Durga convention. Do not invent an unfamiliar form; use a source-faithful symbolic scene or retain speaker footage when identity cannot be established. Keep devotional artwork sacred, serene and elegant; do not add a violent battle merely to identify Durga. In comparisons such as Durga being gentler than Lakshmi, illustrate the intended subject Durga, not the comparison deity. For Vishnu and avatar narratives, resolve the precise form and episode before composing the image. Do not turn every mention of Vishnu into a generic blue royal figure or mix avatar attributes. A general four-armed Vishnu composition uses coherent conch, discus, mace and lotus attributes; do not impose that form on Rama or Krishna. Rama's bow, Krishna's flute or cowherd setting, Narasimha's lion-headed human-bodied form, and Varaha's boar form belong only where that identity and narrative context support them. A named alternate traditional form takes precedence over these general examples. Match age, companions, relationships and costume to the spoken episode; do not put a royal court in an exile scene or add a battle, miracle, flute, weapon or companion merely for decoration. Distinguish the devotee Prahlada from the deity Narasimha and the antagonist Hiranyakashipu. Never conflate narrator, worshipper, deity or comparison figure. Depict only the passage-supported action, without inventing a violent or sensational scene. When the source does not establish the form or episode sufficiently, use a faithful symbolic image or source footage. Countable attributes are fixed for the whole storyboard: a recurring deity, serpent or figure keeps exactly the same number of hoods, heads, faces and arms, and the same mount, weapons, colours and costume, in every scene where it appears. Every brief that shows such a figure states the exact count in words and asks for it to be rendered clearly countable; the reviewer counts them in the pixels and fails any scene whose count differs from the brief or from the previous accepted scene. Kaliya, the serpent subdued by Krishna in the Yamuna, is shown with exactly seven hoods in every scene unless the cited passage states a different number: describe them as one taller central hood with three smaller hoods fanned on each side, all facing forward, clearly separated and fully visible, so the seven can be counted at a glance; Adishesha is shown with many hoods, seven visible when a count must be chosen; the same rule applies to every multi-headed or multi-armed form. Anatomy must stay coherent: a serpent such as Kaliya or Adishesha has one body whose hoods rise together at the head end only, and a tail that tapers to a point and never ends in another head, face or hood; no figure has duplicated faces, extra limbs or heads growing from the wrong place. Never draw a phone, device frame, bezel, screen mockup, border or inset around a scene.";
export type StudioIllustrationPolicy =
  | typeof STUDIO_ILLUSTRATION_POLICY
  | typeof STUDIO_NARRATIVE_ILLUSTRATION_POLICY;
/** Storyboard limits per policy: milliseconds, counts and the share of the excerpt. */
export function studioIllustrationLimits(policy?: StudioIllustrationPolicy) {
  if (policy === STUDIO_NARRATIVE_ILLUSTRATION_POLICY)
    return {
      maxShots: 14,
      minMs: 3000,
      maxMs: 12000,
      openingMs: 2500,
      endingMs: 6500,
      gapMs: 0,
      share: 0.85,
    };
  const rich = policy === STUDIO_ILLUSTRATION_POLICY;
  return {
    maxShots: rich ? 6 : 3,
    minMs: 3000,
    maxMs: rich ? 8000 : 5000,
    openingMs: 5000,
    endingMs: rich ? 6500 : 5000,
    gapMs: 3000,
    share: rich ? 0.4 : 0.2,
  };
}
export type StudioSourceScreen = {
  illustrationPolicy?: StudioIllustrationPolicy;
  openingCardRecommended?: boolean;
  illustrations?: {
    assetId: string;
    extendedByCurator?: true;
    startMs: number;
    endMs: number;
    sourceSegmentIds: string[];
    reason: string;
    /** A source-grounded brief for a newly generated illustration; absent on legacy catalog shots. */
    prompt?: string;
    generated?: {
      asset: StudioAsset;
      provider: "gemini";
      model: string;
      generatedAt: string;
      reviewerModel: string;
      reviewedAt: string;
      checks: StudioIllustrationChecks;
    };
  }[];
  openingComplete: boolean;
  endingComplete: boolean;
  naturalStart: boolean;
  naturalEnd: boolean;
  reason: string;
  scenes: StudioPortraitScene[];
};
export type StudioPresentationReview = {
  /** Content review is inherited only after comparing the existing export with a card-only revision. */
  closingRefresh?: {
    policy: "preserved-export-closing-v1";
    previousSha256: string;
    previousFileVersion: number;
    cardSha256: string;
    verifiedAt: string;
    unchangedUntilMs: number;
    audioSha256: string;
    minimumFrameSsim: number;
    minimumCaptionSsim: number;
    cardMeanAbsoluteDifference?: number;
    /** Unchanged picture packets and their timestamps are checked without decoding them. */
    splice?: {
      method: "h264-tail-copy-v1";
      startMs: number;
      copiedPackets: number;
      encodedPackets: number;
      prefixSha256?: string;
      timingSha256: string;
    };
  };
  closingCard?: StudioClosingCard;
  openingCard?: StudioOpeningCard;
  illustrationMode?: "context-generated";
  /** Absent on files rendered before the immersive layout existed: those are classic. */
  layout?: StudioPresentationLayout;
  policy: typeof STUDIO_PRESENTATION_POLICY;
  sourceSha256: string;
  renderedSha256: string;
  fileVersion: number;
  model: string;
  reviewedAt: string;
  framing: "screened-portrait" | "full-picture";
  repairs: number;
  source: StudioSourceScreen;
  checks: {
    illustrationsRelevant: boolean;
    textIntact: boolean;
    subjectIntact: boolean;
    captionsClear: boolean;
    naturalBoundaries: boolean;
    reason: string;
  };
};
export type StudioIllustrationChecks = {
  /** Required for newly generated images; absent only in legacy evidence. */
  iconographyAccurate?: boolean;
  /** Required by the current image style policy; absent only in legacy evidence. */
  photorealistic?: boolean;
  /** Required by the current storyboard policy; absent only in legacy evidence. */
  continuityConsistent?: boolean;
  contextFaithful: boolean;
  nonDeceptive: boolean;
  noInventedText: boolean;
  visualQuality: boolean;
  safeComposition: boolean;
  reason: string;
};
/** Tighten an insert to the actual cited speech; never extend it into unrelated words. */
export function alignStudioIllustration(
  shot: NonNullable<StudioSourceScreen["illustrations"]>[number],
  segments: StudioSegment[],
  clipStartMs: number,
  policy?: StudioSourceScreen["illustrationPolicy"],
) {
  const cited = segments.filter((s) => shot.sourceSegmentIds.includes(s.id));
  if (
    !cited.length ||
    shot.sourceSegmentIds.some((id) => !cited.some((s) => s.id === id)) ||
    !Number.isSafeInteger(shot.startMs) ||
    !Number.isSafeInteger(shot.endMs) ||
    shot.endMs <= shot.startMs
  )
    throw Error("STUDIO_ILLUSTRATION_INVALID");
  const overlapping = cited
    .filter((s) => s.endMs > shot.startMs + clipStartMs && s.startMs < shot.endMs + clipStartMs)
    .sort((a, b) => a.startMs - b.startMs);
  if (!overlapping.length) throw Error("STUDIO_ILLUSTRATION_INVALID");
  const startMs = Math.max(shot.startMs, (overlapping[0]?.startMs ?? 0) - clipStartMs);
  const endMs = Math.min(shot.endMs, Math.max(...overlapping.map((s) => s.endMs)) - clipStartMs);
  // Natural silence between cited phrases is valid. A missing intervening spoken
  // segment is not: the outer citation envelope alone cannot justify its picture.
  const crossesUncitedSpeech = segments.some(
    (s) =>
      !shot.sourceSegmentIds.includes(s.id) &&
      s.startMs < endMs + clipStartMs &&
      s.endMs > startMs + clipStartMs,
  );
  const limits = studioIllustrationLimits(policy);
  if (
    crossesUncitedSpeech ||
    endMs - startMs < limits.minMs ||
    endMs - startMs > (shot.extendedByCurator ? Math.max(8000, limits.maxMs) : limits.maxMs)
  )
    throw Error("STUDIO_ILLUSTRATION_INVALID");
  return { ...shot, startMs, endMs };
}
const bool = (x: unknown) => typeof x === "boolean";
const reason = (x: unknown) => typeof x === "string" && x.trim().length > 0 && x.length <= 4000;
/** Static constraints are safe to send back for correction or log without source content. */
export const STUDIO_ILLUSTRATION_VALIDATION_RULES = {
  missing: "Return an illustration object.",
  assetId: "assetId must match ^[a-z][a-z-]{0,60}$: lowercase letters and hyphens only.",
  timing: "startMs and endMs must be safe integer milliseconds relative to the excerpt.",
  opening: "startMs must leave at least limits.openingMs of original opening footage.",
  ordering:
    "Keep illustrations in chronological order, without overlap, with limits.gapMs between them.",
  ending: "endMs must leave at least limits.endingMs before the excerpt ends.",
  minimumDuration: "Each illustration must last at least limits.minMs.",
  maximumDuration:
    "Each illustration must last no longer than limits.maxMs unless already extended by the curator.",
  citations:
    "sourceSegmentIds must be a nonempty array of string IDs, each at most 100 characters.",
  reason: "reason must be a nonempty string of at most 4000 characters.",
} as const;
export class StudioIllustrationValidationError extends Error {
  constructor(
    readonly illustrationIndex: number,
    readonly rules: (keyof typeof STUDIO_ILLUSTRATION_VALIDATION_RULES)[],
  ) {
    super("STUDIO_PRESENTATION_REVIEW_INVALID");
  }
}
export function validateStudioSourceScreen(
  value: StudioSourceScreen,
  durationMs: number,
  citation?: { segments: StudioSegment[]; clipStartMs: number },
): StudioSourceScreen {
  if (
    !value ||
    (value.illustrationPolicy !== undefined &&
      value.illustrationPolicy !== STUDIO_ILLUSTRATION_POLICY &&
      value.illustrationPolicy !== STUDIO_NARRATIVE_ILLUSTRATION_POLICY) ||
    ![value.openingComplete, value.endingComplete, value.naturalStart, value.naturalEnd].every(
      bool,
    ) ||
    (value.openingCardRecommended !== undefined && !bool(value.openingCardRecommended)) ||
    !reason(value.reason) ||
    !Array.isArray(value.scenes) ||
    value.scenes.length > 12 ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 1
  )
    throw Error("STUDIO_PRESENTATION_REVIEW_INVALID");
  let previous = 0;
  for (const scene of value.scenes) {
    if (
      !scene ||
      !Number.isSafeInteger(scene.startMs) ||
      !Number.isSafeInteger(scene.endMs) ||
      scene.startMs < previous ||
      scene.endMs <= scene.startMs ||
      scene.endMs > durationMs ||
      !Number.isFinite(scene.bodyTop) ||
      !Number.isFinite(scene.bodyBottom) ||
      scene.bodyTop !== 0 ||
      scene.bodyBottom < 0.65 ||
      scene.bodyBottom > 1 ||
      scene.bodyBottom - scene.bodyTop < 0.4
    )
      throw Error("STUDIO_PRESENTATION_REVIEW_INVALID");
    previous = scene.endMs;
  }
  const limits = studioIllustrationLimits(value.illustrationPolicy);
  if (value.illustrations !== undefined) {
    if (!Array.isArray(value.illustrations) || value.illustrations.length > limits.maxShots)
      throw Error("STUDIO_PRESENTATION_REVIEW_INVALID");
    let end = 0;
    let total = 0;
    for (const [index, shot] of value.illustrations.entries()) {
      const rules: (keyof typeof STUDIO_ILLUSTRATION_VALIDATION_RULES)[] = [];
      if (!shot) rules.push("missing");
      else {
        if (!/^[a-z][a-z-]{0,60}$/.test(shot.assetId)) rules.push("assetId");
        if (!Number.isSafeInteger(shot.startMs) || !Number.isSafeInteger(shot.endMs))
          rules.push("timing");
        if (shot.startMs < limits.openingMs) rules.push("opening");
        if (shot.startMs < end + (end ? limits.gapMs : 0)) rules.push("ordering");
        if (shot.endMs > durationMs - limits.endingMs) rules.push("ending");
        if (shot.endMs - shot.startMs < limits.minMs) rules.push("minimumDuration");
        if (
          shot.endMs - shot.startMs >
          (shot.extendedByCurator ? Math.max(8000, limits.maxMs) : limits.maxMs)
        )
          rules.push("maximumDuration");
        if (
          !Array.isArray(shot.sourceSegmentIds) ||
          !shot.sourceSegmentIds.length ||
          shot.sourceSegmentIds.some((id) => typeof id !== "string" || id.length > 100)
        )
          rules.push("citations");
        if (!reason(shot.reason)) rules.push("reason");
      }
      if (rules.length) throw new StudioIllustrationValidationError(index, rules);
      if (shot.prompt !== undefined && (!reason(shot.prompt) || shot.prompt.length > 2000))
        throw Error("STUDIO_ILLUSTRATION_INVALID");
      if (shot.generated) {
        const g = shot.generated;
        if (
          !shot.prompt ||
          g.provider !== "gemini" ||
          !reason(g.model) ||
          !reason(g.reviewerModel) ||
          !Number.isFinite(Date.parse(g.generatedAt)) ||
          !Number.isFinite(Date.parse(g.reviewedAt)) ||
          !g.asset ||
          !/^[a-f0-9]{64}$/.test(g.asset.sha256) ||
          g.asset.mimeType !== "image/png" ||
          !Number.isSafeInteger(g.asset.byteSize) ||
          g.asset.byteSize < 1 ||
          g.asset.byteSize > 16 * 1024 * 1024 ||
          parseStudioAssetKey(g.asset.storageKey)?.filename !== g.asset.filename ||
          !g.checks ||
          (g.checks.iconographyAccurate !== undefined && g.checks.iconographyAccurate !== true) ||
          (g.checks.photorealistic !== undefined && g.checks.photorealistic !== true) ||
          (g.checks.continuityConsistent !== undefined && g.checks.continuityConsistent !== true) ||
          ![
            g.checks.contextFaithful,
            g.checks.nonDeceptive,
            g.checks.noInventedText,
            g.checks.visualQuality,
            g.checks.safeComposition,
          ].every((v) => v === true) ||
          !reason(g.checks.reason)
        )
          throw Error("STUDIO_ILLUSTRATION_INVALID");
      }
      end = shot.endMs;
      total += shot.endMs - shot.startMs;
    }
    const share =
      value.illustrationPolicy === undefined && value.illustrations.some((s) => s.extendedByCurator)
        ? 0.3
        : limits.share;
    if (total > durationMs * share) throw Error("STUDIO_PRESENTATION_REVIEW_INVALID");
  }
  if (citation && value.illustrations?.length)
    return validateStudioSourceScreen(
      {
        ...value,
        illustrations: value.illustrations.map((shot) =>
          alignStudioIllustration(
            shot,
            citation.segments,
            citation.clipStartMs,
            value.illustrationPolicy,
          ),
        ),
      },
      durationMs,
    );
  return value;
}
/** Merge continuous safe crops; reserve transition margins only beside truly unscreened footage. */
export function safeStudioPortraitScenes(
  screen: StudioSourceScreen,
  durationMs: number,
): StudioPortraitScene[] {
  validateStudioSourceScreen(screen, durationMs);
  const scenes: StudioPortraitScene[] = [];
  for (const scene of screen.scenes) {
    const previous = scenes.at(-1);
    if (
      previous?.endMs === scene.startMs &&
      previous.bodyTop === scene.bodyTop &&
      previous.bodyBottom === scene.bodyBottom
    )
      previous.endMs = scene.endMs;
    else scenes.push({ ...scene });
  }
  return scenes
    .map((s, i) => ({
      ...s,
      startMs:
        s.startMs === 0 || scenes[i - 1]?.endMs === s.startMs
          ? s.startMs
          : s.startMs + STUDIO_SOURCE_SCENE_MARGIN_MS,
      endMs:
        s.endMs === durationMs || scenes[i + 1]?.startMs === s.endMs
          ? s.endMs
          : s.endMs - STUDIO_SOURCE_SCENE_MARGIN_MS,
    }))
    .filter((s) => s.endMs > s.startMs);
}
export function validateStudioPresentationReview(
  value: StudioPresentationReview,
  input: { sourceSha256: string; renderedSha256: string; fileVersion: number; durationMs: number },
): void {
  if (
    !value ||
    (value.illustrationMode !== undefined && value.illustrationMode !== "context-generated") ||
    value.policy !== STUDIO_PRESENTATION_POLICY ||
    value.sourceSha256 !== input.sourceSha256 ||
    value.renderedSha256 !== input.renderedSha256 ||
    value.fileVersion !== input.fileVersion ||
    !reason(value.model) ||
    !Number.isFinite(Date.parse(value.reviewedAt)) ||
    !["screened-portrait", "full-picture"].includes(value.framing) ||
    (value.layout !== undefined && !["immersive", "classic"].includes(value.layout)) ||
    !Number.isSafeInteger(value.repairs) ||
    value.repairs < 0 ||
    value.repairs > 1 ||
    !value.checks ||
    ![
      value.checks.illustrationsRelevant,
      value.checks.textIntact,
      value.checks.subjectIntact,
      value.checks.captionsClear,
      value.checks.naturalBoundaries,
    ].every((v) => v === true) ||
    !reason(value.checks.reason)
  )
    throw Error("STUDIO_PRESENTATION_REVIEW_INVALID");
  validateStudioSourceScreen(value.source, input.durationMs);
  if (value.closingCard) validateStudioClosingCard(value.closingCard, input.durationMs);
  const refresh = value.closingRefresh;
  if (
    refresh &&
    (refresh.policy !== "preserved-export-closing-v1" ||
      ![refresh.previousSha256, refresh.cardSha256, refresh.audioSha256].every((v) =>
        /^[a-f0-9]{64}$/.test(v),
      ) ||
      !Number.isSafeInteger(refresh.previousFileVersion) ||
      refresh.previousFileVersion < 1 ||
      refresh.previousFileVersion >= input.fileVersion ||
      !Number.isFinite(Date.parse(refresh.verifiedAt)) ||
      refresh.unchangedUntilMs !== value.closingCard?.startMs ||
      (refresh.cardMeanAbsoluteDifference !== undefined &&
        (!Number.isFinite(refresh.cardMeanAbsoluteDifference) ||
          refresh.cardMeanAbsoluteDifference < 0 ||
          refresh.cardMeanAbsoluteDifference >= 4)) ||
      ![refresh.minimumFrameSsim, refresh.minimumCaptionSsim].every(
        (v) => Number.isFinite(v) && v >= 0.995 && v <= 1,
      ))
  )
    throw Error("STUDIO_CLOSING_PRESERVATION_FAILED");
  const splice = refresh?.splice;
  if (
    splice &&
    (splice.method !== "h264-tail-copy-v1" ||
      !Number.isFinite(splice.startMs) ||
      splice.startMs < 0 ||
      splice.startMs > (refresh?.unchangedUntilMs ?? 0) ||
      !Number.isSafeInteger(splice.copiedPackets) ||
      splice.copiedPackets < 0 ||
      !Number.isSafeInteger(splice.encodedPackets) ||
      splice.encodedPackets < 1 ||
      !/^[a-f0-9]{64}$/.test(splice.timingSha256) ||
      (splice.copiedPackets > 0 && !/^[a-f0-9]{64}$/.test(splice.prefixSha256 ?? "")) ||
      (splice.copiedPackets === 0 && splice.startMs !== 0))
  )
    throw Error("STUDIO_CLOSING_PRESERVATION_FAILED");
  const opening = value.openingCard;
  if (opening) {
    validateStudioOpeningCard(opening, input.durationMs, value.source.scenes);
    if (value.source.illustrations?.some((s) => s.startMs < opening.endMs))
      throw Error("STUDIO_OPENING_CARD_INVALID");
  }
  if (
    value.illustrationMode === "context-generated" &&
    value.source.illustrations?.some((shot) => !shot.generated)
  )
    throw Error("STUDIO_ILLUSTRATION_INVALID");
  if (
    ![
      value.source.openingComplete,
      value.source.endingComplete,
      value.source.naturalStart,
      value.source.naturalEnd,
    ].every((v) => v === true)
  )
    throw Error("STUDIO_PRESENTATION_REVIEW_INVALID");
}

export type StudioIllustrationTiming = { assetId: string; startMs: number; endMs: number };
/** Human-directed timing adjustment reuses the exact image, within its cited words and safe bounds. */
export function retimeStudioIllustrations(
  screen: StudioSourceScreen,
  timings: StudioIllustrationTiming[],
  segments: StudioSegment[],
  clipStartMs: number,
  durationMs: number,
): StudioSourceScreen {
  if (
    new Set(timings.map((t) => t.assetId)).size !== timings.length ||
    timings.some((t) => !screen.illustrations?.some((s) => s.assetId === t.assetId))
  )
    throw Error("STUDIO_ILLUSTRATION_INVALID");
  const result = {
    ...screen,
    illustrations: (screen.illustrations ?? []).map((shot) => {
      const timing = timings.find((t) => t.assetId === shot.assetId);
      if (!timing) return shot;
      const updated = {
        ...shot,
        startMs: timing.startMs,
        endMs: timing.endMs,
        extendedByCurator: true as const,
      };
      const aligned = alignStudioIllustration(updated, segments, clipStartMs);
      if (aligned.startMs !== updated.startMs || aligned.endMs !== updated.endMs)
        throw Error("STUDIO_ILLUSTRATION_INVALID");
      return updated;
    }),
  };
  return validateStudioSourceScreen(result, durationMs, { segments, clipStartMs });
}

/** Preserve both boundary checks even when illustrations supply many interior points. */
export function studioPresentationSampleTimes(durationMs: number, interior: number[]): number[] {
  const last = Math.max(0, durationMs - 250);
  return [
    ...new Set(
      [Math.min(250, last), last, ...interior].map((t) =>
        Math.max(0, Math.min(last, Math.round(t))),
      ),
    ),
  ]
    .slice(0, 8)
    .sort((a, b) => a - b);
}
