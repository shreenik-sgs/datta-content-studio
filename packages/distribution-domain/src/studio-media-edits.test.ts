import { describe, expect, it } from "vitest";
import {
  STUDIO_MEDIA_DEFAULTS,
  studioCaptionsEnabled,
  studioSpeechTarget,
  studioSubtitleSize,
  validateStudioMediaEdits,
} from "./studio-media-edits";

describe("manual per-file media adjustments", () => {
  it.each([
    { portraitFocus: Number.NaN },
    { portraitFocus: 1.1 },
    { portraitFocus: -0.1 },
    { framing: "stretch" },
    { speechLevel: "unlimited" },
    { subtitleSize: "huge" },
    { captions: "sometimes" },
    { reduceNoise: "true" },
    { filter: "amovie=secret" },
  ])("rejects invalid or unbounded encoder input %j", (override) => {
    expect(() =>
      validateStudioMediaEdits({ ...STUDIO_MEDIA_DEFAULTS, ...override } as never),
    ).toThrow("INVALID_STUDIO_MEDIA_EDITS");
  });
  it("preserves legacy defaults and permits explicit caption overrides", () => {
    expect(() => validateStudioMediaEdits({ ...STUDIO_MEDIA_DEFAULTS })).not.toThrow();
    expect(studioCaptionsEnabled(undefined, true)).toBe(true);
    expect(studioCaptionsEnabled(undefined, false)).toBe(false);
    expect(studioCaptionsEnabled({ ...STUDIO_MEDIA_DEFAULTS, captions: "off" }, true)).toBe(false);
    expect(studioCaptionsEnabled({ ...STUDIO_MEDIA_DEFAULTS, captions: "on" }, false)).toBe(true);
    expect(studioSpeechTarget()).toBe(-22);
    expect(studioSpeechTarget({ ...STUDIO_MEDIA_DEFAULTS, speechLevel: "louder" })).toBe(-18);
    expect(studioSubtitleSize({ ...STUDIO_MEDIA_DEFAULTS, subtitleSize: "small" })).toBe(56);
  });
});
