import { describe, expect, it } from "vitest";
import { closingFixture } from "./studio-closing-test-fixture.js";
import { studioGenerationPreviews } from "./studio-generation-previews.js";

const startedAt = "2026-10-26T01:00:00.000Z";

describe("saved previews during a playlist pause", () => {
  it("requires an audited pause before showing checkpoints from an empty draft", () => {
    const { pkg, prior } = closingFixture();
    const paused = { ...pkg, status: "DRAFT" as const };
    const entries = { "output:youtube:en": { value: prior } };
    expect(studioGenerationPreviews(paused, startedAt, entries)).toEqual([]);
    expect(studioGenerationPreviews(paused, startedAt, entries, true)).toMatchObject([
      { id: prior.id, asset: prior.asset },
    ]);
  });

  it("does not turn saved previews into outputs or expose them after completion", () => {
    const { pkg, prior } = closingFixture();
    const paused = { ...pkg, status: "DRAFT" as const };
    const entries = { "output:youtube:en": { value: prior } };
    studioGenerationPreviews(paused, startedAt, entries, true);
    expect(paused.outputs).toEqual([]);
    expect(paused.approval).toBeNull();
    expect(
      studioGenerationPreviews({ ...paused, outputs: [prior] }, startedAt, entries, true),
    ).toEqual([]);
  });

  it("still rejects tampered media and incomplete review evidence while paused", () => {
    const { pkg, prior } = closingFixture();
    if (!prior.asset || !prior.aiReview) throw Error("fixture");
    const paused = { ...pkg, status: "DRAFT" as const };
    for (const value of [
      { ...prior, asset: { ...prior.asset, sha256: "f".repeat(64) } },
      {
        ...prior,
        aiReview: {
          ...prior.aiReview,
          checks: { ...prior.aiReview.checks, endingComplete: false },
        },
      },
    ]) {
      expect(
        studioGenerationPreviews(paused, startedAt, { "output:youtube:en": { value } }, true),
      ).toEqual([]);
    }
  });
});
