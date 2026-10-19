/** Per-file corrections. Encoder expressions and arbitrary gain never come from the client. */
export type StudioMediaEdits = {
  framing: "auto" | "full-picture";
  portraitFocus: number;
  captions: "default" | "on" | "off";
  subtitleSize: "small" | "standard" | "large";
  speechLevel: "softer" | "standard" | "louder";
  reduceNoise: boolean;
};

export const STUDIO_MEDIA_DEFAULTS: Readonly<StudioMediaEdits> = {
  framing: "auto",
  portraitFocus: 0.5,
  captions: "default",
  subtitleSize: "standard",
  speechLevel: "standard",
  reduceNoise: false,
};

export function validateStudioMediaEdits(value: StudioMediaEdits): void {
  if (
    !value ||
    Object.keys(value).some((key) => !Object.hasOwn(STUDIO_MEDIA_DEFAULTS, key)) ||
    !["auto", "full-picture"].includes(value.framing) ||
    !Number.isFinite(value.portraitFocus) ||
    value.portraitFocus < 0 ||
    value.portraitFocus > 1 ||
    !["default", "on", "off"].includes(value.captions) ||
    !["small", "standard", "large"].includes(value.subtitleSize) ||
    !["softer", "standard", "louder"].includes(value.speechLevel) ||
    typeof value.reduceNoise !== "boolean"
  )
    throw Error("INVALID_STUDIO_MEDIA_EDITS");
}

export function studioCaptionsEnabled(
  edits: StudioMediaEdits | undefined,
  defaultValue: boolean,
): boolean {
  return edits?.captions === "on" || (edits?.captions !== "off" && defaultValue);
}

export function studioSpeechTarget(edits?: StudioMediaEdits): number {
  return edits?.speechLevel === "softer" ? -26 : edits?.speechLevel === "louder" ? -18 : -22;
}

export function studioSubtitleSize(edits?: StudioMediaEdits): number {
  return edits?.subtitleSize === "small" ? 56 : edits?.subtitleSize === "large" ? 80 : 72;
}
