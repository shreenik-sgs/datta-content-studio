import { expect, it } from "vitest";
import type { StudioPackage, StudioStatus } from "./intelligent-content";
import { retargetStudioYoutubeClosing } from "./studio-closing-destination";
import {
  STUDIO_BALA_YOUTUBE_CLOSING,
  studioClosingCardPlan,
  studioClosingChannel,
} from "./studio-ending";

function fixture(): StudioPackage {
  const prior = { label: "Gurubhavana ADPT", url: "https://www.youtube.com/@gurubhavanaadpt" };
  return {
    status: "DRAFT",
    approval: null,
    request: { sourceBranding: "bala-swamiji", youtubeClosing: prior, channels: ["youtube"] },
    outputs: [
      {
        id: "short",
        channel: "youtube",
        fileVersion: 5,
        body: `A source-faithful teaching.\n\nSubscribe to ${prior.label}: ${prior.url}\n\n@gurubhavanaadpt`,
        asset: { sha256: "unchanged-video" },
        captions: [{ language: "en" }],
        aiReview: { fileVersion: 5 },
        presentationReview: {
          closingCard: studioClosingCardPlan(60000, {
            sourceBranding: "bala-swamiji",
            youtubeClosing: prior,
          }),
        },
      },
    ],
  } as StudioPackage;
}
it("changes only the subscription footer and URL metadata, preserving the reviewed media", () => {
  const pkg = fixture();
  const before = structuredClone(pkg);
  const next = retargetStudioYoutubeClosing(pkg, STUDIO_BALA_YOUTUBE_CLOSING);
  expect(pkg).toEqual(before);
  expect(next.outputs[0]?.body).toBe(
    "A source-faithful teaching.\n\nSubscribe to Sri Datta Vijayananda Teertha Swamiji: https://www.youtube.com/@SriDattaVijayanandaTeertha\n\n@gurubhavanaadpt",
  );
  const output = next.outputs[0];
  const original = pkg.outputs[0];
  expect(output?.asset).toBe(original?.asset);
  expect(output?.aiReview).toBe(original?.aiReview);
  expect(output?.captions).toBe(original?.captions);
  expect(output?.fileVersion).toBe(5);
  const card = output?.presentationReview?.closingCard;
  if (!card) throw Error("Missing closing card");
  expect(studioClosingChannel(card)).toEqual({
    name: STUDIO_BALA_YOUTUBE_CLOSING.label,
    url: STUDIO_BALA_YOUTUBE_CLOSING.url,
  });
  expect(retargetStudioYoutubeClosing(next, STUDIO_BALA_YOUTUBE_CLOSING)).toBe(next);
});
it.each<StudioStatus>(["APPROVED", "IN_REVIEW", "DISCARDED", "QUEUED", "GENERATING"])(
  "refuses changes to %s packages",
  (status) => {
    expect(() =>
      retargetStudioYoutubeClosing({ ...fixture(), status }, STUDIO_BALA_YOUTUBE_CLOSING),
    ).toThrow("INVALID_STUDIO_TRANSITION");
  },
);
it("refuses a new displayed name or historical card that would need rendering", () => {
  expect(() =>
    retargetStudioYoutubeClosing(fixture(), {
      ...STUDIO_BALA_YOUTUBE_CLOSING,
      label: "Different channel name",
    }),
  ).toThrow("STUDIO_CLOSING_RETARGET_REQUIRES_RENDER");
  const pkg = fixture();
  const card = pkg.outputs[0]?.presentationReview?.closingCard;
  if (!card) throw Error("Missing closing card");
  card.policy = "green-subscribe-closing-card-v3";
  expect(() => retargetStudioYoutubeClosing(pkg, STUDIO_BALA_YOUTUBE_CLOSING)).toThrow(
    "STUDIO_CLOSING_RETARGET_REQUIRES_RENDER",
  );
});
it("refuses ambiguous copy instead of replacing arbitrary source references", () => {
  const pkg = fixture();
  const output = pkg.outputs[0];
  if (!output) throw Error("Missing output");
  output.body = "A reference to https://www.youtube.com/@gurubhavanaadpt";
  expect(() => retargetStudioYoutubeClosing(pkg, STUDIO_BALA_YOUTUBE_CLOSING)).toThrow(
    "STUDIO_CLOSING_FOOTER_REVIEW_REQUIRED",
  );
});
it("sets the destination on a failed no-excerpt package without generating or approving it", () => {
  const pkg = {
    ...fixture(),
    status: "FAILED" as const,
    failure: "STUDIO_NO_SUITABLE_CHANNELS",
    outputs: [],
  };
  const next = retargetStudioYoutubeClosing(pkg, STUDIO_BALA_YOUTUBE_CLOSING);
  expect(next.status).toBe("FAILED");
  expect(next.failure).toBe(pkg.failure);
  expect(next.outputs).toEqual([]);
  expect(next.approval).toBeNull();
});
