import type { StudioOutput, StudioPackage } from "@satsang/distribution-domain";
import { beforeEach, expect, it, vi } from "vitest";
import { refreshStudioClosingOutputs } from "./studio-closing-refresh";
import {
  refreshStudioPreviewClosings,
  studioPreviewClosingCandidates,
} from "./studio-preview-closing";
vi.mock("@satsang/distribution-db", () => ({
  studioGenerationPreviews: vi.fn(() => [{ id: "preview" }]),
}));
vi.mock("./studio-closing-refresh", () => ({ refreshStudioClosingOutputs: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
const target = {
  label: "Sri Datta Vijayananda Teertha Swamiji",
  url: "https://www.youtube.com/@sridattavijayam",
  fullVideosUrl: "https://www.youtube.com/@gurubhavanaadpt",
};
const old = { label: target.label, url: target.fullVideosUrl };
function input() {
  const output = {
    id: "preview",
    channel: "youtube",
    language: "en",
    generatedAt: "2026-10-25T00:00:00Z",
    body: `Teaching\nSubscribe to ${old.label}: ${old.url}`,
    presentationReview: {
      closingCard: { destination: "youtube", sourceBranding: "bala-swamiji", youtubeClosing: old },
    },
  } as StudioOutput;
  return {
    pkg: { request: { sourceBranding: "bala-swamiji", youtubeClosing: target } } as StudioPackage,
    entries: { "output:youtube:en": { fingerprint: "old-render-cache", value: output } },
    output,
  };
}
it("repairs a saved card before resuming and invalidates render-cache reuse without promoting the preview", async () => {
  const { pkg, entries, output } = input();
  vi.mocked(refreshStudioClosingOutputs).mockImplementation(async ({ pkg }) => [
    { ...pkg.outputs[0], generatedAt: "2026-10-26T01:00:00Z" } as StudioOutput,
  ]);
  const persist = vi.fn().mockResolvedValue(undefined);
  await refreshStudioPreviewClosings({ pkg, entries, store: {} as never, env: {}, persist });
  expect(persist).toHaveBeenCalledWith(
    "output:youtube:en",
    entries["output:youtube:en"],
    expect.objectContaining({
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      value: expect.objectContaining({
        generatedAt: output.generatedAt,
        body: `Teaching\nWatch full videos: ${target.fullVideosUrl}\nSubscribe to ${target.label}: ${target.url}`,
      }),
    }),
  );
  expect(entries["output:youtube:en"].value).toBe(output);
});
it("ignores preserved history and cache entries sharing a current preview's ID", () => {
  const { pkg, entries, output } = input();
  const current = {
    ...output,
    presentationReview: {
      ...output.presentationReview,
      closingCard: { ...output.presentationReview?.closingCard, youtubeClosing: target },
    },
  } as StudioOutput;
  const history = { fingerprint: "saved-history", value: output };
  expect(
    studioPreviewClosingCandidates(pkg, {
      ...entries,
      "preview-history:preview:old": history,
      "closing-refresh:preview": history,
    }),
  ).toHaveLength(1);
  expect(
    studioPreviewClosingCandidates(pkg, {
      "output:youtube:en": { fingerprint: "current", value: current },
      "preview-history:preview:old": history,
      "closing-refresh:preview": history,
    }),
  ).toEqual([]);
});
it("does not re-render a matching card, change approved previews, or guess an absent footer", () => {
  const { pkg, entries, output } = input();
  if (!output.presentationReview?.closingCard) throw Error("fixture");
  const current = {
    ...output,
    presentationReview: {
      ...output.presentationReview,
      closingCard: { ...output.presentationReview.closingCard, youtubeClosing: target },
    },
  };
  expect(
    studioPreviewClosingCandidates(pkg, {
      "output:youtube:en": { ...entries["output:youtube:en"], value: current },
    }),
  ).toEqual([]);
  expect(
    studioPreviewClosingCandidates(pkg, {
      "output:youtube:en": {
        ...entries["output:youtube:en"],
        value: { ...output, workflow: { status: "APPROVED" } },
      },
    }),
  ).toEqual([]);
  expect(() =>
    studioPreviewClosingCandidates(pkg, {
      "output:youtube:en": {
        ...entries["output:youtube:en"],
        value: { ...output, body: "No footer" },
      },
    }),
  ).toThrow("STUDIO_CLOSING_FOOTER_REVIEW_REQUIRED");
});
