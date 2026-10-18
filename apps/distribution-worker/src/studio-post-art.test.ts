import { createHash } from "node:crypto";
import type { PrivateAssetStore } from "@satsang/distribution-assets";
import {
  type StudioAsset,
  type StudioAssetIdentity,
  type StudioOutput,
  studioAssetName,
  studioPostExcerptCandidates,
  validateStudioPostArt,
  validateStudioPostExcerpt,
} from "@satsang/distribution-domain";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import { createStudioIllustratedPost, renderStudioIllustratedPost } from "./studio-post-art";

const identity: StudioAssetIdentity = {
  masterId: "11111111-1111-4111-8111-111111111111",
  sourceVersionId: "22222222-2222-4222-8222-222222222222",
  packageId: "33333333-3333-4333-8333-333333333333",
  outputId: "44444444-4444-4444-8444-444444444444",
  channel: "telegram",
  format: "post",
  language: "en",
  aspect: "4:5",
  fileVersion: 2,
  renderId: "12345678",
};
const image = () =>
  sharp({ create: { width: 1024, height: 1280, channels: 3, background: "#334c32" } })
    .png()
    .toBuffer();
const excerpt = "Practice with care and attention. Each sincere effort matters.";
const body = `${excerpt}\n\n@sgsswamiji`;
const imageChecks = {
  contextFaithful: true,
  nonDeceptive: true,
  noInventedText: true,
  visualQuality: true,
  safeComposition: true,
  iconographyAccurate: true,
  photorealistic: true,
  continuityConsistent: true,
  reason: "The cited act of attentive practice is illustrated.",
};
const postChecks = {
  contextFaithful: true,
  textAccurate: true,
  textReadable: true,
  brandingVisible: true,
  noClipping: true,
  cleanPresentation: true,
  reason: "Exact complete excerpt, subject and attribution are visible.",
};
const response = (parts: unknown[]) =>
  new Response(
    JSON.stringify({ candidates: [{ finishReason: "STOP", content: { role: "model", parts } }] }),
  );

it("requires a complete exact excerpt, rejecting invented quotations and mid-sentence fragments", () => {
  expect(() => validateStudioPostExcerpt(excerpt, body)).not.toThrow();
  expect(() => validateStudioPostExcerpt("Each sincere effort matters.", body)).not.toThrow();
  for (const text of [
    "effort matters.",
    "Practice makes everything perfect.",
    "Practice with care",
    "@sgsswamiji",
    ` ${excerpt}`,
  ])
    expect(() => validateStudioPostExcerpt(text, body)).toThrow("STUDIO_POST_EXCERPT_INVALID");
});

it("offers exact complete sentences so the designer cannot invent or overrun the excerpt", () => {
  expect(studioPostExcerptCandidates(body)).toEqual([
    "Practice with care and attention.",
    excerpt,
    "Each sincere effort matters.",
  ]);
  const long = `${"Long ".repeat(70)}sentence. This complete sentence fits.\n\n@sgsswamiji`;
  expect(studioPostExcerptCandidates(long)).toEqual(["This complete sentence fits."]);
  expect(studioPostExcerptCandidates("An unfinished sentence")).toEqual([]);
});

it("creates a reviewed 4:5 Telegram image with typeset text and binds evidence to its exact version", async () => {
  const bytes = await image();
  const cache = new Map<string, unknown>();
  const assets = new Map<string, Buffer>();
  const write = vi.fn(async (a: StudioAsset, b: Uint8Array) => {
    assets.set(a.storageKey, Buffer.from(b));
  });
  const store = {
    writeDerivedDescriptor: write,
    readDerivedDescriptor: async (a: StudioAsset) => assets.get(a.storageKey) ?? Buffer.alloc(0),
  } as unknown as PrivateAssetStore;
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      response([
        {
          text: JSON.stringify({
            excerptIndex: 1,
            prompt:
              "A learner attending carefully to each step of a meaningful task in a serene garden.",
          }),
        },
      ]),
    )
    .mockResolvedValueOnce(
      response([{ inlineData: { mimeType: "image/png", data: bytes.toString("base64") } }]),
    )
    .mockResolvedValueOnce(response([{ text: JSON.stringify(imageChecks) }]))
    .mockResolvedValueOnce(response([{ text: JSON.stringify(postChecks) }]));
  const input = {
    apiKey: "synthetic",
    imageModel: "gemini-image-test",
    reviewerModel: "gemini-review-test",
    title: "Attentive Practice",
    body,
    sourceTitle: "Daily practice",
    sourceSha256: "a".repeat(64),
    segments: [{ id: "one", text: "Practice with care and attention.", startMs: 0, endMs: 10000 }],
    identity,
    logo: bytes,
    store,
    visualPreference: "Sacred and serene, with relevant nature.",
    fetcher,
    checkpoints: {
      get: <T>(key: string) => cache.get(key) as T | undefined,
      set: async (key: string, _fingerprint: string, value: unknown) => {
        cache.set(key, value);
      },
      progress: async () => {},
    },
  };
  const result = await createStudioIllustratedPost(input);
  expect(await sharp(result.bytes).metadata()).toMatchObject({
    width: 1080,
    height: 1350,
    format: "png",
  });
  expect(
    JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).generationConfig.imageConfig.aspectRatio,
  ).toBe("3:2");
  const finalReview = JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body));
  expect(finalReview.contents[0].parts[1].inlineData.data).toBe(result.bytes.toString("base64"));
  const sha256 = createHash("sha256").update(result.bytes).digest("hex");
  const output = {
    format: "post",
    body,
    fileVersion: 2,
    asset: {
      ...studioAssetName(identity, "png"),
      mimeType: "image/png",
      byteSize: result.bytes.length,
      sha256,
    },
    postArt: { ...result.evidence, renderedSha256: sha256, fileVersion: 2 },
  } as StudioOutput;
  const binding = {
    masterId: identity.masterId,
    versionId: identity.sourceVersionId,
    packageId: identity.packageId,
  };
  expect(() => validateStudioPostArt(output, input.sourceSha256, binding)).not.toThrow();
  expect(result.evidence.policy).toBe("illustrated-teaching-post-v2");
  const legacy = structuredClone(output);
  if (!legacy.postArt) throw Error("missing evidence");
  legacy.postArt.policy = "illustrated-teaching-post-v1";
  const { cleanPresentation, ...legacyChecks } = legacy.postArt.checks;
  expect(cleanPresentation).toBe(true);
  legacy.postArt.checks = { ...legacyChecks, disclosureVisible: true };
  expect(() => validateStudioPostArt(legacy, input.sourceSha256, binding)).not.toThrow();
  // Old disclosure evidence cannot attest to a newly rendered clean image.
  legacy.postArt.policy = "illustrated-teaching-post-v2";
  expect(() => validateStudioPostArt(legacy, input.sourceSha256, binding)).toThrow();
  const footer = await sharp(result.bytes)
    .extract({ left: 660, top: 1260, width: 400, height: 75 })
    .removeAlpha()
    .raw()
    .toBuffer();
  expect(footer.equals(Buffer.alloc(footer.length, Buffer.from([255, 249, 238])))).toBe(true);

  expect(() =>
    validateStudioPostArt({ ...output, fileVersion: 3 }, input.sourceSha256, binding),
  ).toThrow();
  expect(() =>
    validateStudioPostArt({ ...output, body: "Different teaching." }, input.sourceSha256, binding),
  ).toThrow();
  expect(() => validateStudioPostArt(output, "b".repeat(64), binding)).toThrow();
  expect(() =>
    validateStudioPostArt(output, input.sourceSha256, { ...binding, masterId: identity.outputId }),
  ).toThrow();
  const again = await createStudioIllustratedPost(input);
  expect(again.bytes).toEqual(result.bytes);
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(write).toHaveBeenCalledTimes(1);
});

it("never generates paid imagery for a fabricated excerpt", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      response([{ text: JSON.stringify({ excerpt: "Invented teaching.", prompt: "Garden" }) }]),
    );
  await expect(
    createStudioIllustratedPost({
      apiKey: "synthetic",
      imageModel: "gemini-image-test",
      reviewerModel: "gemini-review-test",
      title: "Practice",
      body,
      sourceTitle: "Practice",
      sourceSha256: "a".repeat(64),
      segments: [],
      identity,
      logo: await image(),
      store: {} as PrivateAssetStore,
      visualPreference: "Sacred and serene imagery faithful to the teaching.",
      fetcher,
    }),
  ).rejects.toThrow("STUDIO_POST_EXCERPT_INVALID");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("fails visibly rather than truncating oversized image text", async () => {
  await expect(
    renderStudioIllustratedPost({
      image: await image(),
      logo: await image(),
      title: "Long title ".repeat(300),
      excerpt,
    }),
  ).rejects.toThrow("STUDIO_POST_LAYOUT_INVALID");
});

it("preserves every artwork corner in a separate image well above the text", async () => {
  const artwork = await sharp(
    Buffer.from(
      `<svg width="600" height="400" xmlns="http://www.w3.org/2000/svg"><rect width="600" height="400" fill="#cccccc"/><rect width="60" height="60" fill="#ff0000"/><rect x="540" width="60" height="60" fill="#00ff00"/><rect y="340" width="60" height="60" fill="#0000ff"/><rect x="540" y="340" width="60" height="60" fill="#ff00ff"/></svg>`,
    ),
  )
    .png()
    .toBuffer();
  const rendered = await renderStudioIllustratedPost({
    image: artwork,
    logo: await image(),
    title: "Sacred teaching",
    excerpt,
  });
  for (const [left, top, rgb] of [
    [65, 142, [255, 0, 0]],
    [1010, 142, [0, 255, 0]],
    [65, 750, [0, 0, 255]],
    [1010, 750, [255, 0, 255]],
  ] as const) {
    const pixel = await sharp(rendered)
      .extract({ left, top, width: 1, height: 1 })
      .removeAlpha()
      .raw()
      .toBuffer();
    expect([...pixel]).toEqual(rgb);
  }
});

it("holds an otherwise valid illustration when the finished post clips its excerpt", async () => {
  const bytes = await image();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      response([
        {
          text: JSON.stringify({
            excerptIndex: 1,
            prompt: "Attentive practice in a serene garden.",
          }),
        },
      ]),
    )
    .mockResolvedValueOnce(
      response([{ inlineData: { mimeType: "image/png", data: bytes.toString("base64") } }]),
    )
    .mockResolvedValueOnce(response([{ text: JSON.stringify(imageChecks) }]))
    .mockResolvedValueOnce(
      response([
        {
          text: JSON.stringify({
            ...postChecks,
            noClipping: false,
            reason: "The last line is cut off.",
          }),
        },
      ]),
    );
  const progress = vi.fn(async () => {});
  await expect(
    createStudioIllustratedPost({
      apiKey: "synthetic",
      imageModel: "gemini-image-test",
      reviewerModel: "gemini-review-test",
      title: "Practice",
      body,
      sourceTitle: "Practice",
      sourceSha256: "a".repeat(64),
      segments: [],
      identity,
      logo: bytes,
      store: { writeDerivedDescriptor: async () => {} } as unknown as PrivateAssetStore,
      visualPreference: "Sacred and serene imagery faithful to the teaching.",
      fetcher,
      checkpoints: { get: () => undefined, set: async () => {}, progress },
    }),
  ).rejects.toThrow("STUDIO_POST_ART_REVIEW_REQUIRED");
  expect(progress).toHaveBeenCalledWith(
    expect.objectContaining({ presentationIssues: ["The last line is cut off."] }),
  );
});
