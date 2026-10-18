import { describe, expect, it } from "vitest";
import { renderBudgetSchema, renderRecipeSchema, renderRequestSchema } from "./variants";
const id = "0193fd85-5213-7510-8139-981af6339219";
describe("DS-DIST-R3 versioned rendering contracts", () => {
  it("DS-DIST-R3-SOURCE accepts references, never user-supplied sacred caption overrides", () => {
    const request = {
      masterId: id,
      expectedSourceRevision: 3,
      transcriptVersionId: id,
      quoteId: null,
      translationId: null,
      template: { id: "sgs", version: 1 },
      aspect: "9:16",
      language: "en",
      startMs: 0,
      endMs: 1000,
      captionMode: "approved_transcript",
      channel: "manual_export",
      territory: "WORLDWIDE",
    };
    expect(renderRequestSchema.parse(request)).toEqual(request);
    for (const placement of ["youtube_shorts", "instagram", "facebook", "x", "reddit", "website"]) {
      expect(renderRequestSchema.parse({ ...request, placement }).placement).toBe(placement);
    }
    expect(() => renderRequestSchema.parse({ ...request, placement: "../../private" })).toThrow();
    expect(() =>
      renderRequestSchema.parse({ ...request, channel: "youtube", placement: "instagram" }),
    ).toThrow();
    expect(() =>
      renderRequestSchema.parse({ ...request, channel: "telegram", placement: "youtube" }),
    ).toThrow();
    expect(() => renderRequestSchema.parse({ ...request, captions: ["invented"] })).toThrow();
    expect(() => renderRequestSchema.parse({ ...request, startMs: 5000 })).toThrow();
  });
  it("DS-DIST-R3-DETERMINISM refuses mismatched output aspect and out-of-clip captions", () => {
    const recipe = {
      schemaVersion: 1,
      sourceVersionId: id,
      sourceSha256: "a".repeat(64),
      sourceRevision: 2,
      transcriptVersionId: id,
      transcriptRevision: 2,
      quoteId: null,
      quoteRevision: null,
      translationId: null,
      translationRevision: null,
      template: { id: "sgs", version: 1 },
      aspect: "1:1",
      width: 1080,
      height: 1080,
      fit: "contain",
      language: "en",
      startMs: 0,
      endMs: 1000,
      captions: [{ startMs: 0, endMs: 1000, text: "Datta" }],
      channel: "manual_export",
      territory: "WORLDWIDE",
    };
    expect(renderRecipeSchema.parse(recipe)).toEqual(recipe);
    expect(renderRecipeSchema.parse({ ...recipe, placement: "instagram" }).placement).toBe(
      "instagram",
    );
    expect(() =>
      renderRecipeSchema.parse({ ...recipe, channel: "youtube", placement: "instagram" }),
    ).toThrow();
    expect(() => renderRecipeSchema.parse({ ...recipe, height: 1920 })).toThrow();
    expect(() =>
      renderRecipeSchema.parse({
        ...recipe,
        captions: [{ startMs: 0, endMs: 5000, text: "Datta" }],
      }),
    ).toThrow();
  });
  it("DS-DIST-R3-BUDGET accepts integer costs only and bounded retry attempts", () => {
    expect(() => renderBudgetSchema.parse({ estimatedCostMicros: -1 })).toThrow();
  });
});
