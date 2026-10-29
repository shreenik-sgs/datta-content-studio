import { createHash } from "node:crypto";
import type { PrivateAssetStore } from "@satsang/distribution-assets";
import type {
  StudioAsset,
  StudioAssetIdentity,
  StudioSourceScreen,
} from "@satsang/distribution-domain";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import {
  generateStudioContextImage,
  reviewStudioContextImage,
  studioContextIllustrationShots,
  studioReviewedContextImage,
} from "./studio-context-images";
const connection = { apiKey: "synthetic", model: "gemini-image-test" };
const response = (parts: unknown[]) =>
  new Response(
    JSON.stringify({ candidates: [{ finishReason: "STOP", content: { role: "model", parts } }] }),
  );
const checks = {
  contextFaithful: true,
  nonDeceptive: true,
  noInventedText: true,
  visualQuality: true,
  safeComposition: true,
  iconographyAccurate: true,
  photorealistic: true,
  continuityConsistent: true,
  reason: "The depicted action illustrates the specific cited teaching.",
};
const image = (background = "#716550") =>
  sharp({ create: { width: 768, height: 1024, channels: 3, background } })
    .png()
    .toBuffer();
const shot = {
  assetId: "generated-one",
  startMs: 6000,
  endMs: 10000,
  sourceSegmentIds: ["one"],
  reason: "Shows mindful duty rather than a generic scripture book.",
  prompt:
    "Sacred, serene, elegant scene of a person calmly tending a lamp, illustrating careful action without attachment to praise.",
};
const screen: StudioSourceScreen = {
  openingComplete: true,
  endingComplete: true,
  naturalStart: true,
  naturalEnd: true,
  reason: "Complete teaching.",
  scenes: [],
  illustrations: [shot],
};
const identity: StudioAssetIdentity = {
  masterId: "11111111-1111-4111-8111-111111111111",
  sourceVersionId: "22222222-2222-4222-8222-222222222222",
  packageId: "33333333-3333-4333-8333-333333333333",
  outputId: "44444444-4444-4444-8444-444444444444",
  channel: "youtube",
  format: "short",
  language: "en",
  aspect: "9:16",
  fileVersion: 2,
  renderId: "12345678",
};
it("generates a bounded portrait raster from the exact brief, without fetching model-selected URLs", async () => {
  const bytes = await image();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      response([
        { inlineData: { mimeType: "image/png", data: bytes.toString("base64") } },
        { inlineData: { mimeType: "image/png", data: bytes.toString("base64") } },
      ]),
    );
  const result = await generateStudioContextImage({
    ...connection,
    prompt: shot.prompt,
    context: { native: "source fixture" },
    visualPreference: "Prefer forest landscapes reflecting the passage.",
    fetcher,
  });
  expect(await sharp(result).metadata()).toMatchObject({ format: "png", width: 768, height: 1024 });
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(body.generationConfig.imageConfig.aspectRatio).toBe("3:4");
  expect(body.contents[0].parts[0].text).toContain(shot.prompt);
  expect(body.contents[0].parts[0].text).toContain(
    "Prefer forest landscapes reflecting the passage.",
  );
  expect(body.systemInstruction.parts[0].text).toContain("Use photorealistic devotional imagery");
  expect(body.systemInstruction.parts[0].text).toContain("Do not add AI-generated labels");
  expect(body.contents[0].parts[0].text).not.toContain("painted art");
  expect(body.contents[0].parts[0].text).not.toContain("10% used for disclosure");
  expect(body.systemInstruction.parts[0].text).toContain("Never depict or impersonate");
  expect(body.systemInstruction.parts[0].text).toContain("Source-cited scriptural narratives");
  expect(body.systemInstruction.parts[0].text).toContain(
    "one uninterrupted full-frame composition",
  );
  expect(body.systemInstruction.parts[0].text).toContain("do not clone an existing face");
  expect(body.systemInstruction.parts[0].text).toContain(
    "must not silently replace an existing character",
  );
  expect(body.systemInstruction.parts[0].text).toContain("do not impose that form on Rama");
  expect(body.systemInstruction.parts[0].text).toContain("central deity from the actual passage");
  expect(body.systemInstruction.parts[0].text).toContain("clearly visible lion or tiger mount");
  expect(body.systemInstruction.parts[0].text).toContain("not the comparison deity");
  expect(body.systemInstruction.parts[0].text).toContain("eight distinct arms");
  expect(body.systemInstruction.parts[0].text).toContain(
    "Never simplify a deity into an ordinary two-armed person",
  );
  await expect(
    generateStudioContextImage({
      ...connection,
      prompt: shot.prompt,
      context: {},
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(response([{ fileData: { fileUri: "http://127.0.0.1/private" } }])),
    }),
  ).rejects.toThrow("STUDIO_IMAGE_GENERATION_INVALID");
});
it("saves a generated image before review and resumes review without generating or storing it again", async () => {
  const bytes = await image();
  const stored = new Map<string, Buffer>();
  const cache = new Map<string, { fingerprint: string; value: unknown }>();
  const write = vi.fn(async (a: StudioAsset, b: Uint8Array) => {
    stored.set(a.storageKey, Buffer.from(b));
  });
  const store = {
    writeDerivedDescriptor: write,
    readDerivedDescriptor: async (a: StudioAsset) => {
      const b = stored.get(a.storageKey);
      if (!b) throw Error("MISSING");
      expect(createHash("sha256").update(b).digest("hex")).toBe(a.sha256);
      return b;
    },
  } as unknown as PrivateAssetStore;
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      response([{ inlineData: { mimeType: "image/png", data: bytes.toString("base64") } }]),
    )
    .mockResolvedValueOnce(response([{ text: JSON.stringify({ incomplete: true }) }]))
    .mockResolvedValueOnce(response([{ text: JSON.stringify(checks) }]));
  const input = {
    screen,
    segments: [
      { id: "one", text: "Duty without attachment to praise.", startMs: 100000, endMs: 120000 },
    ],
    clipStartMs: 100000,
    sourceSha256: "a".repeat(64),
    sourceTitle: "Duty",
    identity,
    store,
    apiKey: "synthetic",
    imageModel: "gemini-image-test",
    reviewerModel: "gemini-review-test",
    fetcher,
    checkpoints: {
      get: <T>(key: string, fingerprint: string) =>
        cache.get(key)?.fingerprint === fingerprint ? (cache.get(key)?.value as T) : undefined,
      set: async (key: string, fingerprint: string, value: unknown) => {
        cache.set(key, { fingerprint, value });
      },
      progress: async () => {},
    },
  };
  await expect(studioContextIllustrationShots(input)).rejects.toThrow(
    "STUDIO_IMAGE_REVIEW_INVALID",
  );
  const result = await studioContextIllustrationShots(input);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(write).toHaveBeenCalledTimes(1);
  expect(result[0]?.generated?.checks).toEqual(checks);
  expect(result[0]?.prompt).toBe(shot.prompt);
  const again = await studioContextIllustrationShots({
    ...input,
    identity: { ...identity, channel: "facebook", format: "reel" },
  });
  expect(again[0]?.generated?.asset).toEqual(result[0]?.generated?.asset);
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it("rejects out-of-context insert timings and missing briefs before sending anything to the vendor", async () => {
  const fetcher = vi.fn<typeof fetch>();
  const { prompt: _prompt, ...missingPrompt } = shot;
  for (const illustration of [
    missingPrompt,
    { ...shot, sourceSegmentIds: ["not-selected"] },
    { ...shot, startMs: 21000 },
  ]) {
    await expect(
      studioContextIllustrationShots({
        screen: { ...screen, illustrations: [illustration] },
        segments: [{ id: "one", text: "Source", startMs: 100000, endMs: 120000 }],
        clipStartMs: 100000,
        sourceSha256: "a".repeat(64),
        sourceTitle: "Source",
        identity,
        store: {} as PrivateAssetStore,
        apiKey: "synthetic",
        imageModel: "gemini-image-test",
        reviewerModel: "gemini-review-test",
        fetcher,
      }),
    ).rejects.toThrow("STUDIO_ILLUSTRATION_INVALID");
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it.each([false, true])(
  "bounds repair and never returns rejected pixels (source fallback: %s)",
  async (fallback) => {
    const bytes = await image();
    const failed = {
      ...checks,
      contextFaithful: false,
      reason: "A generic book does not explain this action.",
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return body.generationConfig.imageConfig
        ? response([{ inlineData: { mimeType: "image/png", data: bytes.toString("base64") } }])
        : response([{ text: JSON.stringify(failed) }]);
    });
    const progress = vi.fn(async () => {});
    const write = vi.fn(async () => {});
    const onRejected = vi.fn();
    const result = studioContextIllustrationShots({
      screen,
      segments: [{ id: "one", text: "Duty without attachment.", startMs: 100000, endMs: 120000 }],
      clipStartMs: 100000,
      sourceSha256: "a".repeat(64),
      sourceTitle: "Duty",
      identity,
      store: { writeDerivedDescriptor: write } as unknown as PrivateAssetStore,
      apiKey: "synthetic",
      imageModel: "gemini-image-test",
      reviewerModel: "gemini-review-test",
      fetcher,
      checkpoints: { get: () => undefined, set: async () => {}, progress },
      ...(fallback ? { onRejected } : {}),
    });
    if (fallback) {
      await expect(result).resolves.toEqual([]);
      expect(onRejected).toHaveBeenCalledTimes(1);
      expect(onRejected).toHaveBeenCalledWith(
        expect.objectContaining({ sourceSegmentIds: ["one"] }),
      );
    } else await expect(result).rejects.toThrow("STUDIO_IMAGE_REVIEW_REQUIRED");
    // One generation plus two bounded corrections, each independently reviewed.
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(write).toHaveBeenCalledTimes(3);
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ presentationIssues: [failed.reason] }),
    );
    expect(String(fetcher.mock.calls[2]?.[1]?.body)).toContain(failed.reason);
    const correction = JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body));
    expect(correction.contents[0].parts[0].inlineData.mimeType).toBe("image/png");
    expect(correction.contents[0].parts.at(-1).text).toContain("Zero typography");
  },
);

it("reviews the full artwork and all four closeups while allowing relevant books without invented writing", async () => {
  const bytes = await image();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(response([{ text: JSON.stringify(checks) }]));
  expect(
    await reviewStudioContextImage({
      ...connection,
      bytes,
      prompt: "A scripture study scene",
      context: {},
      fetcher,
    }),
  ).toEqual(checks);
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  const parts = body.contents[0].parts;
  const images = parts.filter((part: { inlineData?: unknown }) => part.inlineData);
  expect(images).toHaveLength(5);
  expect(images[0].inlineData.data).toBe(bytes.toString("base64"));
  for (const part of images.slice(1))
    expect(await sharp(Buffer.from(part.inlineData.data, "base64")).metadata()).toMatchObject({
      width: 384,
      height: 512,
    });
  expect(
    parts.find((part: { text?: string }) => part.text?.includes("next four images"))?.text,
  ).toContain("Books or manuscripts themselves are allowed");
  expect(body.systemInstruction.parts[0].text).toContain("never fabricated verses");
});

it("uses only the previous accepted scene as a separately labeled continuity reference", async () => {
  const generated = await Promise.all([image("#285271"), image("#a13929"), image("#41713b")]);
  const bodies: {
    contents: { parts: { text?: string; inlineData?: { data: string } }[] }[];
    generationConfig: { imageConfig?: unknown };
  }[] = [];
  let generation = 0;
  let review = 0;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (body.generationConfig.imageConfig) {
      generation++;
      // Scene order: first (1 try), second (1 try + 2 corrections, all rejected), third (1 try).
      const bytes = generated[generation === 1 ? 0 : generation === 5 ? 2 : 1];
      return response([{ inlineData: { mimeType: "image/png", data: bytes?.toString("base64") } }]);
    }
    review++;
    return response([
      {
        text: JSON.stringify(
          review === 2 || review === 3 || review === 4
            ? {
                ...checks,
                continuityConsistent: false,
                reason: "The second scene introduces inconsistent character features.",
              }
            : checks,
        ),
      },
    ]);
  });
  const onRejected = vi.fn();
  const result = await studioContextIllustrationShots({
    screen: {
      ...screen,
      illustrations: [
        { ...shot, assetId: "third-scene", startMs: 22000, endMs: 26000 },
        { ...shot, assetId: "first-scene" },
        { ...shot, assetId: "second-scene", startMs: 14000, endMs: 18000 },
      ],
    },
    segments: [
      { id: "one", text: "A source-grounded sequence of actions.", startMs: 100000, endMs: 130000 },
    ],
    clipStartMs: 100000,
    sourceSha256: "a".repeat(64),
    sourceTitle: "Teaching",
    identity,
    store: { writeDerivedDescriptor: async () => {} } as unknown as PrivateAssetStore,
    apiKey: "synthetic",
    imageModel: "gemini-image-test",
    reviewerModel: "gemini-review-test",
    fetcher,
    onRejected,
  });
  expect(result.map((s) => s.assetId)).toEqual(["first-scene", "third-scene"]);
  expect(onRejected).toHaveBeenCalledWith(expect.objectContaining({ assetId: "second-scene" }));
  const generationBodies = bodies.filter((b) => b.generationConfig.imageConfig);
  const firstParts = generationBodies[0]?.contents[0]?.parts ?? [];
  expect(firstParts.filter((p) => p.inlineData)).toHaveLength(0);
  const lastParts = generationBodies[4]?.contents[0]?.parts ?? [];
  expect(lastParts.filter((p) => p.inlineData).map((p) => p.inlineData?.data)).toEqual([
    result[0]?.bytes.toString("base64"),
  ]);
  expect(lastParts.some((p) => p.text?.includes("Previous accepted storyboard illustration"))).toBe(
    true,
  );
  expect(lastParts.some((p) => p.text?.includes("Create one custom"))).toBe(true);
  expect(lastParts.some((p) => p.text?.includes("Edit the supplied illustration"))).toBe(false);
  const repairedParts = generationBodies[2]?.contents[0]?.parts ?? [];
  expect(repairedParts.filter((p) => p.inlineData)).toHaveLength(2);
  expect(repairedParts.some((p) => p.text?.includes("Edit the supplied illustration"))).toBe(true);
  const lastReviewParts = bodies.at(-1)?.contents[0]?.parts ?? [];
  expect(lastReviewParts.filter((p) => p.inlineData)).toHaveLength(6);
  expect(lastReviewParts.at(-1)?.inlineData?.data).toBe(result[0]?.bytes.toString("base64"));
});

it("binds image and review checkpoints to the exact approved continuity reference", async () => {
  const artwork = await image();
  const references = await Promise.all([image("#234f68"), image("#6b452e")]);
  const stored = new Map<string, Buffer>();
  const cache = new Map<string, { fingerprint: string; value: unknown }>();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return body.generationConfig.imageConfig
      ? response([{ inlineData: { mimeType: "image/png", data: artwork.toString("base64") } }])
      : response([{ text: JSON.stringify(checks) }]);
  });
  const input = {
    prompt: shot.prompt,
    context: { native: "Current scene" },
    identity,
    store: {
      writeDerivedDescriptor: async (a: StudioAsset, bytes: Uint8Array) => {
        stored.set(a.storageKey, Buffer.from(bytes));
      },
      readDerivedDescriptor: async (a: StudioAsset) => stored.get(a.storageKey) as Buffer,
    } as unknown as PrivateAssetStore,
    checkpoints: {
      get: <T>(key: string, fingerprint: string) =>
        cache.get(key)?.fingerprint === fingerprint ? (cache.get(key)?.value as T) : undefined,
      set: async (key: string, fingerprint: string, value: unknown) => {
        cache.set(key, { fingerprint, value });
      },
      progress: async () => {},
    },
    apiKey: "synthetic",
    imageModel: "gemini-image-test",
    reviewerModel: "gemini-review-test",
    fetcher,
  };
  const reference = (bytes: Buffer) => ({
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    context: { native: "Previous scene" },
  });
  const first = await studioReviewedContextImage({
    ...input,
    continuityReference: reference(references[0] as Buffer),
  });
  const again = await studioReviewedContextImage({
    ...input,
    continuityReference: reference(references[0] as Buffer),
  });
  expect(again.generated.asset).toEqual(first.generated.asset);
  expect(fetcher).toHaveBeenCalledTimes(2);
  const changed = await studioReviewedContextImage({
    ...input,
    continuityReference: reference(references[1] as Buffer),
  });
  expect(changed.generated.asset.storageKey).not.toBe(first.generated.asset.storageKey);
  expect(fetcher).toHaveBeenCalledTimes(4);
  await expect(
    studioReviewedContextImage({
      ...input,
      continuityReference: { ...reference(references[0] as Buffer), sha256: "f".repeat(64) },
    }),
  ).rejects.toThrow("STUDIO_ILLUSTRATION_INVALID");
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it.each([
  [
    "iconographyAccurate",
    "Durga is intended, but the lotus-seated goddess has no visible mount or protective attributes; her identity is ambiguous.",
  ],
  [
    "photorealistic",
    "The image has flat painted brushwork and cartoon anatomy rather than photorealistic light and textures.",
  ],
  [
    "continuityConsistent",
    "The same source-supported character changes identity and costume without a narrative reason.",
  ],
])("holds artwork failing %s even when the other checks pass", async (check, reason) => {
  const bytes = await image();
  const failed = {
    ...checks,
    [check]: false,
    reason,
  };
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return body.generationConfig.imageConfig
      ? response([{ inlineData: { mimeType: "image/png", data: bytes.toString("base64") } }])
      : response([{ text: JSON.stringify(failed) }]);
  });
  const progress = vi.fn(async () => {});
  await expect(
    studioContextIllustrationShots({
      screen,
      segments: [{ id: "one", text: "Durga is gentle.", startMs: 100000, endMs: 120000 }],
      clipStartMs: 100000,
      sourceSha256: "a".repeat(64),
      sourceTitle: "Mother Durga",
      identity,
      store: { writeDerivedDescriptor: async () => {} } as unknown as PrivateAssetStore,
      apiKey: "synthetic",
      imageModel: "gemini-image-test",
      reviewerModel: "gemini-review-test",
      fetcher,
      checkpoints: { get: () => undefined, set: async () => {}, progress },
    }),
  ).rejects.toThrow("STUDIO_IMAGE_REVIEW_REQUIRED");
  expect(fetcher).toHaveBeenCalledTimes(6);
  expect(progress).toHaveBeenCalledWith(
    expect.objectContaining({ presentationIssues: [failed.reason] }),
  );
  const review = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
  expect(review.generationConfig.responseJsonSchema.required).toContain("iconographyAccurate");
  expect(review.generationConfig.responseJsonSchema.required).toContain("photorealistic");
  expect(review.systemInstruction.parts[0].text).toContain("BEFORE trusting the brief or caption");
});
