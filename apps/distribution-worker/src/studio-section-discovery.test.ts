import {
  STUDIO_CONTENT_REVIEW_CHECKS,
  type StudioContentReview,
  type StudioPackage,
  type StudioTranscript,
  createLocalStudioPlan,
} from "@satsang/distribution-domain";
import { afterEach, expect, it, vi } from "vitest";
import {
  type StudioCheckpoints,
  StudioNoSuitableContentError,
  generateCheckpointedStudioPlan,
  studioFingerprint,
} from "./studio-checkpoints";
import * as quality from "./studio-content-review";
import * as novelty from "./studio-discovery-review";
import * as intelligence from "./studio-intelligence";
import { generateStudioSectionPlan } from "./studio-section-discovery";

const transcript: StudioTranscript = {
  language: "en",
  durationMs: 650000,
  provenance: "MACHINE_TRANSCRIPT",
  sourceTranscriptId: null,
  segments: [
    { id: "old", startMs: 0, endMs: 20000, text: "Be kind to everyone." },
    {
      id: "crossing",
      startMs: 280000,
      endMs: 310000,
      text: "Be patient when someone needs help. Listen and respond with care.",
    },
    {
      id: "next",
      startMs: 320000,
      endMs: 350000,
      text: "Help others quietly without seeking praise.",
    },
    {
      id: "repeat",
      startMs: 620000,
      endMs: 650000,
      text: "Serve quietly without expecting recognition.",
    },
  ],
};
const pkg = {
  source: { title: "Fixture discourse", language: "en", category: "pravachanams" },
  request: {
    channels: ["youtube"],
    languages: ["en"],
    captions: true,
    instructions: "",
    allCompleteMessages: true,
  },
  outputs: [],
  feedback: [],
} as unknown as StudioPackage;
function planFor(id: string) {
  const plan = createLocalStudioPlan(
    { ...pkg, request: { ...pkg.request, allCompleteMessages: false } },
    { ...transcript, segments: transcript.segments.filter((s) => s.id === id) },
  );
  return { ...plan, outputs: plan.outputs.map((o) => ({ ...o, messageId: "message-one" })) };
}

const input = {
  pkg,
  transcript,
  provider: "gemini" as const,
  apiKey: "synthetic",
  model: "fixture",
  discoveryExcludedOutputs: planFor("old").outputs,
};
function recovery(): StudioCheckpoints {
  const saved = new Map<string, unknown>();
  return {
    get: <T>(key: string, fp: string) => saved.get(key + fp) as T | undefined,
    set: async (key, fp, value) => {
      saved.set(key + fp, structuredClone(value));
    },
    progress: vi.fn(async () => {}),
  };
}
afterEach(() => vi.restoreAllMocks());
it("reviews each section, keeps crossing thoughts whole, and excludes semantic repeats without changing existing files", async () => {
  const before = studioFingerprint(input.discoveryExcludedOutputs);
  const reviewer = vi
    .spyOn(novelty, "reviewStudioDiscoveryNovelty")
    .mockImplementation(async (_input, candidates) =>
      candidates.map((o, i) => ({
        key: `candidate-${i}`,
        duplicateOf: o.sourceSegmentIds.includes("repeat") ? "retained-2" : null,
        reason: "Compared native meaning.",
      })),
    );
  const calls: number[] = [];
  const run = vi.fn(async (value: Parameters<typeof generateStudioSectionPlan>[0]) => {
    const n = value.discoverySection?.index ?? -1;
    calls.push(n);
    expect(
      value.transcript.segments.every((s) =>
        transcript.segments.some(
          (original) => original.id === s.id && original.startMs === s.startMs,
        ),
      ),
    ).toBe(true);
    return planFor(["crossing", "next", "repeat"][n] ?? "old");
  });
  const cache = recovery();
  const result = await generateStudioSectionPlan(input, cache, {}, run);
  expect(calls).toEqual([0, 1, 2]);
  expect(result.outputs.map((o) => o.sourceSegmentIds)).toEqual([["crossing"], ["next"]]);
  expect(new Set(result.outputs.map((o) => o.messageId)).size).toBe(2);
  expect(result.discovery?.sections.map((s) => s.accepted)).toEqual([1, 1, 0]);
  expect(result.discovery?.sections[2]?.duplicates).toBe(1);
  expect(studioFingerprint(input.discoveryExcludedOutputs)).toBe(before);
  await generateStudioSectionPlan(input, cache, {}, run);
  expect(reviewer).toHaveBeenCalledTimes(3); // Novelty results are recovered, not repurchased.
});
it("removes a repeated source passage before novelty review and never disguises provider failure as empty coverage", async () => {
  const reviewer = vi.spyOn(novelty, "reviewStudioDiscoveryNovelty").mockResolvedValue([]);
  await expect(
    generateStudioSectionPlan(input, recovery(), {}, async (value) => {
      if (value.discoverySection?.index === 1) throw Error("STUDIO_PROVIDER_TIMEOUT");
      return planFor("old");
    }),
  ).rejects.toThrow("STUDIO_PROVIDER_TIMEOUT");
  expect(reviewer.mock.calls[0]?.[1]).toEqual([]);
});

it("uses the normal quality pipeline and resumes its paid section plans with distinct review identities", async () => {
  const planner = vi
    .spyOn(intelligence, "generateStudioPlan")
    .mockImplementation(async (value) =>
      planFor(["crossing", "next", "repeat"][value.discoverySection?.index ?? 0] ?? "old"),
    );
  const reviewer = vi.spyOn(quality, "reviewStudioContent").mockImplementation(async ({ plan }) =>
    plan.outputs.map(
      (o) =>
        ({
          ...Object.fromEntries(STUDIO_CONTENT_REVIEW_CHECKS.map((k) => [k, true])),
          channel: o.channel,
          language: o.language,
          messageId: o.messageId,
          reason: "Complete fixture.",
        }) as StudioContentReview,
    ),
  );
  vi.spyOn(novelty, "reviewStudioDiscoveryNovelty").mockImplementation(async (_i, candidates) =>
    candidates.map((_o, i) => ({
      key: `candidate-${i}`,
      duplicateOf: null,
      reason: "Distinct fixture.",
    })),
  );
  const onReview = vi.fn();
  const cache = recovery();
  const first = await generateCheckpointedStudioPlan(input, cache, { onReview });
  expect(first.outputs).toHaveLength(3);
  expect(planner).toHaveBeenCalledTimes(3);
  expect(reviewer).toHaveBeenCalledTimes(3);
  expect(
    new Set(onReview.mock.calls.flatMap((c) => c[0].map((r: StudioContentReview) => r.messageId)))
      .size,
  ).toBe(3);
  const second = await generateCheckpointedStudioPlan(input, cache, { onReview });
  expect(second.outputs).toEqual(first.outputs);
  expect(planner).toHaveBeenCalledTimes(3);
  expect(reviewer).toHaveBeenCalledTimes(3);
});

it.each(["unsuitable", "rejected"] as const)(
  "does not retry a completed %s section or shift retained teachings after a later provider interruption",
  async (outcome) => {
    vi.spyOn(novelty, "reviewStudioDiscoveryNovelty").mockImplementation(async (_i, candidates) =>
      candidates.map((_o, i) => ({
        key: `candidate-${i}`,
        duplicateOf: null,
        reason: "Distinct.",
      })),
    );
    const cache = recovery();
    const run = vi.fn(async (value: Parameters<typeof generateStudioSectionPlan>[0]) => {
      if (value.discoverySection?.index === 0)
        throw outcome === "unsuitable"
          ? new StudioNoSuitableContentError([])
          : new quality.StudioContentQualityError([]);
      if (value.discoverySection?.index === 2) throw Error("STUDIO_PROVIDER_TIMEOUT");
      return planFor("next");
    });
    await expect(generateStudioSectionPlan(input, cache, {}, run)).rejects.toThrow(
      "STUDIO_PROVIDER_TIMEOUT",
    );
    // If section zero were repurchased, the provider could return a new candidate and
    // invalidate every later novelty/plan checkpoint even though only rendering failed.
    run.mockClear();
    run.mockImplementation(async (value) =>
      planFor(value.discoverySection?.index === 1 ? "next" : "repeat"),
    );
    const result = await generateStudioSectionPlan(input, cache, {}, run);
    expect(run.mock.calls.map(([value]) => value.discoverySection?.index)).toEqual([1, 2]);
    expect(result.discovery?.sections.map((section) => section.accepted)).toEqual([0, 1, 1]);
    expect(result.outputs.flatMap((output) => output.sourceSegmentIds)).toEqual(["next", "repeat"]);
  },
);

it.each(["request", "source", "transcript", "retained", "model", "review-policy"] as const)(
  "reconsiders empty sections when %s changes",
  async (change) => {
    const cache = recovery();
    const run = vi.fn(async () => {
      throw new StudioNoSuitableContentError([]);
    });
    await generateStudioSectionPlan(input, cache, {}, run);
    run.mockClear();
    const changed = structuredClone(input);
    const options: Parameters<typeof generateStudioSectionPlan>[2] = {};
    if (change === "request") changed.pkg.request.instructions = "Look for practical teaching.";
    if (change === "source") changed.pkg.source.language = "te";
    if (change === "transcript")
      changed.transcript.segments = changed.transcript.segments.map((segment) => ({
        ...segment,
        text: "Corrected native transcript.",
      }));
    if (change === "retained")
      changed.discoveryExcludedOutputs = changed.discoveryExcludedOutputs.map((output) => ({
        ...output,
        title: "Revised retained teaching",
      }));
    if (change === "model") changed.model = "updated-model";
    if (change === "review-policy") options.mediaReviewPolicy = "updated-policy";
    await generateStudioSectionPlan(changed, cache, options, run);
    expect(run).toHaveBeenCalled();
  },
);
