import { describe, expect, it } from "vitest";
import {
  type StudioHistoryEntry,
  mergeStudioHistory,
  readStudioHistory,
  studioHistoricalFileChange,
  studioHistoryChange,
} from "./studio-history-model";
import type { PublicStudioOutput, PublicStudioPackage } from "./studio-model";

const packageId = "11111111-1111-4111-8111-111111111111";
const output: PublicStudioOutput = {
  id: "22222222-2222-4222-8222-222222222222",
  channel: "x",
  format: "post",
  language: "en",
  title: "Source excerpt",
  body: "Source excerpt. SGS Datta Sannidhi",
  rationale: "Source based",
  included: true,
  sourceSegmentIds: ["one"],
  startMs: null,
  endMs: null,
  aspect: "4:5",
  asset: {
    filename: "source_x_post.png",
    sha256: "a".repeat(64),
    byteSize: 123,
    mimeType: "image/png",
  },
  captions: [],
  warnings: [],
};
function entry(
  revision: number,
  status: PublicStudioPackage["status"] = "DRAFT",
): StudioHistoryEntry {
  return {
    revision,
    action: status === "APPROVED" ? "APPROVED" : "GENERATED",
    actorId: "actor",
    createdAt: "2026-10-10T12:30:00.000Z",
    package: {
      id: packageId,
      revision,
      isTest: true,
      status,
      source: {
        masterId: "master",
        versionId: "source",
        revision: 1,
        sha256: "b".repeat(64),
        title: "Master",
        language: "en",
        category: "other",
        mimeType: "video/mp4",
      },
      createdBy: "author",
      contributorIds: ["author"],
      request: { languages: ["en"], channels: ["x"], instructions: "", captions: true },
      outputs: [structuredClone(output)],
      provenance: null,
      approval: null,
      feedback: [],
      failure: null,
      createdAt: "2026-10-10T12:00:00.000Z",
      updatedAt: "2026-10-10T12:30:00.000Z",
    },
  };
}
function firstOutput(value: StudioHistoryEntry) {
  const result = value.package.outputs[0];
  if (!result) throw new Error("MISSING_TEST_OUTPUT");
  return result;
}
describe("Studio history metadata", () => {
  it("accepts only the current protocol and the requested package's matching revision", () => {
    const page = { version: 1, revisions: [entry(2)], nextOffset: 20 };
    expect(readStudioHistory(page, packageId)).toEqual(page);
    expect(() => readStudioHistory({ ...page, version: 2 }, packageId)).toThrow();
    expect(() => readStudioHistory(page, "another-package")).toThrow();
    expect(() =>
      readStudioHistory({ ...page, revisions: [{ ...entry(2), revision: 3 }] }, packageId),
    ).toThrow();
    expect(() => readStudioHistory({ ...page, nextOffset: -1 }, packageId)).toThrow();
  });
  it("deduplicates overlapping pages while keeping descending revision order", () => {
    expect(
      mergeStudioHistory([entry(4), entry(3)], [entry(3), entry(2)]).map((value) => value.revision),
    ).toEqual([4, 3, 2]);
  });
  it("does not call approval a new file version", () => {
    const earlier = entry(2);
    const approved = entry(3, "APPROVED");
    expect(studioHistoryChange(approved, earlier)).toBe("Workflow update · files unchanged");
    expect(studioHistoricalFileChange(firstOutput(approved), earlier, 3)).toBe("Files unchanged");
  });
  it("separates content selection changes from unchanged file bytes", () => {
    const earlier = entry(2);
    const changed = entry(3);
    firstOutput(changed).included = false;
    expect(studioHistoryChange(changed, earlier)).toBe("Content or file selection changed");
    expect(studioHistoricalFileChange(firstOutput(changed), earlier, 3)).toBe("Files unchanged");
  });
  it("detects changed assets and never claims unavailable or unpaged files are unchanged", () => {
    const earlier = entry(2);
    const changed = entry(3);
    const changedAsset = firstOutput(changed).asset;
    if (!changedAsset) throw new Error("MISSING_TEST_ASSET");
    changedAsset.sha256 = "c".repeat(64);
    expect(studioHistoricalFileChange(firstOutput(changed), earlier, 3)).toBe(
      "File or captions changed",
    );
    expect(studioHistoricalFileChange(firstOutput(changed), undefined, 3)).toBe(
      "Load the previous activity to compare",
    );
    firstOutput(changed).asset = null;
    expect(studioHistoricalFileChange(firstOutput(changed), earlier, 3)).toBe(
      "File needs generation",
    );
  });
});
