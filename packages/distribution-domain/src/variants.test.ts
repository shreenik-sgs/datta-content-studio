import { describe, expect, it } from "vitest";
import {
  type ContentMaster,
  type QuoteCandidate,
  type TranscriptVersion,
  buildRenderRecipe,
  canonicalRenderRecipe,
  renderBudgetDecision,
} from "./index";
const now = "2026-09-29T12:00:00Z";
const master: ContentMaster = {
  id: "m",
  title: "Flute",
  language: "en",
  category: "sacred_flute",
  isTest: true,
  revision: 3,
  state: "APPROVED",
  currentVersion: {
    id: "v",
    masterId: "m",
    number: 1,
    sha256: "a".repeat(64),
    byteSize: 40,
    mimeType: "video/mp4",
    originalName: "flute.mp4",
    createdAt: now,
    createdBy: "editor",
  },
  rights: {
    owner: "SGS",
    territories: ["WORLDWIDE"],
    channels: ["manual_export"],
    authorizationBasis: "Permission",
    privacyClass: "PUBLIC",
    releaseAt: null,
    expiresAt: null,
  },
  approval: { versionId: "v", approvedRevision: 3, reviewerId: "human", approvedAt: now },
  createdAt: now,
  updatedAt: now,
};
const transcript: TranscriptVersion = {
  id: "t",
  parentVersionId: null,
  number: 1,
  masterVersionId: "v",
  sourceSha256: "a".repeat(64),
  language: "en",
  revision: 2,
  durationMs: 20000,
  segments: [
    {
      id: "s1",
      startMs: 2000,
      endMs: 5000,
      originalText: "Jaya Guru Datta.",
      displayText: "Jaya Guru Datta.",
    },
  ],
  provenance: {
    provider: "manual",
    model: null,
    promptVersion: null,
    schemaVersion: 1,
    recipeVersion: "manual-v1",
  },
  review: { decision: "APPROVED", reviewerId: "human", reviewedAt: now, revision: 2 },
};
const quote: QuoteCandidate = {
  id: "q",
  kind: "EXACT_QUOTE",
  masterVersionId: "v",
  sourceSha256: "a".repeat(64),
  transcriptVersionId: "t",
  transcriptRevision: 2,
  segmentIds: ["s1"],
  startMs: 2000,
  endMs: 5000,
  text: "Jaya Guru Datta.",
  revision: 2,
  review: { decision: "APPROVED", reviewerId: "human", reviewedAt: now, revision: 2 },
  provenance: transcript.provenance,
};
const input = {
  master,
  transcript,
  quote,
  template: { id: "sgs-caption", version: 1 },
  aspect: "9:16" as const,
  language: "en",
  startMs: 2000,
  endMs: 5000,
  captionMode: "approved_quote" as const,
  channel: "manual_export" as const,
  territory: "WORLDWIDE",
  now,
};
describe("DS-DIST-R3 immutable render recipes", () => {
  it("binds intended destination into the recipe without changing legacy recipe hashes", () => {
    const legacy = buildRenderRecipe(input);
    expect(Object.hasOwn(legacy, "placement")).toBe(false);
    const instagram = buildRenderRecipe({ ...input, placement: "instagram" });
    const facebook = buildRenderRecipe({ ...input, placement: "facebook" });
    expect(instagram.placement).toBe("instagram");
    expect(canonicalRenderRecipe(instagram)).not.toBe(canonicalRenderRecipe(legacy));
    expect(canonicalRenderRecipe(instagram)).not.toBe(canonicalRenderRecipe(facebook));
    expect(() =>
      buildRenderRecipe({ ...input, channel: "youtube", placement: "instagram" }),
    ).toThrow("INVALID_RENDER_PLACEMENT");
    expect(() =>
      buildRenderRecipe({ ...input, channel: "telegram", placement: "facebook" }),
    ).toThrow("INVALID_RENDER_PLACEMENT");
  });
  it("DS-DIST-R3-DETERMINISM produces identical canonical recipes and aspect dimensions", () => {
    const first = buildRenderRecipe(input);
    expect(canonicalRenderRecipe(first)).toBe(canonicalRenderRecipe(buildRenderRecipe(input)));
    expect(first).toMatchObject({
      width: 1080,
      height: 1920,
      sourceSha256: "a".repeat(64),
      captions: [{ startMs: 0, endMs: 3000, text: "Jaya Guru Datta." }],
    });
    for (const [aspect, width, height] of [
      ["16:9", 1920, 1080],
      ["4:5", 1080, 1350],
      ["1:1", 1080, 1080],
    ] as const)
      expect(buildRenderRecipe({ ...input, aspect })).toMatchObject({ width, height });
  });
  it("DS-DIST-R3-SOURCE refuses withdrawn, stale and invented source material", () => {
    expect(() =>
      buildRenderRecipe({ ...input, master: { ...master, state: "WITHDRAWN" } }),
    ).toThrow("WITHDRAWN");
    expect(() => buildRenderRecipe({ ...input, quote: { ...quote, text: "Invented" } })).toThrow(
      "QUOTE_TEXT_MISMATCH",
    );
    expect(() => buildRenderRecipe({ ...input, quote: { ...quote, review: null } })).toThrow(
      "QUOTE_NOT_APPROVED",
    );
    expect(() =>
      buildRenderRecipe({ ...input, transcript: { ...transcript, sourceSha256: "b".repeat(64) } }),
    ).toThrow("SOURCE_MISMATCH");
    expect(() => buildRenderRecipe({ ...input, startMs: 3000 })).toThrow("INVALID_SOURCE_SPAN");
  });
  it("DS-DIST-R3-TRANSLATION requires explicit approval bound to the exact source revision", () => {
    expect(() => buildRenderRecipe({ ...input, language: "te" })).toThrow(
      "TRANSLATION_NOT_APPROVED",
    );
    const translation = {
      id: "tr",
      sourceId: "q",
      sourceRevision: 2,
      sourceSha256: "a".repeat(64),
      language: "te",
      startMs: 2000,
      endMs: 5000,
      text: "జయ గురు దత్త",
      revision: 2,
      review: { decision: "APPROVED" as const, reviewerId: "human", reviewedAt: now, revision: 2 },
    };
    expect(buildRenderRecipe({ ...input, language: "te", translation }).captions[0]?.text).toBe(
      translation.text,
    );
    expect(() =>
      buildRenderRecipe({
        ...input,
        language: "te",
        translation: { ...translation, sourceRevision: 1 },
      }),
    ).toThrow("TRANSLATION_NOT_APPROVED");
  });
  it("DS-DIST-R3-SOURCE clips reviewed subtitle timecodes without altering words", () => {
    const recipe = buildRenderRecipe({
      ...input,
      quote: undefined,
      captionMode: "approved_transcript",
      startMs: 0,
      endMs: 10000,
    });
    expect(recipe.captions).toEqual([{ startMs: 2000, endMs: 5000, text: "Jaya Guru Datta." }]);
  });
  it("DS-DIST-R3-BUDGET counts reservations and bounds retries and approved costs", () => {
    const budget = {
      estimatedCostMicros: 20,
      budgetMicros: 100,
      reservedMicros: 40,
      spentMicros: 30,
      attempt: 1,
      maxAttempts: 3,
      approvedCostCeilingMicros: 25,
    };
    expect(renderBudgetDecision(budget)).toEqual({ allowed: true });
    expect(renderBudgetDecision({ ...budget, reservedMicros: 60 })).toMatchObject({
      reason: "BUDGET_EXCEEDED",
    });
    expect(renderBudgetDecision({ ...budget, estimatedCostMicros: 26 })).toMatchObject({
      reason: "COST_APPROVAL_REQUIRED",
    });
    expect(renderBudgetDecision({ ...budget, attempt: 4 })).toMatchObject({
      reason: "RETRY_LIMIT",
    });
  });
});
