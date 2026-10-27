import { describe, expect, it } from "vitest";
import type { StudioPackage } from "./intelligent-content";
import {
  STUDIO_MEDIA_PIPELINE_VERSION,
  STUDIO_PRESENTATION_REVIEWER_VERSION,
  STUDIO_RENDERER_VERSION,
  studioGenerationRecoverable,
  studioGenerationRecovery,
  studioGenerationRecoveryDeferred,
  studioGenerationRecoveryRequest,
  studioMediaPipeline,
} from "./studio-generation-recovery";

describe("studio media pipeline identity", () => {
  it("keeps the existing cache-invalidating values so saved renders and reviews stay valid", () => {
    expect(STUDIO_RENDERER_VERSION).toBe("full-picture-clean-hold-v1");
    expect(STUDIO_PRESENTATION_REVIEWER_VERSION).toBe(6);
    expect(STUDIO_MEDIA_PIPELINE_VERSION).toBe(
      "full-picture-clean-hold-v1/review-6/audio-only-native-boundaries-v2/speaker-first-framing-v2/source-safe-portrait-v1",
    );
  });
  it("extends the pipeline with a well-formed release tag only", () => {
    expect(studioMediaPipeline({})).toBe(STUDIO_MEDIA_PIPELINE_VERSION);
    expect(studioMediaPipeline({ STUDIO_RELEASE: " a2cbe84 " })).toBe(
      `${STUDIO_MEDIA_PIPELINE_VERSION}@a2cbe84`,
    );
    expect(studioMediaPipeline({ STUDIO_RELEASE: "bad tag;rm" })).toBe(
      STUDIO_MEDIA_PIPELINE_VERSION,
    );
  });
});

describe("automatic recovery decision", () => {
  const current = "pipeline-b";
  it("retries only the Studio's own media failures", () => {
    for (const failure of [
      "STUDIO_PRESENTATION_REPAIR_REQUIRED",
      "STUDIO_PRESENTATION_BOUNDARY_REQUIRED",
      "RENDER_TIMEOUT",
      "RENDER_STALLED",
      "RENDER_PROCESS_FAILED",
      "GENERATION_FAILED",
    ]) {
      expect(studioGenerationRecoverable(failure)).toBe(true);
      expect(
        studioGenerationRecovery({
          failure,
          progress: { mediaPipeline: "pipeline-a" },
          currentPipeline: current,
        }),
      ).toBe("retry");
    }
    for (const failure of [
      "STUDIO_NO_SUITABLE_CHANNELS",
      "PLAYLIST_SETTINGS_PAUSED",
      "REQUESTER_ROLE_REVOKED",
      "SOURCE_DEPENDENCY_CHANGED",
      "RETRY_EXHAUSTED",
      "STUDIO_PROVIDER_SPEND_CAP_REACHED",
      "STUDIO_TRANSCRIPTION_CONTEXT_LIMIT",
      null,
      undefined,
    ]) {
      expect(studioGenerationRecoverable(failure)).toBe(false);
      expect(
        studioGenerationRecovery({ failure, progress: null, currentPipeline: current }),
      ).toBeNull();
    }
  });
  it("retries a failure recorded by an older or unknown worker exactly once per pipeline", () => {
    const failure = "STUDIO_PRESENTATION_REPAIR_REQUIRED";
    expect(studioGenerationRecovery({ failure, progress: null, currentPipeline: current })).toBe(
      "retry",
    );
    expect(
      studioGenerationRecovery({
        failure,
        progress: { mediaPipeline: current },
        currentPipeline: current,
      }),
    ).toBeNull();
    expect(
      studioGenerationRecovery({
        failure,
        progress: {
          mediaPipeline: "pipeline-a",
          recovery: { mediaPipeline: current, at: "2026-10-27T00:00:00.000Z", outcome: "declined" },
        },
        currentPipeline: current,
      }),
    ).toBeNull();
    expect(
      studioGenerationRecovery({
        failure,
        progress: {
          mediaPipeline: "pipeline-a",
          recovery: {
            mediaPipeline: "pipeline-a",
            at: "2026-10-27T00:00:00.000Z",
            outcome: "requeued",
          },
        },
        currentPipeline: current,
      }),
    ).toBe("retry");
  });
  it("keeps paused and authority-unavailable refusals eligible and declines the rest", () => {
    expect(studioGenerationRecoveryDeferred("PLAYLIST_SETTINGS_PAUSED")).toBe(true);
    expect(studioGenerationRecoveryDeferred("OPERATOR_AUTHORITY_UNAVAILABLE")).toBe(true);
    expect(studioGenerationRecoveryDeferred("REQUESTER_ROLE_REVOKED")).toBe(false);
    expect(studioGenerationRecoveryDeferred("STUDIO_TARGET_SETTINGS_CHANGED")).toBe(false);
  });
});

describe("recovery request", () => {
  const base = { status: "FAILED", revision: 22, generation: null } as unknown as StudioPackage;
  it("repeats an initial run, a discovery and a scoped correction unchanged", () => {
    expect(studioGenerationRecoveryRequest(base)).toEqual({ expectedRevision: 22 });
    expect(
      studioGenerationRecoveryRequest({
        ...base,
        generation: { outputIds: [], mode: "discover" },
      }),
    ).toEqual({ expectedRevision: 22, mode: "discover" });
    const timings = [{ outputId: "o1", startMs: 10, endMs: 20 }];
    expect(
      studioGenerationRecoveryRequest({
        ...base,
        generation: {
          outputIds: ["o1"],
          mode: "closing",
          steadyOpening: true,
          closingDestinations: { o1: "youtube" },
          illustrationTimings: timings as never,
        },
      }),
    ).toEqual({
      expectedRevision: 22,
      mode: "closing",
      outputIds: ["o1"],
      steadyOpening: true,
      closingDestinations: { o1: "youtube" },
      illustrationTimings: timings,
    });
  });
  it("never requeues a package that is not failed", () => {
    expect(() => studioGenerationRecoveryRequest({ ...base, status: "DRAFT" })).toThrow(
      "INVALID_STUDIO_TRANSITION",
    );
  });
});
