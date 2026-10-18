import { expect, it } from "vitest";
import {
  type StudioPresentationReview,
  type StudioSourceScreen,
  alignStudioIllustration,
  retimeStudioIllustrations,
  safeStudioPortraitScenes,
  validateStudioPresentationReview,
  validateStudioSourceScreen,
} from "./studio-presentation";
const screen: StudioSourceScreen = {
  openingComplete: true,
  endingComplete: true,
  naturalStart: true,
  naturalEnd: true,
  reason: "Complete spoken sentence, then a pause. Intro has full-width names.",
  scenes: [{ startMs: 10000, endMs: 30000, bodyTop: 0, bodyBottom: 0.88 }],
};
it("preserves the full title card and uncertain transition before enlarging the speaker", () => {
  expect(safeStudioPortraitScenes(screen, 30000)).toEqual([
    { startMs: 11000, endMs: 30000, bodyTop: 0, bodyBottom: 0.88 },
  ]);
  expect(safeStudioPortraitScenes({ ...screen, scenes: [] }, 30000)).toEqual([]);
});
it("keeps adjacent identical speaker crops continuous without artificial wide-view flashes", () => {
  const scenes = [
    { startMs: 0, endMs: 36500, bodyTop: 0, bodyBottom: 0.88 },
    { startMs: 36500, endMs: 46800, bodyTop: 0, bodyBottom: 0.88 },
    { startMs: 46800, endMs: 54180, bodyTop: 0, bodyBottom: 0.88 },
  ];
  const before = structuredClone(scenes);
  expect(safeStudioPortraitScenes({ ...screen, scenes }, 54180)).toEqual([
    { startMs: 0, endMs: 54180, bodyTop: 0, bodyBottom: 0.88 },
  ]);
  expect(scenes).toEqual(before);
});
it("retains real unsafe gaps while avoiding padding between adjacent safe camera views", () => {
  expect(
    safeStudioPortraitScenes(
      {
        ...screen,
        scenes: [
          { startMs: 0, endMs: 10000, bodyTop: 0, bodyBottom: 0.88 },
          { startMs: 10000, endMs: 20000, bodyTop: 0, bodyBottom: 0.9 },
          { startMs: 23000, endMs: 30000, bodyTop: 0, bodyBottom: 0.9 },
        ],
      },
      30000,
    ),
  ).toEqual([
    { startMs: 0, endMs: 10000, bodyTop: 0, bodyBottom: 0.88 },
    { startMs: 10000, endMs: 19000, bodyTop: 0, bodyBottom: 0.9 },
    { startMs: 24000, endMs: 30000, bodyTop: 0, bodyBottom: 0.9 },
  ]);
});
it.each([
  { startMs: -1 },
  { endMs: 30001 },
  { endMs: 5000 },
  { bodyTop: 0.9 },
  { bodyBottom: Number.NaN },
  { bodyTop: "0.1" },
])("rejects unsafe geometry %j", (change) => {
  expect(() =>
    validateStudioSourceScreen(
      { ...screen, scenes: [{ ...screen.scenes[0], ...change }] } as StudioSourceScreen,
      30000,
    ),
  ).toThrow("STUDIO_PRESENTATION_REVIEW_INVALID");
});
it("rejects overlapping scene intervals and nonboolean approval", () => {
  expect(() =>
    validateStudioSourceScreen({ ...screen, scenes: [...screen.scenes, ...screen.scenes] }, 30000),
  ).toThrow();
  expect(() =>
    validateStudioSourceScreen(
      { ...screen, naturalEnd: "true" } as unknown as StudioSourceScreen,
      30000,
    ),
  ).toThrow();
});
const illustration = {
  assetId: "forgiveness",
  startMs: 12000,
  endMs: 16000,
  sourceSegmentIds: ["one"],
  reason: "Illustrates the spoken reconciliation.",
};
it("tightens imprecise insert timing to its cited words without inventing a longer passage", () => {
  const proposed = { ...illustration, startMs: 38000, endMs: 42000, sourceSegmentIds: ["four"] };
  const segments = [
    { id: "four", startMs: 37090, endMs: 57540, text: "The teaching addresses everyone." },
  ];
  expect(alignStudioIllustration(proposed, segments, 15910)).toMatchObject({
    startMs: 38000,
    endMs: 41630,
  });
  expect(() => alignStudioIllustration({ ...proposed, startMs: 41000 }, segments, 15910)).toThrow(
    "STUDIO_ILLUSTRATION_INVALID",
  );
  expect(() =>
    alignStudioIllustration({ ...proposed, sourceSegmentIds: ["unrelated"] }, segments, 15910),
  ).toThrow("STUDIO_ILLUSTRATION_INVALID");
});
it("keeps illustrations brief, separated, and out of the opening and ending", () => {
  expect(
    validateStudioSourceScreen({ ...screen, illustrations: [illustration] }, 30000).illustrations,
  ).toHaveLength(1);
  for (const change of [
    { startMs: 0 },
    { endMs: 29000 },
    { endMs: 18000 },
    { assetId: "../../file" },
  ])
    expect(() =>
      validateStudioSourceScreen(
        { ...screen, illustrations: [{ ...illustration, ...change }] },
        30000,
      ),
    ).toThrow();
  expect(() =>
    validateStudioSourceScreen(
      {
        ...screen,
        illustrations: [illustration, { ...illustration, startMs: 19000, endMs: 23000 }],
      },
      30000,
    ),
  ).toThrow();
});
it("covers all intervening speech while allowing natural silence between cited phrases", () => {
  const shot = {
    ...illustration,
    startMs: 6000,
    endMs: 10000,
    sourceSegmentIds: ["first", "last"],
  };
  const first = { id: "first", startMs: 106000, endMs: 108000, text: "Rama in exile." };
  const last = { id: "last", startMs: 109000, endMs: 110000, text: "Rama continues." };
  expect(() =>
    alignStudioIllustration(
      shot,
      [first, { id: "different", startMs: 108000, endMs: 109000, text: "Another subject." }, last],
      100000,
    ),
  ).toThrow("STUDIO_ILLUSTRATION_INVALID");
  expect(alignStudioIllustration(shot, [first, last], 100000)).toMatchObject({
    startMs: 6000,
    endMs: 10000,
  });
  expect(
    alignStudioIllustration(shot, [{ ...last, startMs: 108000 }, first], 100000),
  ).toMatchObject({ startMs: 6000, endMs: 10000 });
  expect(
    alignStudioIllustration(shot, [first, { ...last, startMs: 107500 }], 100000),
  ).toMatchObject({ startMs: 6000, endMs: 10000 });
});
it("binds passing quality evidence to the exact source, rendered bytes, and file version", () => {
  const evidence: StudioPresentationReview = {
    policy: "source-safe-portrait-v1",
    sourceSha256: "a".repeat(64),
    renderedSha256: "b".repeat(64),
    fileVersion: 2,
    model: "gemini-test",
    reviewedAt: new Date().toISOString(),
    framing: "screened-portrait",
    repairs: 1,
    source: screen,
    checks: {
      textIntact: true,
      subjectIntact: true,
      captionsClear: true,
      naturalBoundaries: true,
      illustrationsRelevant: true,
      reason: "All checks passed.",
    },
  };
  const binding = {
    sourceSha256: evidence.sourceSha256,
    renderedSha256: evidence.renderedSha256,
    fileVersion: 2,
    durationMs: 30000,
  };
  expect(() => validateStudioPresentationReview(evidence, binding)).not.toThrow();
  for (const change of [
    { fileVersion: 3 },
    { renderedSha256: "c".repeat(64) },
    { sourceSha256: "c".repeat(64) },
  ])
    expect(() => validateStudioPresentationReview(evidence, { ...binding, ...change })).toThrow();
  expect(() =>
    validateStudioPresentationReview(
      { ...evidence, checks: { ...evidence.checks, naturalBoundaries: false } },
      binding,
    ),
  ).toThrow();
});

it("extends only the requested existing illustration inside its cited speech", () => {
  const source = {
    ...screen,
    scenes: [],
    illustrations: [
      {
        ...illustration,
        assetId: "generated-one",
        startMs: 7000,
        endMs: 11000,
        sourceSegmentIds: ["parvati"],
      },
      {
        ...illustration,
        assetId: "generated-two",
        startMs: 29000,
        endMs: 33000,
        sourceSegmentIds: ["lakshmi"],
      },
    ],
  };
  const segments = [
    { id: "parvati", startMs: 195910, endMs: 210690, text: "Parvati asks Shiva." },
    { id: "lakshmi", startMs: 221280, endMs: 237760, text: "Lakshmi asks Sri Hari." },
  ];
  const result = retimeStudioIllustrations(
    source,
    [{ assetId: "generated-one", startMs: 7000, endMs: 13000 }],
    segments,
    195910,
    41850,
  );
  expect(result.illustrations?.[0]).toMatchObject({
    startMs: 7000,
    endMs: 13000,
    extendedByCurator: true,
  });
  expect(result.illustrations?.[1]).toEqual(source.illustrations[1]);
  expect(source.illustrations[0]?.endMs).toBe(11000);
  for (const change of [
    { assetId: "unknown", startMs: 7000, endMs: 13000 },
    { assetId: "generated-one", startMs: 7000, endMs: 15000 },
  ])
    expect(() => retimeStudioIllustrations(source, [change], segments, 195910, 41850)).toThrow(
      "STUDIO_ILLUSTRATION_INVALID",
    );
});

it("always samples the clean final card even for a busy storyboard", async () => {
  const { studioPresentationSampleTimes } = await import("./studio-presentation");
  const points = studioPresentationSampleTimes(
    87000,
    Array.from({ length: 20 }, (_, i) => 1000 + 3000 * i),
  );
  expect(points).toHaveLength(8);
  expect(points[0]).toBe(250);
  expect(points.at(-1)).toBe(86750);
});

it("allows sustained, contextual imagery under the new policy without changing legacy limits", () => {
  const rich: StudioSourceScreen = {
    ...screen,
    illustrationPolicy: "context-rich-v2",
    scenes: [],
    illustrations: [
      { ...illustration, startMs: 5000, endMs: 13000 },
      { ...illustration, startMs: 16000, endMs: 24000 },
      { ...illustration, startMs: 28000, endMs: 34000 },
    ],
  };
  expect(validateStudioSourceScreen(rich, 60000)).toEqual(rich);
  const { illustrationPolicy: _policy, ...legacy } = rich;
  expect(() => validateStudioSourceScreen(legacy, 60000)).toThrow();
  expect(() =>
    validateStudioSourceScreen(
      { ...rich, illustrations: [{ ...illustration, startMs: 5000, endMs: 14000 }] },
      60000,
    ),
  ).toThrow();
  expect(() =>
    validateStudioSourceScreen(
      { ...rich, illustrations: [{ ...illustration, startMs: 52000, endMs: 57000 }] },
      60000,
    ),
  ).toThrow();
  expect(() => validateStudioSourceScreen(rich, 50000)).toThrow();
  expect(() =>
    validateStudioSourceScreen(
      {
        ...rich,
        illustrations: [
          { ...illustration, startMs: 5000, endMs: 13000 },
          { ...illustration, startMs: 14000, endMs: 21000 },
        ],
      },
      60000,
    ),
  ).toThrow();
  const segment = [{ id: "one", text: "Source", startMs: 100000, endMs: 120000 }];
  expect(
    alignStudioIllustration(
      { ...illustration, startMs: 5000, endMs: 13000 },
      segment,
      100000,
      "context-rich-v2",
    ).endMs,
  ).toBe(13000);
  expect(() =>
    alignStudioIllustration({ ...illustration, startMs: 5000, endMs: 13000 }, segment, 100000),
  ).toThrow();
});
