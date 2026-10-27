import { describe, expect, it } from "vitest";
import type { StudioPublication } from "./intelligent-content";
import {
  studioPublicationRetryDecision,
  studioPublishingShouldPause,
  studioRetractionDecision,
  studioSelectedOutputs,
} from "./studio-bulk-actions";

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

describe("explicit retry of earlier posting requests", () => {
  it("re-queues a blocked local request and sends a channel-rejected one afresh", () => {
    expect(studioPublicationRetryDecision({ status: "BLOCKED", remoteId: null }, false)).toBe(
      "REQUEUE",
    );
    expect(studioPublicationRetryDecision({ status: "FAILED", remoteId: "buffer-1" }, true)).toBe(
      "FRESH_ATTEMPT",
    );
    expect(studioPublicationRetryDecision({ status: "FAILED", remoteId: null }, false)).toBe(
      "FRESH_ATTEMPT",
    );
  });
  it("never repeats a request whose outcome is unknown, active or complete", () => {
    expect(studioPublicationRetryDecision({ status: "BLOCKED", remoteId: "buffer-1" }, false)).toBe(
      null,
    );
    expect(studioPublicationRetryDecision({ status: "BLOCKED", remoteId: null }, true)).toBe(null);
    for (const status of [
      "QUEUED",
      "RUNNING",
      "PROCESSING",
      "PUBLISHED",
      "SIMULATED",
      "UNCERTAIN",
      "CANCELLED",
    ] as StudioPublication["status"][])
      expect(studioPublicationRetryDecision({ status, remoteId: null }, false)).toBe(null);
  });
  it("pauses an account only after three consecutive channel rejections", () => {
    expect(studioPublishingShouldPause(["FAILED", "FAILED", "FAILED"])).toBe(true);
    expect(studioPublishingShouldPause(["FAILED", "FAILED", "FAILED", "PUBLISHED"])).toBe(true);
    expect(studioPublishingShouldPause(["FAILED", "FAILED"])).toBe(false);
    expect(studioPublishingShouldPause(["FAILED", "PUBLISHED", "FAILED"])).toBe(false);
    expect(studioPublishingShouldPause([])).toBe(false);
  });
});
