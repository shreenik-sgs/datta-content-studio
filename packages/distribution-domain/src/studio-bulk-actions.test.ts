import { describe, expect, it } from "vitest";
import type { StudioPublication } from "./intelligent-content";
import { studioRetractionDecision, studioSelectedOutputs } from "./studio-bulk-actions";

it("treats a selected file list as an exact scope, rejecting stale or empty selections", () => {
  const outputs = [
    { id: "a", included: true },
    { id: "b", included: true },
    { id: "c", included: false },
  ];
  expect(studioSelectedOutputs(outputs, ["b"])).toEqual([outputs[1]]);
  expect(studioSelectedOutputs(outputs)).toEqual(outputs.slice(0, 2));
  for (const selection of [[], ["a", "a"], ["c"], ["missing"]])
    expect(() => studioSelectedOutputs(outputs, selection)).toThrow(
      "INVALID_STUDIO_OUTPUT_SELECTION",
    );
});
describe("truthful retraction", () => {
  const job = { status: "QUEUED", isTest: false, remoteId: null, channel: "youtube" } as const;
  it("cancels only unsent local jobs, simulated posts and the app's own blog", () => {
    expect(studioRetractionDecision(job, false)).toBe("CANCELLED");
    expect(studioRetractionDecision({ ...job, status: "BLOCKED" }, false)).toBe("CANCELLED");
    expect(studioRetractionDecision({ ...job, status: "SIMULATED", isTest: true }, false)).toBe(
      "CANCELLED",
    );
    expect(
      studioRetractionDecision({ ...job, status: "PUBLISHED", channel: "website" }, false),
    ).toBe("CANCELLED");
    expect(studioRetractionDecision({ ...job, status: "CANCELLED" }, false)).toBe(
      "ALREADY_CANCELLED",
    );
  });
  it("never mistakes a provider receipt, active send or published YouTube post for local cancellation", () => {
    for (const status of [
      "RUNNING",
      "PROCESSING",
      "UNCERTAIN",
      "FAILED",
    ] as StudioPublication["status"][])
      expect(studioRetractionDecision({ ...job, status }, false)).toBe("CHECK_CHANNEL");
    expect(studioRetractionDecision({ ...job, remoteId: "receipt" }, false)).toBe("CHECK_CHANNEL");
    expect(studioRetractionDecision(job, true)).toBe("CHECK_CHANNEL");
    expect(studioRetractionDecision({ ...job, status: "SIMULATED" }, false)).toBe("CHECK_CHANNEL");
    expect(studioRetractionDecision({ ...job, status: "PUBLISHED", remoteId: "video" }, true)).toBe(
      "REMOVE_ON_CHANNEL",
    );
  });
});
