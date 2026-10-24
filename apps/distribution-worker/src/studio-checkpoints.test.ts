import {
  STUDIO_CHANNELS,
  STUDIO_CONTENT_REVIEW_CHECKS,
  STUDIO_LANGUAGES,
  type StudioContentReview,
  type StudioPackage,
  type StudioPlan,
  type StudioTranscript,
  createLocalStudioPlan,
} from "@satsang/distribution-domain";
import { beforeEach, expect, it, vi } from "vitest";
import {
  type StudioCheckpoints,
  StudioNoSuitableContentError,
  generateCheckpointedStudioPlan,
} from "./studio-checkpoints";
import * as videoReview from "./studio-content-review";
import * as intelligence from "./studio-intelligence";

const transcript: StudioTranscript = {
  language: "en",
  durationMs: 10000,
  provenance: "MACHINE_TRANSCRIPT",
  sourceTranscriptId: null,
  segments: [
    { id: "one", startMs: 0, endMs: 10000, text: "Practice kindness and serve others with care." },
  ],
};
const pkg = {
  id: "synthetic",
  source: { title: "Kindness", language: "en", category: "pravachanams" },
  request: {
    languages: [...STUDIO_LANGUAGES],
    channels: [...STUDIO_CHANNELS],
    captions: true,
    instructions: "",
  },
  outputs: [],
  feedback: [],
} as unknown as StudioPackage;
const request = {
  pkg,
  transcript,
  provider: "gemini" as const,
  apiKey: "synthetic",
  model: "synthetic",
};
function recovery(jsonb = false) {
  const saved = new Map<string, { fingerprint: string; value: unknown }>();
  const checkpoints: StudioCheckpoints = {
    get: <T>(key: string, fp: string) =>
      saved.get(key)?.fingerprint === fp
        ? (structuredClone(saved.get(key)?.value) as T)
        : undefined,
    set: async (key, fingerprint, value) => {
      saved.set(key, {
        fingerprint,
        value: jsonb
          ? JSON.parse(
              JSON.stringify(value, (_key, entry: unknown) =>
                entry && typeof entry === "object" && !Array.isArray(entry)
                  ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
                  : entry,
              ),
            )
          : structuredClone(value),
      });
    },
    progress: vi.fn(async () => {}),
  };
  return checkpoints;
}
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(videoReview, "reviewStudioContent").mockImplementation(async ({ plan }) =>
    plan.outputs.map(
      (o) =>
        ({
          channel: o.channel,
          language: o.language,
          ...Object.fromEntries(STUDIO_CONTENT_REVIEW_CHECKS.map((key) => [key, true])),
          reason: "Synthetic complete fixture.",
        }) as StudioContentReview,
    ),
  );
});
function mockPlans() {
  return vi.spyOn(intelligence, "generateStudioPlan").mockImplementation(async (input) => {
    const sourcePlan = createLocalStudioPlan(
      { ...input.pkg, request: { ...input.pkg.request, languages: ["en"] } },
      transcript,
    );
    const language = input.pkg.request.languages[0];
    if (!language) throw Error("Missing fixture language");
    sourcePlan.outputs = sourcePlan.outputs.map((output) => ({ ...output, language }));
    sourcePlan.translations =
      language === "en"
        ? []
        : [{ language, segments: [{ id: "one", text: "Synthetic translated fixture." }] }];
    return sourcePlan;
  });
}
it("bounds all 13 channels and 8 languages to four outputs per request and preserves complete coverage", async () => {
  const spy = mockPlans();
  const result = await generateCheckpointedStudioPlan(request, recovery());
  expect(result.outputs.length).toBe(12 * 8); // local fixture correctly skips LinkedIn
  expect(
    spy.mock.calls.every(
      ([input]) =>
        input.pkg.request.channels.length <= 4 && input.pkg.request.languages.length === 1,
    ),
  ).toBe(true);
  expect(result.skippedChannels.map((skip) => skip.channel)).toEqual(["linkedin"]);
});
it("scopes selected correction identities to each language batch and retains every selected file", async () => {
  const spy = mockPlans();
  const selectedPackage = {
    ...pkg,
    request: { ...pkg.request, channels: ["youtube", "facebook"], languages: ["en", "hi"] },
  } as StudioPackage;
  const english = createLocalStudioPlan(
    { ...selectedPackage, request: { ...selectedPackage.request, languages: ["en"] } },
    transcript,
  );
  selectedPackage.outputs = ["en", "hi"].flatMap((language) =>
    english.outputs.map((output) => ({ ...output, language })),
  ) as StudioPackage["outputs"];
  const result = await generateCheckpointedStudioPlan(
    { ...request, pkg: selectedPackage, retainedOutputs: [] },
    recovery(),
  );
  expect(result.outputs).toHaveLength(4);
  expect(spy).toHaveBeenCalledTimes(2);
  for (const [input] of spy.mock.calls) {
    expect(input.pkg.outputs).toHaveLength(2);
    expect(
      input.pkg.outputs.every((output) => output.language === input.pkg.request.languages[0]),
    ).toBe(true);
  }
});
it("resumes after a provider failure without repeating completed drafting groups", async () => {
  const spy = mockPlans();
  const success = spy.getMockImplementation();
  if (!success) throw Error("Missing fixture implementation");
  let count = 0;
  spy.mockImplementation(async (input) => {
    if (++count === 3) throw Error("STUDIO_PROVIDER_RATE_LIMITED");
    return success(input);
  });
  const cache = recovery();
  await expect(generateCheckpointedStudioPlan(request, cache)).rejects.toThrow(
    "STUDIO_PROVIDER_RATE_LIMITED",
  );
  expect(spy).toHaveBeenCalledTimes(3);
  spy.mockImplementation(success);
  spy.mockClear();
  await generateCheckpointedStudioPlan(request, cache);
  expect(spy.mock.calls[0]?.[0].pkg.request.channels).toEqual(STUDIO_CHANNELS.slice(8, 12));
  spy.mockClear();
  await generateCheckpointedStudioPlan(request, cache);
  expect(spy).not.toHaveBeenCalled();
});
it("invalidates saved drafts when curator guidance changes", async () => {
  const spy = mockPlans();
  const cache = recovery();
  await generateCheckpointedStudioPlan(request, cache);
  spy.mockClear();
  await generateCheckpointedStudioPlan(
    {
      ...request,
      pkg: { ...pkg, request: { ...pkg.request, instructions: "Use the complete story." } },
    },
    cache,
  );
  expect(spy).toHaveBeenCalled();
});

it("rechecks older media evidence without redrafting, then reuses only the current review", async () => {
  const generate = mockPlans();
  const cache = recovery(true);
  const small = {
    ...request,
    pkg: {
      ...pkg,
      request: { ...pkg.request, channels: ["youtube" as const], languages: ["en" as const] },
    },
  };
  const reviewMedia = vi.fn(async (_plan: StudioPlan, checks: StudioContentReview[]) => checks);
  const initial = await generateCheckpointedStudioPlan(small, cache, { reviewMedia });
  generate.mockClear();
  reviewMedia.mockClear();
  const current = { reviewMedia, mediaReviewPolicy: "blind-audio-v2" };
  expect(await generateCheckpointedStudioPlan(small, cache, current)).toEqual(initial);
  expect(generate).not.toHaveBeenCalled();
  expect(reviewMedia).toHaveBeenCalledTimes(1);
  reviewMedia.mockClear();
  expect(await generateCheckpointedStudioPlan(small, cache, current)).toEqual(initial);
  expect(generate).not.toHaveBeenCalled();
  expect(reviewMedia).not.toHaveBeenCalled();
});

it("repairs a newly detected native cut instead of accepting the older saved pass", async () => {
  const generate = mockPlans();
  const cache = recovery(true);
  const small = {
    ...request,
    pkg: {
      ...pkg,
      request: { ...pkg.request, channels: ["youtube" as const], languages: ["en" as const] },
    },
  };
  const reviewMedia = vi.fn(async (_plan: StudioPlan, checks: StudioContentReview[]) => checks);
  await generateCheckpointedStudioPlan(small, cache, { reviewMedia });
  generate.mockClear();
  reviewMedia.mockImplementation(async (_plan, checks) =>
    checks.map((check) => ({
      ...check,
      endingComplete: false,
      reason: "Audible sentence is clipped.",
    })),
  );
  await expect(
    generateCheckpointedStudioPlan(small, cache, {
      reviewMedia,
      mediaReviewPolicy: "blind-audio-v2",
    }),
  ).rejects.toThrow("STUDIO_VIDEO_REVIEW_REQUIRED");
  expect(generate).toHaveBeenCalledTimes(3);
  expect(generate.mock.calls.every(([input]) => input.contentReviewCorrection)).toBe(true);
});

it("uses an explicitly configured backup for availability/quota failures and records actual providers", async () => {
  const spy = mockPlans();
  const valid = spy.getMockImplementation();
  if (!valid) throw Error("Missing fixture");
  spy.mockImplementation(async (input) => {
    if (input.provider === "gemini") throw Error("STUDIO_PROVIDER_QUOTA_EXHAUSTED");
    expect(input.originalAudio).toBeUndefined();
    return valid(input);
  });
  const onProvider = vi.fn();
  const cache = recovery();
  const options = {
    fallback: {
      provider: "openai" as const,
      apiKey: "synthetic-backup",
      model: "synthetic-backup",
    },
    onProvider,
  };
  await generateCheckpointedStudioPlan(
    { ...request, originalAudio: new Uint8Array([1, 2]) },
    cache,
    options,
  );
  expect(spy.mock.calls.filter(([input]) => input.provider === "gemini")).toHaveLength(1);
  expect(onProvider).toHaveBeenCalledWith("openai", "synthetic-backup", false);
  spy.mockClear();
  onProvider.mockClear();
  await generateCheckpointedStudioPlan(request, cache, options);
  expect(spy).not.toHaveBeenCalled();
  expect(onProvider).toHaveBeenCalledWith("openai", "synthetic-backup", false);
});
it.each([
  "STUDIO_PROVIDER_CONTENT_BLOCKED",
  "STUDIO_PROVIDER_AUTHENTICATION_FAILED",
  "STUDIO_PROVIDER_SPEND_CAP_REACHED",
])("does not route around %s using another provider", async (code) => {
  const spy = mockPlans().mockRejectedValue(Error(code));
  await expect(
    generateCheckpointedStudioPlan(request, recovery(), {
      fallback: { provider: "openai", apiKey: "synthetic", model: "synthetic" },
    }),
  ).rejects.toThrow(code);
  expect(spy).toHaveBeenCalledTimes(1);
});
it("supports the full 104-output combination when all channels are suitable", async () => {
  const spy = mockPlans();
  const valid = spy.getMockImplementation();
  if (!valid) throw Error("Missing fixture");
  spy.mockImplementation(async (input) => {
    const plan = await valid(input);
    if (input.pkg.request.channels.includes("linkedin")) {
      const post = plan.outputs.find((output) => output.format === "post");
      if (!post) throw Error("Missing fixture post");
      plan.outputs.push({ ...post, channel: "linkedin" });
      plan.skippedChannels = [];
    }
    return plan;
  });
  expect((await generateCheckpointedStudioPlan(request, recovery())).outputs).toHaveLength(104);
});
it("sends the master audio once and reuses the source context for later groups", async () => {
  const spy = mockPlans();
  await generateCheckpointedStudioPlan(
    { ...request, originalAudio: new Uint8Array([1, 2]) },
    recovery(),
  );
  expect(spy.mock.calls.filter(([input]) => input.originalAudio)).toHaveLength(1);
});

it("repairs a video that fails completeness, independently checks the repair and only then checkpoints", async () => {
  const spy = mockPlans();
  const review = vi.mocked(videoReview.reviewStudioContent);
  review.mockResolvedValueOnce([
    {
      channel: "youtube",
      language: "en",
      openingComplete: true,
      endingComplete: false,
      contextComplete: true,
      attributionCorrect: true,
      captionsFaithful: false,
      copySupported: true,
      reason: "The English caption invents the omitted consequence of a Telugu conditional.",
    },
  ]);
  const small = {
    ...request,
    pkg: {
      ...pkg,
      request: { ...pkg.request, channels: ["youtube" as const], languages: ["en" as const] },
    },
  };
  const cache = recovery();
  await generateCheckpointedStudioPlan(small, cache);
  expect(spy).toHaveBeenCalledTimes(2);
  expect(spy.mock.calls[1]?.[0].contentReviewCorrection?.issues[0]).toContain("endingComplete");
  expect(review).toHaveBeenCalledTimes(2);
  spy.mockClear();
  review.mockClear();
  await generateCheckpointedStudioPlan(small, cache);
  expect(spy).not.toHaveBeenCalled();
  expect(review).not.toHaveBeenCalled();
});
it("bounds unsuccessful semantic repairs and saves working findings without accepting them", async () => {
  const spy = mockPlans();
  vi.mocked(videoReview.reviewStudioContent).mockResolvedValue([
    {
      channel: "youtube",
      language: "en",
      openingComplete: true,
      endingComplete: false,
      contextComplete: true,
      attributionCorrect: true,
      captionsFaithful: true,
      copySupported: true,
      reason: "The answer is outside the clip.",
    },
  ]);
  const cache = recovery();
  const save = vi.spyOn(cache, "set");
  const small = {
    ...request,
    pkg: {
      ...pkg,
      request: { ...pkg.request, channels: ["youtube" as const], languages: ["en" as const] },
    },
  };
  await expect(
    generateCheckpointedStudioPlan(small, cache, {
      fallback: { provider: "openai", apiKey: "synthetic", model: "synthetic" },
    }),
  ).rejects.toThrow("STUDIO_VIDEO_REVIEW_REQUIRED");
  expect(spy).toHaveBeenCalledTimes(4);
  expect(spy.mock.calls.every(([call]) => call.provider === "gemini")).toBe(true);
  expect(save).toHaveBeenCalled();
  expect(save.mock.calls.every(([key]) => key.includes(":working:"))).toBe(true);
});
it("does not permit a repair to silently omit the failed video", async () => {
  const spy = mockPlans();
  const valid = spy.getMockImplementation();
  if (!valid) throw Error("Missing fixture");
  spy.mockImplementationOnce(valid).mockResolvedValueOnce({
    outputs: [],
    translations: [],
    skippedChannels: [{ channel: "youtube", reason: "Skipped to avoid review" }],
  });
  vi.mocked(videoReview.reviewStudioContent).mockResolvedValueOnce([
    {
      channel: "youtube",
      language: "en",
      openingComplete: true,
      endingComplete: false,
      contextComplete: true,
      attributionCorrect: true,
      captionsFaithful: true,
      copySupported: true,
      reason: "Incomplete.",
    },
  ]);
  await expect(
    generateCheckpointedStudioPlan({
      ...request,
      pkg: { ...pkg, request: { ...pkg.request, channels: ["youtube"], languages: ["en"] } },
    }),
  ).rejects.toThrow("STUDIO_EDITED_OUTPUT_OMITTED");
});

it("reuses reviewed drafts after PostgreSQL JSONB has reordered every object's keys", async () => {
  const spy = mockPlans();
  const cache = recovery(true);
  const first = await generateCheckpointedStudioPlan(request, cache);
  spy.mockClear();
  const second = await generateCheckpointedStudioPlan(request, cache);
  expect(second).toEqual(first);
  expect(spy).not.toHaveBeenCalled();
});

it("resumes review after an outage without generating the same draft again", async () => {
  const spy = mockPlans();
  const review = vi.mocked(videoReview.reviewStudioContent);
  review.mockRejectedValueOnce(Error("STUDIO_PROVIDER_UNAVAILABLE"));
  const small = {
    ...request,
    pkg: {
      ...pkg,
      request: { ...pkg.request, channels: ["youtube" as const], languages: ["en" as const] },
    },
  };
  const cache = recovery(true);
  await expect(generateCheckpointedStudioPlan(small, cache)).rejects.toThrow(
    "STUDIO_PROVIDER_UNAVAILABLE",
  );
  expect(spy).toHaveBeenCalledTimes(1);
  await generateCheckpointedStudioPlan(small, cache);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(review).toHaveBeenCalledTimes(2);
});

it("repairs one message at a time and retains its correction when a later message exceeds provider limits", async () => {
  const small = {
    ...request,
    pkg: {
      ...pkg,
      request: {
        ...pkg.request,
        channels: ["youtube", "facebook"] as StudioPackage["request"]["channels"],
        languages: ["en"] as StudioPackage["request"]["languages"],
        allCompleteMessages: true,
      },
    },
    transcript: {
      ...transcript,
      durationMs: 20000,
      segments: [
        ...transcript.segments,
        { id: "two", startMs: 10000, endMs: 20000, text: "Continue the practice every day." },
      ],
    },
  };
  const base = createLocalStudioPlan(
    { ...small.pkg, request: { ...small.pkg.request, allCompleteMessages: false } },
    small.transcript,
  );
  const initial = {
    ...base,
    outputs: ["one", "two"].flatMap((id, index) =>
      base.outputs.map((o) => ({
        ...o,
        messageId: `message-0${index + 1}`,
        sourceSegmentIds: [id],
        title: "Needs correction",
      })),
    ),
  };
  let interrupted = false;
  const repairedMessages: string[] = [];
  const draft = vi.spyOn(intelligence, "generateStudioPlan").mockImplementation(async (input) => {
    const correction = input.contentReviewCorrection?.priorPlan;
    if (!correction) return initial;
    const identities = [...new Set(correction.outputs.map((o) => o.messageId))];
    expect(identities).toHaveLength(1);
    expect(correction.outputs.map((o) => o.channel)).toEqual(["youtube", "facebook"]);
    const id = identities[0] ?? "";
    repairedMessages.push(id);
    if (id === "message-02" && !interrupted) {
      interrupted = true;
      throw Error("STUDIO_PROVIDER_OUTPUT_LIMIT");
    }
    return {
      ...correction,
      outputs: correction.outputs.map((o) => ({ ...o, title: "Corrected" })),
    };
  });
  vi.mocked(videoReview.reviewStudioContent).mockImplementation(
    async ({ plan }) =>
      plan.outputs.map((o) => ({
        channel: o.channel,
        language: o.language,
        messageId: o.messageId,
        ...Object.fromEntries(STUDIO_CONTENT_REVIEW_CHECKS.map((key) => [key, true])),
        endingComplete: o.title === "Corrected",
        reason: o.title === "Corrected" ? "Complete fixture." : "Needs a complete ending.",
      })) as StudioContentReview[],
  );
  const cache = recovery(true);
  await expect(generateCheckpointedStudioPlan(small, cache)).rejects.toThrow(
    "STUDIO_PROVIDER_OUTPUT_LIMIT",
  );
  const result = await generateCheckpointedStudioPlan(small, cache);
  expect(result.outputs).toHaveLength(4);
  expect(result.outputs.every((o) => o.title === "Corrected")).toBe(true);
  expect(repairedMessages).toEqual(["message-01", "message-02", "message-02"]);
  expect(draft.mock.calls.filter(([input]) => !input.contentReviewCorrection)).toHaveLength(1);
});

function candidateFixture(languages: StudioPackage["request"]["languages"] = ["en"]) {
  const small = {
    ...request,
    pkg: {
      ...pkg,
      request: {
        ...pkg.request,
        channels: [
          "youtube",
          "facebook",
        ] as const as unknown as StudioPackage["request"]["channels"],
        languages,
        allCompleteMessages: true,
      },
    },
    transcript: {
      ...transcript,
      durationMs: 20000,
      segments: [
        ...transcript.segments,
        { id: "two", startMs: 10000, endMs: 20000, text: "A different complete teaching." },
      ],
    },
  };
  const base = createLocalStudioPlan(
    {
      ...small.pkg,
      request: { ...small.pkg.request, languages: ["en"], allCompleteMessages: false },
    },
    small.transcript,
  );
  const generate = vi
    .spyOn(intelligence, "generateStudioPlan")
    .mockImplementation(async (input) => {
      if (input.contentReviewCorrection) return input.contentReviewCorrection.priorPlan;
      const language = input.pkg.request.languages[0];
      if (!language) throw Error("MISSING_FIXTURE");
      return {
        ...base,
        outputs: ["one", "two"].flatMap((id, index) =>
          base.outputs.map((output) => ({
            ...output,
            messageId: `message-0${index + 1}`,
            sourceSegmentIds: [id],
            language,
          })),
        ),
        translations:
          language === "en"
            ? []
            : [
                {
                  language,
                  segments: small.transcript.segments.map((s) => ({
                    id: s.id,
                    text: "Synthetic translated teaching.",
                  })),
                },
              ],
      };
    });
  return { small, generate };
}
function candidateReview(
  fails: (output: import("@satsang/distribution-domain").StudioPlannedOutput) => boolean,
) {
  return vi.mocked(videoReview.reviewStudioContent).mockImplementation(
    async ({ plan }) =>
      plan.outputs.map((output) => ({
        channel: output.channel,
        language: output.language,
        messageId: output.messageId,
        ...Object.fromEntries(STUDIO_CONTENT_REVIEW_CHECKS.map((key) => [key, true])),
        endingComplete: !fails(output),
        reason: fails(output) ? "The conclusion is outside the clip." : "Complete teaching.",
      })) as StudioContentReview[],
  );
}
it("excludes an unsuitable initial message across channels after bounded repair, retaining reviewed clips and resuming without paid redrafting", async () => {
  const { small, generate } = candidateFixture();
  const review = candidateReview((o) => o.messageId === "message-02" && o.channel === "facebook");
  const onReview = vi.fn();
  const cache = recovery(true);
  const result = await generateCheckpointedStudioPlan(small, cache, { onReview });
  expect(result.outputs).toHaveLength(2);
  expect(result.outputs.every((o) => o.messageId === "message-01")).toBe(true);
  expect(result.excludedMessages?.[0]?.messageId).toBe("message-02");
  expect(result.excludedMessages?.[0]?.reasons[0]).toContain("facebook/en/message-02");
  expect(generate).toHaveBeenCalledTimes(4);
  expect(
    onReview.mock.calls.flatMap(([checks]) => checks).every((check) => check.endingComplete),
  ).toBe(true);
  generate.mockClear();
  review.mockClear();
  expect(await generateCheckpointedStudioPlan(small, cache)).toEqual(result);
  expect(generate).not.toHaveBeenCalled();
  expect(review).not.toHaveBeenCalled();
});
it("a later-language failure excludes every variant of that initial message", async () => {
  const { small } = candidateFixture(["en", "hi"]);
  candidateReview((o) => o.messageId === "message-02" && o.language === "hi");
  const result = await generateCheckpointedStudioPlan(small, recovery());
  expect(result.outputs).toHaveLength(4);
  expect(result.outputs.every((o) => o.messageId === "message-01")).toBe(true);
  expect(new Set(result.outputs.map((o) => o.language))).toEqual(new Set(["en", "hi"]));
});
it("fails closed when no complete candidate remains and permits a fresh bounded retry", async () => {
  const { small, generate } = candidateFixture();
  candidateReview(() => true);
  const cache = recovery();
  await expect(generateCheckpointedStudioPlan(small, cache)).rejects.toThrow(
    "STUDIO_VIDEO_REVIEW_REQUIRED",
  );
  generate.mockClear();
  await expect(generateCheckpointedStudioPlan(small, cache)).rejects.toThrow(
    "STUDIO_VIDEO_REVIEW_REQUIRED",
  );
  expect(generate).toHaveBeenCalled();
});
it("never drops a requested correction even when all-complete-messages mode is enabled", async () => {
  const { small } = candidateFixture();
  candidateReview((o) => o.messageId === "message-02");
  await expect(
    generateCheckpointedStudioPlan({ ...small, retainedOutputs: [] }, recovery()),
  ).rejects.toThrow("STUDIO_VIDEO_REVIEW_REQUIRED");
});

it("allows a live section with no complete teaching to be deliberately skipped", async () => {
  vi.spyOn(intelligence, "generateStudioPlan").mockResolvedValue({
    outputs: [],
    translations: [],
    skippedChannels: [
      {
        channel: "youtube",
        reason: "This section contains chanting and no complete self-contained teaching.",
      },
    ],
  });
  const live = {
    ...pkg,
    source: {
      ...pkg.source,
      liveWindow: {
        broadcastId: "live",
        windowId: "section",
        startOffsetMs: 0,
        ownedEndMs: 420000,
      },
    },
    request: { ...pkg.request, channels: ["youtube" as const], languages: ["en" as const] },
  };
  const result = await generateCheckpointedStudioPlan({ ...request, pkg: live }, recovery());
  expect(result.outputs).toEqual([]);
  expect(result.skippedChannels).toHaveLength(1);
  const cache = recovery();
  await expect(
    generateCheckpointedStudioPlan({ ...request, pkg: { ...live, source: pkg.source } }, cache),
  ).rejects.toMatchObject(new StudioNoSuitableContentError(result.skippedChannels));
  vi.mocked(intelligence.generateStudioPlan).mockClear();
  await expect(
    generateCheckpointedStudioPlan({ ...request, pkg: { ...live, source: pkg.source } }, cache),
  ).rejects.toMatchObject({ excludedChannels: result.skippedChannels });
  expect(intelligence.generateStudioPlan).not.toHaveBeenCalled();
});
