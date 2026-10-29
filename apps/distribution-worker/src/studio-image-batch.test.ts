import type { PrivateAssetStore } from "@satsang/distribution-assets";
import type {
  StudioAsset,
  StudioAssetIdentity,
  StudioSourceScreen,
} from "@satsang/distribution-domain";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import {
  STUDIO_IMAGE_BATCH_CHECK_MS,
  StudioImageBatchPending,
  createStudioImageBatch,
  readStudioImageBatch,
  studioBatchedContextIllustrationShots,
} from "./studio-image-batch";

const json = (value: unknown) => new Response(JSON.stringify(value));
const generated = (bytes: Buffer) => ({
  candidates: [
    {
      finishReason: "STOP",
      content: {
        role: "model",
        parts: [{ inlineData: { mimeType: "image/png", data: bytes.toString("base64") } }],
      },
    },
  ],
});
const reviewed = (value: unknown) => ({
  candidates: [
    { finishReason: "STOP", content: { role: "model", parts: [{ text: JSON.stringify(value) }] } },
  ],
});
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
const shots = [
  {
    assetId: "scene-one",
    startMs: 3000,
    endMs: 8000,
    sourceSegmentIds: ["one"],
    reason: "Krishna on Kaliya.",
    prompt: "Krishna standing on Kaliya, the serpent with exactly seven hoods.",
  },
  {
    assetId: "scene-two",
    startMs: 8000,
    endMs: 13000,
    sourceSegmentIds: ["one"],
    reason: "The Nagapatnis plead.",
    prompt: "The Nagapatnis with folded hands in the Yamuna.",
  },
];
const screen: StudioSourceScreen = {
  illustrationPolicy: "narrative-storyboard-v3",
  openingComplete: true,
  endingComplete: true,
  naturalStart: true,
  naturalEnd: true,
  reason: "Complete teaching.",
  scenes: [],
  illustrations: shots,
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
function harness() {
  const cache = new Map<string, { fingerprint: string; value: unknown }>();
  const stored = new Map<string, Buffer>();
  const progress = vi.fn(async () => {});
  return {
    cache,
    stored,
    progress,
    checkpoints: {
      get: <T>(key: string, fingerprint: string) =>
        cache.get(key)?.fingerprint === fingerprint ? (cache.get(key)?.value as T) : undefined,
      set: async (key: string, fingerprint: string, value: unknown) => {
        cache.set(key, { fingerprint, value });
      },
      progress,
    },
    store: {
      writeDerivedDescriptor: async (a: StudioAsset, bytes: Uint8Array) => {
        stored.set(a.storageKey, Buffer.from(bytes));
      },
      readDerivedDescriptor: async (a: StudioAsset) => stored.get(a.storageKey) as Buffer,
    } as unknown as PrivateAssetStore,
  };
}
const base = (h: ReturnType<typeof harness>, fetcher: typeof fetch) => ({
  screen,
  segments: [{ id: "one", text: "Krishna subdues Kaliya.", startMs: 100000, endMs: 120000 }],
  clipStartMs: 100000,
  sourceSha256: "a".repeat(64),
  sourceTitle: "Kaliya",
  identity,
  store: h.store,
  checkpoints: h.checkpoints,
  apiKey: "synthetic",
  imageModel: "gemini-image-test",
  reviewerModel: "gemini-review-test",
  aspectRatio: "9:16" as const,
  batchPrefix: "dcs-test-live",
  fetcher,
});

it("submits every pending scene as one batch job, parks the job, and never waits in process", async () => {
  const h = harness();
  const bodies: { url: string; body: unknown }[] = [];
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const text = String(url);
    bodies.push({ url: text, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (text.endsWith("/batches?pageSize=100")) return json({ batches: [] });
    if (text.includes(":batchGenerateContent")) return json({ name: "batches/abc123" });
    throw Error(`unexpected ${text}`);
  });
  const pending = studioBatchedContextIllustrationShots(base(h, fetcher));
  await expect(pending).rejects.toBeInstanceOf(StudioImageBatchPending);
  await expect(pending).rejects.toMatchObject({
    message: "STUDIO_IMAGE_BATCH_PENDING",
    retryAfterMs: STUDIO_IMAGE_BATCH_CHECK_MS,
    batch: { round: 0, images: 2 },
  });
  const created = bodies.find((b) => b.url.includes(":batchGenerateContent"))?.body as {
    batch: {
      display_name: string;
      input_config: { requests: { requests: { request: unknown; metadata: { key: string } }[] } };
    };
  };
  expect(created.batch.display_name.startsWith("dcs-test-live-")).toBe(true);
  const requests = created.batch.input_config.requests.requests;
  expect(requests.map((r) => r.metadata.key)).toEqual(["scene-one", "scene-two"]);
  const first = requests[0]?.request as {
    generationConfig: { imageConfig: { aspectRatio: string } };
    contents: { parts: { text?: string; inlineData?: unknown }[] }[];
  };
  expect(first.generationConfig.imageConfig.aspectRatio).toBe("9:16");
  // No continuity image travels with a batch request; the appearance line carries consistency.
  expect(first.contents[0]?.parts.some((p) => p.inlineData)).toBe(false);
  expect(first.contents[0]?.parts.some((p) => p.text?.includes("seven hoods"))).toBe(true);
  const job = [...h.cache.entries()].find(([key]) => key.startsWith("image-batch:"));
  expect(job?.[1].value).toMatchObject({ name: "batches/abc123" });
  // A second claim before the provider finishes only polls; it never resubmits.
  const polling = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    const text = String(url);
    if (text.endsWith("/batches/abc123")) return json({ metadata: { state: "JOB_STATE_RUNNING" } });
    throw Error(`unexpected ${text}`);
  });
  await expect(studioBatchedContextIllustrationShots(base(h, polling))).rejects.toBeInstanceOf(
    StudioImageBatchPending,
  );
  expect(polling).toHaveBeenCalledTimes(1);
});

it("reviews delivered images in real time and sends only the rejected scene to a correction batch", async () => {
  const h = harness();
  const [one, two, twoFixed] = await Promise.all([
    image("#285271"),
    image("#a13929"),
    image("#41713b"),
  ]);
  let reviews = 0;
  const created: unknown[] = [];
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const text = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (text.endsWith("/batches?pageSize=100")) return json({ batches: [] });
    if (text.includes(":batchGenerateContent")) {
      created.push(body);
      return json({ name: `batches/job${created.length}` });
    }
    if (text.endsWith("/batches/job1"))
      return json({
        metadata: { state: "JOB_STATE_SUCCEEDED" },
        response: {
          inlinedResponses: [
            { metadata: { key: "scene-one" }, response: generated(one as Buffer) },
            { metadata: { key: "scene-two" }, response: generated(two as Buffer) },
          ],
        },
      });
    if (text.endsWith("/batches/job2"))
      return json({
        done: true,
        state: "JOB_STATE_SUCCEEDED",
        dest: { inlinedResponses: [{ response: generated(twoFixed as Buffer) }] },
      });
    if (text.includes("gemini-review-test:generateContent")) {
      reviews++;
      return json(
        reviewed(
          reviews === 2
            ? {
                ...checks,
                iconographyAccurate: false,
                reason: "Kaliya shows five hoods, not seven.",
              }
            : checks,
        ),
      );
    }
    throw Error(`unexpected ${text}`);
  });
  // Round 0: submit.
  await expect(studioBatchedContextIllustrationShots(base(h, fetcher))).rejects.toBeInstanceOf(
    StudioImageBatchPending,
  );
  // Round 0 delivered: scene one accepted, scene two rejected, correction batch submitted.
  await expect(studioBatchedContextIllustrationShots(base(h, fetcher))).rejects.toMatchObject({
    batch: { round: 1, images: 1 },
  });
  expect(reviews).toBe(2);
  const correction = created[1] as {
    batch: {
      input_config: {
        requests: {
          requests: {
            metadata: { key: string };
            request: { contents: { parts: { text?: string; inlineData?: unknown }[] }[] };
          }[];
        };
      };
    };
  };
  const requests = correction.batch.input_config.requests.requests;
  expect(requests.map((r) => r.metadata.key)).toEqual(["scene-two"]);
  const parts = requests[0]?.request.contents[0]?.parts ?? [];
  expect(parts.some((p) => p.inlineData)).toBe(true);
  expect(parts.some((p) => p.text?.includes("five hoods, not seven"))).toBe(true);
  expect(parts.some((p) => p.text?.includes("Edit the supplied illustration"))).toBe(true);
  // Round 1 delivered: the corrected scene passes; both scenes return with evidence.
  const result = await studioBatchedContextIllustrationShots(base(h, fetcher));
  expect(result.map((s) => s.assetId)).toEqual(["scene-one", "scene-two"]);
  expect(result.every((s) => s.generated.provider === "gemini" && s.generated.checks.reason)).toBe(
    true,
  );
  expect(result[1]?.bytes.equals(twoFixed as Buffer)).toBe(true);
  expect(reviews).toBe(3);
  // Nothing is generated or reviewed again on a later claim with the same checkpoints.
  const again = await studioBatchedContextIllustrationShots(base(h, fetcher));
  expect(again.map((s) => s.generated.asset.sha256)).toEqual(
    result.map((s) => s.generated.asset.sha256),
  );
  expect(reviews).toBe(3);
  expect(created).toHaveLength(2);
});

it("drops a scene that still fails after three rounds and keeps the speaker, or holds the file", async () => {
  const h = harness();
  const bytes = await image();
  let jobs = 0;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    const text = String(url);
    if (text.endsWith("/batches?pageSize=100")) return json({ batches: [] });
    if (text.includes(":batchGenerateContent")) return json({ name: `batches/job${++jobs}` });
    if (/\/batches\/job\d+$/.test(text))
      return json({
        metadata: { state: "JOB_STATE_SUCCEEDED" },
        response: { inlinedResponses: [{ response: generated(bytes) }] },
      });
    if (text.includes("gemini-review-test:generateContent"))
      return json(reviewed({ ...checks, continuityConsistent: false, reason: "Six hoods." }));
    throw Error(`unexpected ${text}`);
  });
  const onRejected = vi.fn();
  const input = {
    ...base(h, fetcher),
    screen: { ...screen, illustrations: [shots[0] as (typeof shots)[number]] },
    onRejected,
  };
  for (let round = 0; round < 3; round++)
    await expect(studioBatchedContextIllustrationShots(input)).rejects.toBeInstanceOf(
      StudioImageBatchPending,
    );
  await expect(studioBatchedContextIllustrationShots(input)).resolves.toEqual([]);
  expect(onRejected).toHaveBeenCalledWith(expect.objectContaining({ assetId: "scene-one" }));
  expect(jobs).toBe(3);
  expect(h.progress).toHaveBeenCalledWith(
    expect.objectContaining({ presentationIssues: ["Six hoods."] }),
  );
  const { onRejected: _ignored, ...holding } = input;
  await expect(studioBatchedContextIllustrationShots(holding)).rejects.toThrow(
    "STUDIO_IMAGE_REVIEW_REQUIRED",
  );
});

it("waits instead of submitting when the provider already holds the workspace's concurrent job budget", async () => {
  const h = harness();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    const text = String(url);
    if (text.endsWith("/batches?pageSize=100"))
      return json({
        batches: Array.from({ length: 80 }, (_, i) => ({
          name: `batches/b${i}`,
          metadata: { displayName: `dcs-test-live-${i}`, state: "JOB_STATE_RUNNING" },
        })),
      });
    throw Error(`unexpected ${text}`);
  });
  await expect(studioBatchedContextIllustrationShots(base(h, fetcher))).rejects.toMatchObject({
    message: "STUDIO_IMAGE_BATCH_PENDING",
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect([...h.cache.keys()].some((k) => k.startsWith("image-batch:"))).toBe(false);
});

it("validates job names, states and response shapes before trusting them", async () => {
  await expect(
    createStudioImageBatch({
      apiKey: "k",
      model: "gemini-image-test",
      displayName: "x",
      requests: [{ key: "a", body: {} }],
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(json({ name: "../etc" })),
    }),
  ).rejects.toThrow("STUDIO_IMAGE_BATCH_INVALID");
  await expect(
    readStudioImageBatch({ apiKey: "k", name: "batches/../x", keys: ["a"] }),
  ).rejects.toThrow("STUDIO_IMAGE_BATCH_INVALID");
  const failed = await readStudioImageBatch({
    apiKey: "k",
    name: "batches/x1",
    keys: ["a"],
    fetcher: vi.fn<typeof fetch>().mockResolvedValue(json({ state: "JOB_STATE_EXPIRED" })),
  });
  expect(failed).toEqual({ done: true, state: "JOB_STATE_EXPIRED" });
  // The live API spells states BATCH_STATE_*; they are read like the documented JOB_STATE_*.
  const live = await readStudioImageBatch({
    apiKey: "k",
    name: "batches/x1",
    keys: ["a"],
    fetcher: vi.fn<typeof fetch>().mockResolvedValue(
      json({
        metadata: { state: "BATCH_STATE_SUCCEEDED" },
        response: { inlinedResponses: [{ metadata: { key: "a" }, response: { ok: true } }] },
      }),
    ),
  });
  expect(live.done && live.state).toBe("JOB_STATE_SUCCEEDED");
  expect(
    await readStudioImageBatch({
      apiKey: "k",
      name: "batches/x1",
      keys: ["a"],
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ metadata: { state: "BATCH_STATE_RUNNING" } })),
    }),
  ).toEqual({ done: false, state: "JOB_STATE_RUNNING" });
  await expect(
    readStudioImageBatch({
      apiKey: "k",
      name: "batches/x1",
      keys: ["a", "b"],
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(
        json({
          state: "JOB_STATE_SUCCEEDED",
          response: { inlinedResponses: [{ response: {} }] },
        }),
      ),
    }),
  ).rejects.toThrow("STUDIO_IMAGE_BATCH_INVALID");
  const done = await readStudioImageBatch({
    apiKey: "k",
    name: "batches/x1",
    keys: ["a", "b"],
    fetcher: vi.fn<typeof fetch>().mockResolvedValue(
      json({
        state: "JOB_STATE_SUCCEEDED",
        response: {
          inlinedResponses: [
            { metadata: { key: "b" }, error: { code: 8 } },
            { metadata: { key: "a" }, response: { ok: true } },
          ],
        },
      }),
    ),
  });
  expect(done.done && done.state === "JOB_STATE_SUCCEEDED" && [...done.responses.keys()]).toEqual([
    "b",
    "a",
  ]);
});
