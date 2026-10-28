import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioLineage } from "../app/studio-lineage";
import { studioLatestReview, studioOutputLength, studioOutputState } from "./studio-lineage";
import type {
  PublicStudioOutput,
  PublicStudioPackage,
  PublicStudioPublication,
} from "./studio-model";

const output: PublicStudioOutput = {
  id: "output-one",
  channel: "youtube",
  format: "short",
  language: "te",
  title: "Daily practice",
  body: "Serve with kindness.",
  rationale: "A complete teaching",
  included: true,
  sourceSegmentIds: ["one"],
  startMs: 1500,
  endMs: 63500,
  aspect: "9:16",
  captions: [],
  warnings: [],
  asset: {
    filename: "SGS_master-youtube-short-te.mp4",
    sha256: "a".repeat(64),
    byteSize: 1000,
    mimeType: "video/mp4",
  },
};
const pkg: PublicStudioPackage = {
  id: "package-one",
  isTest: false,
  revision: 4,
  status: "APPROVED",
  createdBy: "coordinator",
  contributorIds: ["coordinator"],
  source: {
    masterId: "master-one",
    versionId: "source-one",
    sha256: "a".repeat(64),
    revision: 2,
    title: "Episode 249",
    language: "te",
    category: "pravachanams",
    mimeType: "video/mp4",
  },
  request: { languages: ["te"], instructions: "", channels: ["youtube"], captions: true },
  outputs: [output],
  approval: {
    reviewerId: "admin",
    revision: 4,
    sourceRevision: 2,
    approvedAt: "2026-10-10T10:00:00.000Z",
  },
  provenance: {
    provider: "gemini",
    model: "test",
    promptVersion: "1",
    generatedAt: "2026-10-09T08:00:00.000Z",
    brandName: "SGS Datta Sannidhi",
    brandLogoSha256: "b".repeat(64),
    skippedChannels: [],
    transcript: {
      language: "te",
      durationMs: 70000,
      segments: [{ id: "one", startMs: 0, endMs: 70000, text: "Serve with kindness." }],
      provenance: "APPROVED_TRANSCRIPT",
      sourceTranscriptId: "transcript-one",
    },
  },
  feedback: [],
  failure: null,
  createdAt: "2026-10-09T07:00:00.000Z",
  updatedAt: "2026-10-10T10:00:00.000Z",
};
const publication: PublicStudioPublication = {
  id: "publication-one",
  packageId: pkg.id,
  packageRevision: 4,
  outputId: output.id,
  channel: output.channel,
  isTest: false,
  status: "PUBLISHED",
  attempt: 1,
  error: null,
  errorDetail: null,
  remoteId: "remote-one",
  remoteUrl: "https://youtube.com/watch?v=example",
  createdAt: "2026-10-10T10:10:00.000Z",
  updatedAt: "2026-10-10T10:11:00.000Z",
};

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => vi.unstubAllGlobals());

describe("derived-file lineage length and lifecycle", () => {
  it("labels source clip length separately from rendered video duration", () => {
    expect(studioOutputLength(output)).toEqual({ label: "62 sec", detail: "Source clip" });
    expect(studioOutputLength({ ...output, startMs: null })).toMatchObject({
      label: "Not available",
    });
    expect(studioOutputLength({ ...output, endMs: 500 })).toMatchObject({ label: "Not available" });
    expect(studioOutputLength({ ...output, endMs: Number.NaN })).toMatchObject({
      label: "Not available",
    });
  });
  it("counts blog words and visible post characters without splitting emoji or Indic graphemes", () => {
    expect(
      studioOutputLength({
        ...output,
        format: "blog",
        language: "en",
        body: "Kindness. Service, every day.",
      }).label,
    ).toBe("4 words");
    expect(studioOutputLength({ ...output, format: "post", body: "A👨‍👩‍👧‍👦" }).label).toBe(
      "2 characters",
    );
    expect(studioOutputLength({ ...output, format: "post", body: "శ్రీ" }).label).toBe("1 character");
  });
  it("never carries an older revision, foreign output/channel, or other-world receipt onto the current file", () => {
    for (const receipt of [
      { ...publication, packageRevision: 3 },
      { ...publication, outputId: "another-output" },
      { ...publication, packageId: "another-package" },
      { ...publication, channel: "instagram" as const },
      { ...publication, isTest: true },
    ])
      expect(studioOutputState(pkg, output, [receipt])).toMatchObject({
        label: "Approved",
        detail: "No publication receipt for this revision",
      });
    expect(studioOutputState(pkg, output, [publication]).label).toBe("Published");
  });
  it("takes current package review and exclusions before stale publication receipts", () => {
    expect(
      studioOutputState({ ...pkg, status: "CHANGES_REQUESTED", approval: null }, output, [
        publication,
      ]).label,
    ).toBe("Changes requested");
    expect(
      studioOutputState({ ...pkg, status: "IN_REVIEW", approval: null }, output, [publication])
        .label,
    ).toBe("Awaiting Content Approver review");
    expect(
      studioOutputState(
        {
          ...pkg,
          approval: {
            reviewerId: "admin",
            revision: 3,
            sourceRevision: 2,
            approvedAt: pkg.updatedAt,
          },
        },
        output,
        [publication],
      ).label,
    ).toBe("Review required");
    expect(studioOutputState(pkg, { ...output, included: false }, [publication]).label).toBe(
      "Excluded",
    );
    expect(studioOutputState({ ...pkg, status: "DISCARDED" }, output, [publication]).label).toBe(
      "Discarded",
    );
  });
  it("keeps simulations visibly separate from live publication", () => {
    const testPackage = { ...pkg, isTest: true };
    expect(
      studioOutputState(testPackage, output, [
        { ...publication, isTest: true, status: "SIMULATED" },
      ]).label,
    ).toBe("Test completed — not posted");
    expect(studioOutputState(testPackage, output, [{ ...publication, isTest: true }]).label).toBe(
      "Test result needs verification",
    );
  });
  it("shows the latest matching publication attempt and safe failure copy", () => {
    const newer = {
      ...publication,
      id: "publication-two",
      status: "BLOCKED" as const,
      error: "CHANNEL_NOT_CONNECTED",
      attempt: 2,
      updatedAt: "2026-10-10T10:12:00.000Z",
    };
    expect(studioOutputState(pkg, output, [publication, newer])).toMatchObject({
      label: "Connection or approval required",
      detail: "An Admin must connect the Ashrama's verified account for this channel.",
    });
  });
  it("retains the latest shared review comment and its revision after Coordinator edits", () => {
    const feedback = [
      {
        id: "reject",
        actorId: "admin",
        action: "REJECTED" as const,
        comment: "Correct the attribution.",
        revision: 3,
        createdAt: "2026-10-10T09:00:00.000Z",
      },
      {
        id: "revise",
        actorId: "coordinator",
        action: "REVISED" as const,
        comment: "Revised the title.",
        revision: 4,
        createdAt: "2026-10-10T10:00:00.000Z",
      },
    ];
    expect(studioLatestReview({ ...pkg, feedback })).toMatchObject({
      action: "REJECTED",
      revision: 3,
      comment: "Correct the attribution.",
    });
  });
  it("renders a real table, traces excluded files, and separates generation from later package updates", () => {
    const html = renderToStaticMarkup(
      <StudioLineage
        value={{
          ...pkg,
          outputs: [output, { ...output, id: "excluded", included: false, language: "en" }],
        }}
        publications={[]}
        onPreview={() => {}}
      />,
    );
    expect(html).toContain("Master master-one");
    expect(html).toContain("2 outputs");
    expect(html).toContain('<table class="lineage-table">');
    expect(html).toContain('scope="col">Filename');
    expect(html).toContain('scope="col">File &amp; time');
    expect(html).toContain("Generated</small>");
    expect(html).toContain("Package updated</small>");
    expect(html).toContain('data-included="false"');
    expect(html).toContain("2026-10-09T08:00:00.000Z");
    expect(html).toContain("2026-10-10T10:00:00.000Z");
    expect(html).toContain("Excluded");
  });
  it.each(["QUEUED", "GENERATING"] as const)(
    "explains previous files during %s replacements",
    (status) => {
      const html = renderToStaticMarkup(
        <StudioLineage
          value={{ ...pkg, status, approval: null }}
          publications={[]}
          onPreview={() => {}}
        />,
      );
      expect(html).toContain(
        "Showing previous versions while replacements are generated and checked.",
      );
      expect(html).toContain(output.asset?.filename);
    },
  );
});
