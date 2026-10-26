import { expect, it } from "vitest";
import type { StudioPackage, StudioStatus } from "./intelligent-content";
import {
  prepareStudioYoutubeClosingRefresh,
  retargetStudioYoutubeClosing,
  reviseStudioYoutubeClosing,
} from "./studio-closing-destination";
import {
  STUDIO_BALA_YOUTUBE_CLOSING,
  studioClosingCardPlan,
  studioClosingChannel,
} from "./studio-ending";
import { STUDIO_MEDIA_DEFAULTS } from "./studio-media-edits";

function fixture(): StudioPackage {
  const prior = {
    label: "Sri Datta Vijayananda Teertha Swamiji",
    url: "https://www.youtube.com/@SriDattaVijayanandaTeertha",
  };
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
          closingCard: {
            ...studioClosingCardPlan(60000, {
              sourceBranding: "bala-swamiji",
              youtubeClosing: prior,
            }),
            policy: "green-watch-subscribe-closing-card-v5",
          },
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
    `A source-faithful teaching.\n\nSubscribe to Sri Datta Vijayananda Teertha Swamiji: ${STUDIO_BALA_YOUTUBE_CLOSING.url}\n\n@gurubhavanaadpt`,
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

it("prepares a handle-bearing card for rendering without rewriting old visual evidence or edits", () => {
  const pkg = fixture();
  pkg.status = "APPROVED";
  const output = pkg.outputs[0];
  if (!output?.presentationReview?.closingCard) throw Error("Missing fixture");
  output.presentationReview.closingCard.policy = "green-plain-text-closing-card-v7";
  output.mediaEdits = { ...STUDIO_MEDIA_DEFAULTS, portraitFocus: 0.7 };
  const original = structuredClone(pkg);
  const next = prepareStudioYoutubeClosingRefresh(pkg, STUDIO_BALA_YOUTUBE_CLOSING, {
    userId: "admin",
    at: "2026-10-26T00:00:00Z",
  });
  expect(pkg).toEqual(original);
  expect(next.request.youtubeClosing?.url).toBe("https://www.youtube.com/@sridattavijayam");
  expect(next.status).toBe("DRAFT");
  expect(next.approval).toBeNull();
  expect(next.outputs[0]?.workflow?.status).toBe("DRAFT");
  expect(next.outputs[0]?.body).toContain(
    `Subscribe to ${STUDIO_BALA_YOUTUBE_CLOSING.label}: https://www.youtube.com/@sridattavijayam`,
  );
  for (const key of [
    "asset",
    "captions",
    "mediaEdits",
    "aiReview",
    "presentationReview",
    "fileVersion",
  ] as const)
    expect(next.outputs[0]?.[key]).toEqual(output[key]);
  expect(
    prepareStudioYoutubeClosingRefresh(next, STUDIO_BALA_YOUTUBE_CLOSING, {
      userId: "admin",
      at: "2026-10-26T00:00:00Z",
    }),
  ).toBe(next);
  expect(() =>
    prepareStudioYoutubeClosingRefresh(
      { ...pkg, status: "GENERATING" },
      STUDIO_BALA_YOUTUBE_CLOSING,
      { userId: "admin", at: "2026-10-26T00:00:00Z" },
    ),
  ).toThrow("INVALID_STUDIO_TRANSITION");
});
it.each(["QUEUED", "GENERATING"] as const)(
  "replaces a %s closing-only destination while retaining the original media evidence",
  (status) => {
    const pkg = {
      ...fixture(),
      status,
      generation: { mode: "closing" as const, outputIds: ["short"] },
    };
    const next = prepareStudioYoutubeClosingRefresh(pkg, STUDIO_BALA_YOUTUBE_CLOSING, {
      userId: "admin",
      at: "2026-10-26T00:00:00Z",
    });
    expect(next.status).toBe("DRAFT");
    expect(next.generation).toBeNull();
    expect(next.outputs[0]?.asset).toBe(pkg.outputs[0]?.asset);
    expect(next.outputs[0]?.presentationReview).toBe(pkg.outputs[0]?.presentationReview);
    expect(next.outputs[0]?.captions).toBe(pkg.outputs[0]?.captions);
    expect(next.request.youtubeClosing).toEqual(STUDIO_BALA_YOUTUBE_CLOSING);
    expect(() =>
      prepareStudioYoutubeClosingRefresh(
        { ...pkg, generation: { mode: "ai", outputIds: ["short"] } },
        STUDIO_BALA_YOUTUBE_CLOSING,
        { userId: "admin", at: "2026-10-26T00:00:00Z" },
      ),
    ).toThrow("INVALID_STUDIO_TRANSITION");
  },
);
it("does not claim that changing the destination repairs a failed excerpt selection", () => {
  const pkg = {
    ...fixture(),
    outputs: [],
    status: "FAILED" as const,
    failure: "STUDIO_NO_SUITABLE_CHANNELS",
  };
  const next = prepareStudioYoutubeClosingRefresh(pkg, STUDIO_BALA_YOUTUBE_CLOSING, {
    userId: "admin",
    at: "2026-10-26T00:00:00Z",
  });
  expect(next.status).toBe("FAILED");
  expect(next.failure).toBe(pkg.failure);
  expect(next.request.youtubeClosing).toEqual(STUDIO_BALA_YOUTUBE_CLOSING);
  expect(next.outputs).toEqual([]);
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
it("requires rendering when the old destination is embedded in v6 pixels", () => {
  const pkg = fixture();
  const card = pkg.outputs[0]?.presentationReview?.closingCard;
  if (!card) throw Error("Missing closing card");
  card.policy = "green-channel-watch-subscribe-closing-card-v6";
  expect(() => retargetStudioYoutubeClosing(pkg, STUDIO_BALA_YOUTUBE_CLOSING)).toThrow(
    "STUDIO_CLOSING_RETARGET_REQUIRES_RENDER",
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

it("creates a fresh draft for an authorized link change without changing approved media or history", () => {
  const pkg = fixture();
  pkg.status = "APPROVED";
  pkg.approval = {
    reviewerId: "reviewer",
    revision: 8,
    sourceRevision: 2,
    approvedAt: "2026-10-24T00:00:00Z",
  };
  const output = pkg.outputs[0];
  if (!output) throw Error("Missing output");
  output.included = true;
  output.workflow = {
    status: "APPROVED",
    actorId: "reviewer",
    updatedAt: "2026-10-24T00:00:00Z",
    approval: { ...pkg.approval, fingerprint: "reviewed-fingerprint" },
  };
  output.mediaEdits = {
    framing: "auto",
    portraitFocus: 0.6,
    captions: "on",
    subtitleSize: "small",
    speechLevel: "standard",
    reduceNoise: true,
  };
  const before = structuredClone(pkg);
  const target = { ...STUDIO_BALA_YOUTUBE_CLOSING, url: "https://www.youtube.com/@gurubhavana" };
  const next = reviseStudioYoutubeClosing(pkg, target, {
    userId: "curator",
    at: "2026-10-24T01:00:00Z",
  });
  expect(pkg).toEqual(before);
  expect(next.status).toBe("DRAFT");
  expect(next.approval).toBeNull();
  expect(next.outputs[0]?.workflow).toEqual({
    status: "DRAFT",
    actorId: "curator",
    updatedAt: "2026-10-24T01:00:00Z",
  });
  expect(next.outputs[0]?.asset).toBe(output.asset);
  expect(next.outputs[0]?.captions).toBe(output.captions);
  expect(next.outputs[0]?.mediaEdits).toBe(output.mediaEdits);
  expect(next.outputs[0]?.body).toContain(target.url);
  expect(next.outputs[0]?.fileVersion).toBe(output.fileVersion);
  const approvedAgain = { ...next, status: "APPROVED" as const, approval: pkg.approval };
  expect(
    reviseStudioYoutubeClosing(approvedAgain, target, {
      userId: "curator",
      at: "2026-10-24T02:00:00Z",
    }),
  ).toBe(approvedAgain);
});

it.each<StudioStatus>(["QUEUED", "GENERATING", "DISCARDED"])(
  "cannot revise closing links during %s",
  (status) => {
    expect(() =>
      reviseStudioYoutubeClosing({ ...fixture(), status }, STUDIO_BALA_YOUTUBE_CLOSING, {
        userId: "curator",
        at: "2026-10-24T01:00:00Z",
      }),
    ).toThrow("INVALID_STUDIO_TRANSITION");
  },
);
