import { describe, expect, it } from "vitest";
import { liveCurationWindow, validateLiveCurationSettings } from "./live-curation";

describe("live teaching windows", () => {
  const segments = Array.from({ length: 300 }, (_, i) => ({ sequence: 100 + i, durationMs: 2000 }));
  it("waits for context, overlaps three minutes and assigns each start once", () => {
    expect(liveCurationWindow(segments.slice(0, 250), false)).toBeNull();
    expect(liveCurationWindow(segments, false)).toEqual({
      count: 300,
      nextIndex: 210,
      durationMs: 600000,
      ownedEndMs: 420000,
    });
    expect(liveCurationWindow(segments.slice(210), true)).toEqual({
      count: 90,
      nextIndex: 90,
      durationMs: 180000,
      ownedEndMs: 180001,
    });
  });
  it("never stitches missing segments or accepts invalid timing", () => {
    expect(() =>
      liveCurationWindow(
        [
          { sequence: 100, durationMs: 2000 },
          { sequence: 102, durationMs: 2000 },
        ],
        true,
      ),
    ).toThrow("LIVE_CAPTURE_GAP");
    expect(() => liveCurationWindow([{ sequence: 1, durationMs: Number.NaN }], true)).toThrow(
      "LIVE_CAPTURE_GAP",
    );
    expect(liveCurationWindow([], true)).toBeNull();
  });
  it("requires actual current public permission, while allowing a monitor to be paused", () => {
    const settings = {
      channelId: `UC${"a".repeat(22)}`,
      channelName: "Configured channel",
      enabled: true,
      language: "te",
      rights: {
        owner: "Owner",
        authorizationBasis: "Owner permission",
        channels: ["youtube" as const],
        territories: ["WORLDWIDE"],
        privacyClass: "PUBLIC" as const,
        releaseAt: null,
        expiresAt: "2026-01-01T00:00:00Z",
      },
    };
    expect(() => validateLiveCurationSettings(settings, Date.parse("2026-10-14"))).toThrow(
      "LIVE_CURATION_RIGHTS_REQUIRED",
    );
    expect(() =>
      validateLiveCurationSettings({ ...settings, enabled: false }, Date.parse("2026-10-14")),
    ).not.toThrow();
  });
});
