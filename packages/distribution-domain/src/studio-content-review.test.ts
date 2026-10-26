import { describe, expect, it } from "vitest";
import type { StudioPackage } from "./intelligent-content";
import {
  STUDIO_CONTENT_REVIEW_CHECKS,
  type StudioAiReviewEvidence,
  type StudioContentReview,
  canExcludeRenderedStudioCandidate,
  canSelectInitialStudioCandidates,
  selectInitialStudioCandidates,
  studioContentReviewIssues,
  studioScopedGenerationProgress,
  studioSelectedMessageGroups,
  validateStudioAiReviewEvidence,
  validateStudioContentReview,
} from "./studio-content-review";

it("keeps master-wide file progress across channel groups and their image review substeps", () => {
  const counts = { finished: 3, groupSize: 3, groupCompleted: 0, total: 9 };
  const next = studioScopedGenerationProgress(
    { phase: "rendering", provider: "local", completed: 1, total: 3 },
    counts,
  );
  expect(next).toMatchObject({
    groupCompleted: 1,
    progress: { phase: "rendering", completed: 4, total: 9 },
  });
  expect(
    studioScopedGenerationProgress(
      {
        phase: "reviewing",
        provider: "gemini",
        completed: 0,
        total: 1,
        presentationIssues: ["Needs correction"],
      },
      { ...counts, groupCompleted: next.groupCompleted },
    ).progress,
  ).toMatchObject({ completed: 4, total: 9, presentationIssues: ["Needs correction"] });
  const complete = {
    phase: "complete" as const,
    provider: "local" as const,
    completed: 3,
    total: 3,
  };
  expect(studioScopedGenerationProgress(complete, counts).progress).toMatchObject({
    phase: "rendering",
    completed: 6,
    total: 9,
  });
  expect(
    studioScopedGenerationProgress(complete, { ...counts, finished: 6 }).progress,
  ).toMatchObject({ phase: "complete", completed: 9, total: 9 });
});
import { type StudioPlan, reuseStudioPlanTranslations } from "./studio-planner";

const plan = {
  outputs: [{ channel: "youtube", language: "en", format: "short" }],
  translations: [],
  skippedChannels: [],
} as unknown as StudioPlan;
const complete = {
  channel: "youtube",
  language: "en",
  ...Object.fromEntries(STUDIO_CONTENT_REVIEW_CHECKS.map((k) => [k, true])),
  reason: "A complete question and answer are included.",
};

describe("initial candidate selection", () => {
  const initial = {
    request: { allCompleteMessages: true, channels: ["youtube", "facebook"], languages: ["en"] },
    outputs: [],
    provenance: null,
    feedback: [],
  } as unknown as StudioPackage;

  it("isolates final-media failures only for independent new discovery candidates", () => {
    const single = {
      ...initial,
      request: { ...initial.request, channels: ["youtube"] },
    } as StudioPackage;
    expect(canExcludeRenderedStudioCandidate(single, false)).toBe(true);
    expect(canExcludeRenderedStudioCandidate(initial, false)).toBe(false);
    expect(canExcludeRenderedStudioCandidate(single, true)).toBe(false);
    for (const changed of [
      { outputs: [{}] },
      { provenance: {} },
      { approval: {} },
      { feedback: [{ action: "REJECTED" }] },
      { request: { ...single.request, languages: ["en", "te"] } },
    ])
      expect(
        canExcludeRenderedStudioCandidate({ ...single, ...changed } as StudioPackage, false),
      ).toBe(false);
  });

  it("never drops files during human corrections or after delivery", () => {
    expect(canSelectInitialStudioCandidates(initial, false)).toBe(true);
    expect(canSelectInitialStudioCandidates(initial, true)).toBe(false);
    for (const changed of [
      { request: { ...initial.request, allCompleteMessages: false } },
      { outputs: [{}] },
      { provenance: {} },
      { feedback: [{ action: "REJECTED" }] },
    ]) {
      expect(
        canSelectInitialStudioCandidates({ ...initial, ...changed } as StudioPackage, false),
      ).toBe(false);
    }
  });

  it("keeps passing text and translations unchanged and explains an omitted channel", () => {
    const proposed = {
      ...plan,
      outputs: [
        { ...plan.outputs[0], messageId: "message-01", title: "Complete teaching" },
        { ...plan.outputs[0], channel: "facebook", messageId: "message-02", title: "Too short" },
      ],
    } as StudioPlan;
    const checks = proposed.outputs.map((output) => ({
      ...complete,
      channel: output.channel,
      messageId: output.messageId,
      endingComplete: output.channel !== "facebook",
    })) as StudioContentReview[];
    const selected = selectInitialStudioCandidates(proposed, checks, initial.request);
    expect(selected.outputs).toEqual([proposed.outputs[0]]);
    expect(selected.outputs[0]).toBe(proposed.outputs[0]);
    expect(selected.translations).toBe(proposed.translations);
    expect(selected.skippedChannels).toEqual([
      { channel: "facebook", reason: expect.stringContaining("No complete candidate passed") },
    ]);
    expect(selected.excludedMessages).toEqual([
      {
        messageId: "message-02",
        title: "Too short",
        reasons: [expect.stringContaining("endingComplete")],
      },
    ]);
    expect(proposed.outputs).toHaveLength(2);
    expect(() =>
      selectInitialStudioCandidates(proposed, checks.slice(0, 1), initial.request),
    ).toThrow("STUDIO_VIDEO_REVIEW_INVALID");
  });
});
it("groups selected teaching variants without filling unselected channel/language pairs", () => {
  const outputs = [
    { id: "a", messageId: "message-01", channel: "youtube", language: "en" },
    { id: "b", messageId: "message-01", channel: "facebook", language: "en" },
    { id: "c", messageId: "message-01", channel: "youtube", language: "hi" },
    { id: "d", messageId: "message-01", channel: "facebook", language: "hi" },
    { id: "e", messageId: "message-01", channel: "youtube", language: "te" },
    { id: "f", messageId: "message-02", channel: "youtube", language: "en" },
  ];
  expect(studioSelectedMessageGroups(outputs).map((group) => group.map((o) => o.id))).toEqual([
    ["a", "b", "c", "d"],
    ["e"],
    ["f"],
  ]);
  expect(
    studioSelectedMessageGroups(outputs.filter((o) => ["a", "d"].includes(o.id))),
  ).toHaveLength(2);
});
describe("independent video review", () => {
  it("blocks a native conditional ending even when the translated caption sounds complete", () => {
    const checks = validateStudioContentReview(
      {
        checks: [
          {
            ...complete,
            endingComplete: false,
            captionsFaithful: false,
            reason:
              "తెలిపితే leaves the condition incomplete; the excluded next segment supplies the consequence which the English caption silently inserts.",
          },
        ],
      },
      plan,
    );
    expect(studioContentReviewIssues(checks)).toEqual([
      expect.stringContaining("endingComplete, captionsFaithful"),
    ]);
  });
  it("accepts complete checks without turning them into publication approval", () => {
    expect(
      studioContentReviewIssues(validateStudioContentReview({ checks: [complete] }, plan)),
    ).toEqual([]);
  });
  it.each([
    null,
    {},
    { checks: [] },
    { checks: [complete, complete] },
    { checks: [{ ...complete, channel: "facebook" }] },
    { checks: [{ ...complete, endingComplete: "true" }] },
    { checks: [{ ...complete, captionsFaithful: undefined }] },
    { checks: [{ ...complete, reason: "" }] },
  ])("fails closed on malformed or incomplete coverage: %j", (raw) => {
    expect(() => validateStudioContentReview(raw, plan)).toThrow("STUDIO_VIDEO_REVIEW_INVALID");
  });
  it("rejects duplicate reviews even when their count equals the number of videos", () => {
    const first = plan.outputs[0];
    if (!first) throw Error("Missing fixture");
    const two = {
      ...plan,
      outputs: [...plan.outputs, { ...first, channel: "facebook" as const }],
    };
    expect(() => validateStudioContentReview({ checks: [complete, complete] }, two)).toThrow(
      "STUDIO_VIDEO_REVIEW_INVALID",
    );
  });
});

it("reviews the same previously checked captions that the combined package will render", () => {
  const prior = {
    ...plan,
    translations: [
      { language: "en" as const, segments: [{ id: "one", text: "If one tells them the story," }] },
    ],
  };
  const draft = {
    ...plan,
    translations: [
      {
        language: "en" as const,
        segments: [
          { id: "one", text: "Tell them the story to inspire faith." },
          { id: "two", text: "faith will also come." },
        ],
      },
    ],
  };
  const normalized = reuseStudioPlanTranslations(draft, prior);
  expect(normalized.translations[0]?.segments).toEqual([
    { id: "one", text: "If one tells them the story," },
    { id: "two", text: "faith will also come." },
  ]);
  expect(draft.translations[0]?.segments[0]?.text).toContain("inspire faith");
});

it("binds a passing AI review to the exact source, destination and file version", () => {
  const evidence = {
    status: "PASSED",
    policyVersion: "content-integrity-v1",
    provider: "gemini",
    model: "synthetic",
    recordedAt: "2026-10-12T04:00:00Z",
    inputMode: "transcript_and_audio",
    sourceSha256: "a".repeat(64),
    fileVersion: 2,
    humanFeedbackConsidered: false,
    checks: complete,
  } as StudioAiReviewEvidence;
  const target = {
    channel: "youtube",
    language: "en",
    sourceSha256: "a".repeat(64),
    fileVersion: 2,
  };
  expect(() => validateStudioAiReviewEvidence(evidence, target)).not.toThrow();
  for (const change of [{ fileVersion: 3 }, { sourceSha256: "b".repeat(64) }, { language: "te" }]) {
    expect(() => validateStudioAiReviewEvidence(evidence, { ...target, ...change })).toThrow(
      "INVALID_STUDIO_AI_REVIEW",
    );
  }
  expect(() =>
    validateStudioAiReviewEvidence(
      { ...evidence, checks: { ...evidence.checks, endingComplete: false } },
      target,
    ),
  ).toThrow("INVALID_STUDIO_AI_REVIEW");
});

it("repairs a failed message across both channels, preserving other files and their captions", async () => {
  const { studioContentRepairTargets, mergeStudioContentRepair } = await import(
    "./studio-content-review"
  );
  const outputs = [
    {
      channel: "youtube",
      language: "en",
      format: "short",
      messageId: "message-01",
      sourceSegmentIds: ["one"],
      title: "Keep",
    },
    {
      channel: "youtube",
      language: "en",
      format: "short",
      messageId: "message-02",
      sourceSegmentIds: ["two"],
      title: "Fix",
    },
    {
      channel: "facebook",
      language: "en",
      format: "reel",
      messageId: "message-02",
      sourceSegmentIds: ["two"],
      title: "Fix FB",
    },
  ] as StudioPlan["outputs"];
  const original = {
    outputs,
    translations: [
      {
        language: "en",
        segments: [
          { id: "one", text: "Preserved caption" },
          { id: "two", text: "Incomplete" },
        ],
      },
    ],
    skippedChannels: [],
  } as StudioPlan;
  const checks = outputs.map((o, i) => ({
    ...complete,
    channel: o.channel,
    language: o.language,
    ...(o.messageId ? { messageId: o.messageId } : {}),
    endingComplete: i !== 1,
  }));
  const targets = studioContentRepairTargets(original, checks as StudioContentReview[]);
  expect(targets).toHaveLength(2);
  const repaired = {
    ...original,
    outputs: outputs.map((o) => ({
      ...o,
      title: "Provider rewrote title",
      sourceSegmentIds: o.messageId === "message-02" ? ["two", "three"] : ["one"],
    })),
    translations: [
      {
        language: "en" as const,
        segments: [
          { id: "one", text: "Unwanted rewrite" },
          { id: "two", text: "Complete question" },
          { id: "three", text: "Answer" },
        ],
      },
    ],
  };
  const merged = mergeStudioContentRepair(original, repaired, targets);
  expect(merged.outputs[0]).toEqual(original.outputs[0]);
  expect(merged.outputs[1]?.sourceSegmentIds).toEqual(["two", "three"]);
  expect(merged.outputs[2]?.sourceSegmentIds).toEqual(["two", "three"]);
  expect(merged.translations[0]?.segments.find((s) => s.id === "one")?.text).toBe(
    "Preserved caption",
  );
  expect(() => mergeStudioContentRepair(original, { ...repaired, outputs: [] }, targets)).toThrow(
    "STUDIO_EDITED_OUTPUT_OMITTED",
  );
});
