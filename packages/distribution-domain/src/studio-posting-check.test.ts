import { describe, expect, it } from "vitest";
import type { StudioOutput, StudioPackage, StudioPublication } from "./intelligent-content";
import {
  postingCheckBlock,
  studioChannelPostingMatches,
  studioExcerptIdentity,
  studioKnownPostingMatch,
} from "./studio-posting-check";
const output = {
  id: "out",
  format: "short",
  language: "en",
  title: "Learn to be patient when someone insults you",
  body: "A complete and specific teaching about practicing patience when someone insults you and responding calmly instead of angrily.",
  startMs: 1000,
  endMs: 50000,
  sourceSegmentIds: ["a", "b"],
  asset: { sha256: "a".repeat(64) },
} as StudioOutput;
const previous = (changes: Partial<StudioOutput> = {}, status = "PUBLISHED") => ({
  publication: {
    outputId: "out",
    status,
    remoteUrl: "https://www.youtube.com/watch?v=abcdefghijk",
    updatedAt: "2026-10-23T00:00:00Z",
  } as StudioPublication,
  package: { source: { sha256: "source" }, outputs: [{ ...output, ...changes }] } as StudioPackage,
});
describe("per-channel content identity", () => {
  it("recognizes a re-render with a new closing card and a new output id", () => {
    const result = studioKnownPostingMatch(
      "source",
      { ...output, id: "copy", asset: { sha256: "b".repeat(64) } },
      previous(),
    );
    expect(result).toMatchObject({ state: "POSTED", reason: "SAME_EXCERPT" });
  });
  it("recognizes identical files from another master", () =>
    expect(studioKnownPostingMatch("other", { ...output, id: "copy" }, previous())?.reason).toBe(
      "SAME_FILE",
    ));
  it("recognizes an edited version of an output", () =>
    expect(
      studioKnownPostingMatch(
        "source",
        { ...output, sourceTrim: { startMs: 3000, endMs: 50000 }, asset: null },
        previous(),
      )?.reason,
    ).toBe("SAME_OUTPUT"));
  it("does not confuse distinct excerpts or translated versions", () => {
    expect(
      studioKnownPostingMatch(
        "source",
        { ...output, id: "new", asset: null, startMs: 80000, endMs: 120000 },
        previous(),
      ),
    ).toBeNull();
    expect(studioExcerptIdentity("source", output)).not.toBe(
      studioExcerptIdentity("source", { ...output, language: "te" }),
    );
  });
  it("never calls a simulation or cancelled send posted", () => {
    for (const status of ["SIMULATED", "CANCELLED", "BLOCKED"])
      expect(studioKnownPostingMatch("source", output, previous({}, status))).toBeNull();
  });
  it("holds uncertain sends instead of trying again", () =>
    expect(studioKnownPostingMatch("source", output, previous({}, "UNCERTAIN"))?.state).toBe(
      "NEEDS_REVIEW",
    ));
  it("treats metadata as a possible duplicate, not publication proof", () => {
    const result = studioChannelPostingMatches(output, [
      {
        id: "native",
        title: `${output.title.toUpperCase()}!`,
        text: "",
        status: "sent",
        url: null,
        sentAt: null,
        assetSha256: null,
      },
    ]);
    expect(result[0]).toMatchObject({ state: "NEEDS_REVIEW", reason: "SIMILAR_METADATA" });
  });
  it("does not match short generic titles, unrelated text, or channel drafts", () => {
    expect(
      studioChannelPostingMatches({ ...output, title: "Peace" }, [
        {
          id: "x",
          title: "Peace",
          text: "",
          status: "sent",
          url: null,
          sentAt: null,
          assetSha256: null,
        },
      ]),
    ).toEqual([]);
    expect(
      studioChannelPostingMatches(output, [
        {
          id: "x",
          title: output.title,
          text: output.body,
          status: "draft",
          url: null,
          sentAt: null,
          assetSha256: null,
        },
      ]),
    ).toEqual([]);
  });
  it("blocks unavailable history rather than treating it as empty", () =>
    expect(
      postingCheckBlock({
        checkedAt: "now",
        destination: "youtube",
        scanned: 0,
        matches: [],
        error: "STUDIO_POSTING_CHECK_UNAVAILABLE",
      }),
    ).toBe("STUDIO_POSTING_CHECK_UNAVAILABLE"));
});
