import { describe, expect, it } from "vitest";
import {
  STUDIO_CHANNELS,
  type StudioOutput,
  type StudioPackage,
  type StudioTranscript,
} from "./intelligent-content";
import {
  STUDIO_BRAND_SIGNATURE,
  STUDIO_SKIP_REASON_LIMIT,
  STUDIO_TITLE_LIMITS,
  createLocalStudioPlan,
  enforceStudioPlanBranding,
  preserveStudioEditorialEdits,
  studioFormatForChannel,
  studioGenerationReadiness,
  studioSourceRange,
  validateStudioPlan,
} from "./studio-planner";
const transcript: StudioTranscript = {
  language: "en",
  durationMs: 2000,
  segments: [
    { id: "one", startMs: 0, endMs: 1000, text: "Practice kindness." },
    { id: "two", startMs: 1000, endMs: 2000, text: "Serve with care." },
  ],
  provenance: "MACHINE_TRANSCRIPT",
  sourceTranscriptId: null,
};
const pkg = {
  source: { title: "Daily practice", category: "pravachanams" },
  request: { languages: ["en"], channels: [...STUDIO_CHANNELS], instructions: "", captions: true },
} as StudioPackage;
describe("automatic source-based channel planning", () => {
  it.each(["facebook", "youtube", "instagram", "tiktok"] as const)(
    "enforces %s's exact video duration boundary without truncating source segments",
    (channel) => {
      const limit = channel === "facebook" ? 90_000 : 180_000;
      const current = { ...pkg, request: { ...pkg.request, channels: [channel] } };
      const result = createLocalStudioPlan(current, transcript);
      const source = structuredClone(transcript);
      source.durationMs = limit + 1;
      const last = source.segments[1];
      if (!last) throw new Error("MISSING_SEGMENT");
      last.endMs = limit;
      expect(() => validateStudioPlan(result, current, source)).not.toThrow();
      last.endMs += 1;
      expect(() => validateStudioPlan(result, current, source)).toThrow("STUDIO_CLIP_TOO_LONG");
    },
  );
  it("skips an overlong Facebook passage while preserving a suitable YouTube excerpt", () => {
    const current = {
      ...pkg,
      request: { ...pkg.request, channels: ["facebook", "youtube"] as const },
    };
    const source: StudioTranscript = {
      ...transcript,
      durationMs: 94_740,
      segments: [{ id: "one", startMs: 0, endMs: 94_740, text: "One complete passage." }],
    };
    const result = createLocalStudioPlan(
      { ...current, request: { ...current.request, channels: [...current.request.channels] } },
      source,
    );
    expect(result.outputs.map((output) => output.channel)).toEqual(["youtube"]);
    expect(result.skippedChannels).toEqual([
      { channel: "facebook", reason: expect.stringContaining("complete") },
    ]);
    expect(result.outputs[0]?.sourceSegmentIds).toEqual(["one"]);
  });

  it("uses one canonical format mapping for every supported social destination", () => {
    expect(
      Object.fromEntries(
        STUDIO_CHANNELS.map((channel) => [channel, studioFormatForChannel(channel)]),
      ),
    ).toEqual({
      youtube: "short",
      instagram: "reel",
      facebook: "reel",
      x: "post",
      reddit: "blog",
      tiktok: "reel",
      threads: "post",
      linkedin: "post",
      pinterest: "post",
      telegram: "post",
      whatsapp: "post",
      bluesky: "post",
      website: "blog",
    });
  });
  it("keeps long YouTube and Pinterest titles within delivery limits without splitting graphemes", () => {
    const title = `${"A".repeat(98)}👨‍👩‍👧‍👦 e\u0301 శ్రీ`;
    const current = { ...pkg, source: { ...pkg.source, title } };
    const result = createLocalStudioPlan(current, transcript);
    for (const output of result.outputs) {
      expect(output.title.length).toBeLessThanOrEqual(STUDIO_TITLE_LIMITS[output.channel]);
      if (["youtube", "pinterest"].includes(output.channel))
        expect(output.title).toBe(`${"A".repeat(98)}…`);
    }
    for (const channel of ["youtube", "pinterest"] as const) {
      const invalid = structuredClone(result);
      const output = invalid.outputs.find((item) => item.channel === channel);
      if (!output) throw new Error("MISSING_OUTPUT");
      output.title = "x".repeat(101);
      expect(() => validateStudioPlan(invalid, current, transcript)).toThrow("INVALID_STUDIO_COPY");
    }
  });
  it("fits Telegram photo captions by UTF-16 units while retaining complete graphemes and branding", () => {
    const cluster = "👨‍👩‍👧‍👦";
    const text = cluster.repeat(100);
    const first = transcript.segments[0];
    if (!first) throw new Error("MISSING_SEGMENT");
    const source = { ...transcript, segments: [{ ...first, text }] };
    const current = { ...pkg, request: { ...pkg.request, channels: ["telegram" as const] } };
    const result = createLocalStudioPlan(current, source);
    const output = result.outputs[0];
    if (!output) throw new Error("MISSING_OUTPUT");
    expect(output.body.length).toBeLessThanOrEqual(1000);
    expect(output.body.length).toBeLessThan(1024);
    const footer = `\n\n${STUDIO_BRAND_SIGNATURE}`;
    expect(output.body.endsWith(`…${footer}`)).toBe(true);
    const excerpt = output.body.slice(0, -`…${footer}`.length);
    expect(excerpt).toBe(cluster.repeat(excerpt.length / cluster.length));
    output.body = text + footer;
    expect([...output.body].length).toBeLessThan(1000);
    expect(() => validateStudioPlan(result, current, source)).toThrow("INVALID_STUDIO_COPY");
  });
  it("generates all suitable formats and gives a reason for irrelevant channels", () => {
    const p = createLocalStudioPlan(pkg, transcript);
    expect(new Set(p.outputs.map((o) => o.format))).toEqual(
      new Set(["short", "reel", "post", "blog"]),
    );
    expect(p.outputs).toHaveLength(STUDIO_CHANNELS.length - 1);
    expect(p.skippedChannels).toEqual([
      { channel: "linkedin", reason: expect.stringContaining("service") },
    ]);
    for (const o of p.outputs) {
      expect(o.body).toContain("@sgsswamiji");
      expect(o.sourceSegmentIds).toEqual(["one", "two"]);
    }
  });
  it("keeps skipped-channel explanations inside the persisted provenance limit", () => {
    const result = createLocalStudioPlan(pkg, transcript);
    const skip = result.skippedChannels[0];
    if (!skip) throw new Error("MISSING_SKIPPED_CHANNEL");
    expect(STUDIO_SKIP_REASON_LIMIT).toBe(500);
    skip.reason = "x".repeat(STUDIO_SKIP_REASON_LIMIT);
    expect(() => validateStudioPlan(result, pkg, transcript)).not.toThrow();
    skip.reason += "x";
    expect(() => validateStudioPlan(result, pkg, transcript)).toThrow("INVALID_STUDIO_SKIP");
  });
  it("does not call untranslated source text a translation", () => {
    expect(() =>
      createLocalStudioPlan({ ...pkg, request: { ...pkg.request, languages: ["hi"] } }, transcript),
    ).toThrow("STUDIO_TRANSLATION_PROVIDER_REQUIRED");
  });
  it("refuses disconnected, reordered and invented segment references", () => {
    for (const ids of [
      ["two", "one"],
      ["one", "missing"],
      ["one", "one"],
    ])
      expect(() => studioSourceRange(ids, transcript)).toThrow();
  });
  it.each(["website", "x", "youtube", "instagram"] as const)(
    "validates ordered separated citations according to %s format",
    (channel) => {
      const source: StudioTranscript = {
        ...transcript,
        durationMs: 3000,
        segments: [
          ...transcript.segments,
          { id: "three", startMs: 2000, endMs: 3000, text: "Continue this service with patience." },
        ],
      };
      const current = { ...pkg, request: { ...pkg.request, channels: [channel] } };
      const result = createLocalStudioPlan(current, source);
      const output = result.outputs[0];
      if (!output) throw new Error("MISSING_OUTPUT");
      output.sourceSegmentIds = ["one", "three"];
      if (channel === "website" || channel === "x") {
        expect(() => validateStudioPlan(result, current, source)).not.toThrow();
        expect(
          studioSourceRange(output.sourceSegmentIds, source, output.format).segments.map(
            (segment) => segment.id,
          ),
        ).toEqual(["one", "three"]);
      } else {
        expect(() => validateStudioPlan(result, current, source)).toThrow(
          "STUDIO_SOURCE_EVIDENCE_REQUIRED",
        );
      }
      for (const ids of [
        ["three", "one"],
        ["one", "missing"],
        ["one", "one"],
      ]) {
        output.sourceSegmentIds = ids;
        expect(() => validateStudioPlan(result, current, source)).toThrow(
          "STUDIO_SOURCE_EVIDENCE_REQUIRED",
        );
      }
      expect(() => studioSourceRange(["one", "three"], source)).toThrow(
        "STUDIO_SOURCE_EVIDENCE_REQUIRED",
      );
    },
  );
  it("adds branding without altering editorial text, clipping copy or mutating the provider plan", () => {
    const current = { ...pkg, request: { ...pkg.request, channels: ["youtube" as const] } };
    const generated = createLocalStudioPlan(current, transcript);
    const output = generated.outputs[0];
    if (!output) throw new Error("MISSING_OUTPUT");
    output.body = "x".repeat(4500);
    const before = structuredClone(generated);
    const branded = enforceStudioPlanBranding(generated);
    expect(branded.outputs[0]?.body).toBe(`${output.body}\n\n${STUDIO_BRAND_SIGNATURE}`);
    expect(branded.outputs[0]?.sourceSegmentIds).toEqual(output.sourceSegmentIds);
    expect(generated).toEqual(before);
    expect(enforceStudioPlanBranding(branded)).toEqual(branded);
    expect(() => validateStudioPlan(branded, current, transcript)).toThrow("INVALID_STUDIO_COPY");
    output.body = " ";
    expect(enforceStudioPlanBranding(generated).outputs[0]?.body).toBe(" ");
    expect(() =>
      validateStudioPlan(enforceStudioPlanBranding(generated), current, transcript),
    ).toThrow("INVALID_STUDIO_COPY");
  });
  it("rejects missing branding or incomplete generated channel coverage", () => {
    const p = createLocalStudioPlan(pkg, transcript);
    const first = p.outputs[0];
    if (!first) throw new Error("Missing fixture output");
    first.body = "Unbranded";
    expect(() => validateStudioPlan(p, pkg, transcript)).toThrow("INVALID_STUDIO_COPY");
    const q = createLocalStudioPlan(pkg, transcript);
    q.outputs.pop();
    expect(() => validateStudioPlan(q, pkg, transcript)).toThrow(
      "STUDIO_CHANNEL_COVERAGE_REQUIRED",
    );
  });
  it("does not claim provider configuration or translation readiness by default", () => {
    expect(studioGenerationReadiness({}).available).toBe(false);
    expect(studioGenerationReadiness({ STUDIO_GENERATION_ENABLED: "true" }).translation).toBe(
      false,
    );
    expect(
      studioGenerationReadiness({
        STUDIO_GENERATION_ENABLED: "true",
        STUDIO_INTELLIGENCE_PROVIDER: "openai",
      }).available,
    ).toBe(false);
  });
  it("projects Gemini and Sarvam readiness from server flags without exposing credentials", () => {
    const flags = {
      STUDIO_GENERATION_ENABLED: "true",
      STUDIO_INTELLIGENCE_PROVIDER: "gemini",
      STUDIO_GEMINI_CONFIGURED: "true",
      STUDIO_GEMINI_MODEL: "gemini-configured-model",
      STUDIO_TRANSCRIPTION_PROVIDER: "sarvam",
      STUDIO_SARVAM_CONFIGURED: "true",
    };
    const expected = {
      available: true,
      transcription: "Sarvam timed transcription",
      intelligence: "Gemini source analysis and channel drafting",
      translation: true,
      reason: null,
    };
    expect(studioGenerationReadiness(flags)).toEqual(expected);
    const withKeys = studioGenerationReadiness({
      ...flags,
      STUDIO_GEMINI_CONFIGURED: "false",
      STUDIO_SARVAM_CONFIGURED: "false",
      STUDIO_GEMINI_API_KEY: "synthetic-gemini-secret",
      STUDIO_SARVAM_API_KEY: "synthetic-sarvam-secret",
    });
    expect(withKeys).toEqual(expected);
    expect(JSON.stringify(withKeys)).not.toContain("synthetic-");
    expect(JSON.stringify(withKeys)).not.toContain("API_KEY");
  });
  it("requires an explicit configured Gemini model and never implies readiness from a model alone", () => {
    const base = { STUDIO_GENERATION_ENABLED: "true", STUDIO_INTELLIGENCE_PROVIDER: "gemini" };
    for (const additional of [
      {},
      { STUDIO_GEMINI_API_KEY: "synthetic-secret" },
      { STUDIO_GEMINI_CONFIGURED: "true" },
      { STUDIO_GEMINI_MODEL: "gemini-configured-model" },
      { STUDIO_GEMINI_MODEL: "gemini-configured-model", STUDIO_GEMINI_CONFIGURED: "false" },
    ])
      expect(studioGenerationReadiness({ ...base, ...additional })).toMatchObject({
        available: false,
        translation: false,
        reason: "STUDIO_INTELLIGENCE_NOT_CONFIGURED",
      });
    expect(
      studioGenerationReadiness({
        ...base,
        STUDIO_GENERATION_ENABLED: "false",
        STUDIO_GEMINI_API_KEY: "synthetic-secret",
        STUDIO_GEMINI_MODEL: "gemini-configured-model",
      }),
    ).toMatchObject({ available: false, translation: false, reason: "STUDIO_GENERATION_DISABLED" });
    expect(
      studioGenerationReadiness({
        ...base,
        STUDIO_GEMINI_CONFIGURED: "true",
        STUDIO_GEMINI_MODEL: "gemini-configured-model",
        STUDIO_TRANSCRIPTION_PROVIDER: "sarvam",
      }).transcription,
    ).toBe("Sarvam transcription not configured; saved approved transcript required");
  });
  it.each([
    ["sarvam", "Sarvam transcription not configured; saved approved transcript required"],
    ["openai", "OpenAI transcription not configured; saved approved transcript required"],
    ["sarvm", "Selected transcription provider not supported; saved approved transcript required"],
  ])(
    "reports explicit %s ASR configuration failure without implying a local fallback",
    (provider, expected) => {
      expect(
        studioGenerationReadiness({
          STUDIO_GENERATION_ENABLED: "true",
          STUDIO_INTELLIGENCE_PROVIDER: "local",
          STUDIO_TRANSCRIPTION_PROVIDER: provider,
          STUDIO_WHISPER_COMMAND: "/operator/local-whisper",
          STUDIO_TRANSCRIPT_CACHE_ROOT: "/operator/cache",
        }),
      ).toMatchObject({ available: true, transcription: expected });
    },
  );
  it("requires every language for each included channel", () => {
    const current = {
      ...pkg,
      request: { ...pkg.request, channels: ["website"] as const, languages: ["en", "hi"] as const },
    };
    const generated = createLocalStudioPlan(
      { ...pkg, request: { ...pkg.request, channels: ["website"] } },
      transcript,
    );
    expect(() =>
      validateStudioPlan(
        generated,
        {
          ...current,
          request: {
            ...current.request,
            channels: [...current.request.channels],
            languages: [...current.request.languages],
          },
        },
        transcript,
      ),
    ).toThrow("STUDIO_CHANNEL_COVERAGE_REQUIRED");
  });
  it("retains pending manual corrections and original evidence without mutating a generated plan", () => {
    const plan = createLocalStudioPlan(pkg, transcript);
    const original = plan.outputs.find((output) => output.channel === "website");
    if (!original) throw new Error();
    const edited: StudioOutput = {
      ...original,
      id: "edited-output",
      title: "Edited title",
      body: "Corrected reflection. @sgsswamiji",
      sourceSegmentIds: ["two"],
      rationale: "Corrected against the second source segment",
      included: true,
      startMs: null,
      endMs: null,
      aspect: "prose",
      asset: null,
      captions: [],
      warnings: [],
    };
    const before = structuredClone(plan);
    const result = preserveStudioEditorialEdits(plan, { ...pkg, outputs: [edited] });
    expect(result.outputs.find((output) => output.channel === "website")).toMatchObject({
      title: edited.title,
      body: edited.body,
      sourceSegmentIds: ["two"],
      rationale: edited.rationale,
    });
    expect(plan).toEqual(before);
  });
  it("refuses silent omission of a pending edited output, including a newly skipped channel", () => {
    const plan = createLocalStudioPlan(pkg, transcript);
    const original = plan.outputs.find((output) => output.channel === "website");
    if (!original) throw new Error();
    const edited: StudioOutput = {
      ...original,
      id: "edited-output",
      body: "A coordinator correction. @sgsswamiji",
      included: true,
      startMs: null,
      endMs: null,
      aspect: "prose",
      asset: null,
      captions: [],
      warnings: [],
    };
    plan.outputs = plan.outputs.filter((output) => output.channel !== "website");
    plan.skippedChannels.push({
      channel: "website",
      reason: "New plan considered this unsuitable",
    });
    expect(() => preserveStudioEditorialEdits(plan, { ...pkg, outputs: [edited] })).toThrow(
      "STUDIO_EDITED_OUTPUT_OMITTED",
    );
    expect(() =>
      preserveStudioEditorialEdits(plan, {
        ...pkg,
        outputs: [edited],
        request: { ...pkg.request, channels: ["youtube"] },
      }),
    ).not.toThrow();
  });
});

describe("multiple complete messages from one master", () => {
  const current = {
    ...pkg,
    request: {
      ...pkg.request,
      channels: ["youtube", "facebook"] as ("youtube" | "facebook")[],
      allCompleteMessages: true,
    },
  };
  function messages() {
    return {
      outputs: current.request.channels.flatMap((channel) =>
        ["one", "two"].map((id, i) => ({
          channel,
          language: "en" as const,
          format: studioFormatForChannel(channel),
          messageId: `message-${i + 1}`,
          title: `Teaching ${i + 1}`,
          body: `Complete teaching.\n\n${STUDIO_BRAND_SIGNATURE}`,
          rationale: "A complete source-backed action.",
          sourceSegmentIds: [id],
        })),
      ),
      translations: [],
      skippedChannels: [],
    };
  }
  it("accepts multiple independently identified messages for the same channel and language", () => {
    expect(() => validateStudioPlan(messages(), current, transcript)).not.toThrow();
  });
  it("does not allow repeated passages under different IDs or mismatched channel versions of a message", () => {
    const repeated = messages();
    const repeatedOutput = repeated.outputs[1];
    if (!repeatedOutput) throw Error("Missing fixture");
    repeatedOutput.sourceSegmentIds = ["one"];
    expect(() => validateStudioPlan(repeated, current, transcript)).toThrow(
      "DUPLICATE_STUDIO_PASSAGE",
    );
    const changed = messages();
    const changedOutput = changed.outputs[2];
    if (!changedOutput) throw Error("Missing fixture");
    changedOutput.sourceSegmentIds = ["two"];
    expect(() => validateStudioPlan(changed, current, transcript)).toThrow(
      "STUDIO_MESSAGE_SOURCE_MISMATCH",
    );
  });
  it("retains only the targeted message's editorial corrections", () => {
    const plan = messages();
    const edited = {
      ...plan.outputs[1],
      asset: null,
      body: `A faithful correction.\n\n${STUDIO_BRAND_SIGNATURE}`,
    } as StudioOutput;
    const result = preserveStudioEditorialEdits(plan, { ...current, outputs: [edited] });
    expect(result.outputs[0]).toEqual(plan.outputs[0]);
    expect(result.outputs[1]?.body).toBe(edited.body);
    expect(result.outputs[2]).toEqual(plan.outputs[2]);
  });
  it("replaces a legacy footer when creating new branded files", () => {
    const plan = messages();
    const output = plan.outputs[0];
    if (!output) throw Error("Missing fixture");
    output.body = "Faithful teaching.\n\nSGS Datta Sannidhi";
    expect(enforceStudioPlanBranding(plan).outputs[0]?.body).toBe(
      `Faithful teaching.\n\n${STUDIO_BRAND_SIGNATURE}`,
    );
  });
});

it("assigns live teaching starts to exactly one window while permitting completion in look-ahead", () => {
  const current = {
    ...pkg,
    source: {
      ...pkg.source,
      liveWindow: {
        broadcastId: "broadcast",
        windowId: "window",
        startOffsetMs: 0,
        ownedEndMs: 1000,
      },
    },
    request: { ...pkg.request, channels: ["youtube" as const] },
  };
  const plan = createLocalStudioPlan(current, transcript);
  expect(() => validateStudioPlan(plan, current, transcript)).not.toThrow();
  if (!plan.outputs[0]) throw Error("MISSING_FIXTURE");
  plan.outputs[0].sourceSegmentIds = ["two"];
  expect(() => validateStudioPlan(plan, current, transcript)).toThrow("STUDIO_LIVE_OVERLAP");
});

it("keeps the channel subscription link in YouTube copy through planning and repairs", () => {
  const target = { label: "Gurubhavana ADPT", url: "https://www.youtube.com/@gurubhavanaadpt" };
  const current = { ...pkg, request: { ...pkg.request, youtubeClosing: target } };
  const local = createLocalStudioPlan(current, transcript);
  const youtube = local.outputs.find((output) => output.channel === "youtube");
  expect(youtube?.body).toContain(`Subscribe to ${target.label}: ${target.url}`);
  expect(youtube?.body).toContain("@sgsswamiji");
  expect(local.outputs.find((output) => output.channel === "facebook")?.body).not.toContain(
    target.url,
  );
  const provider = structuredClone(local);
  const copy = provider.outputs.find((output) => output.channel === "youtube");
  if (!copy) throw Error("MISSING_YOUTUBE");
  copy.body = "Practice kindness.\n\n@sgsswamiji";
  const repaired = enforceStudioPlanBranding(provider, current.request);
  expect(repaired.outputs.find((output) => output.channel === "youtube")?.body).toContain(
    target.url,
  );
  expect(enforceStudioPlanBranding(repaired, current.request)).toEqual(repaired);
  expect(() => validateStudioPlan(provider, current, transcript)).toThrow("INVALID_STUDIO_COPY");
  expect(() => validateStudioPlan(repaired, current, transcript)).not.toThrow();
});

describe("precise human trim", () => {
  it("clips intersecting cues, drops excluded cues and keeps original evidence untouched", () => {
    expect(
      studioSourceRange(["one", "two"], transcript, "short", { startMs: 500, endMs: 1750 }),
    ).toEqual({
      startMs: 500,
      endMs: 1750,
      segments: [
        { ...transcript.segments[0], startMs: 500 },
        { ...transcript.segments[1], endMs: 1750 },
      ],
    });
    expect(
      studioSourceRange(["one", "two"], transcript, "short", {
        startMs: 1000,
        endMs: 2000,
      }).segments.map((s) => s.id),
    ).toEqual(["two"]);
    expect(transcript.segments[0]?.startMs).toBe(0);
  });
  it.each([
    { startMs: -1, endMs: 1500 },
    { startMs: 0, endMs: 2001 },
    { startMs: 1500, endMs: 1000 },
    { startMs: 0.5, endMs: 2000 },
    { startMs: Number.NaN, endMs: 2000 },
  ])("rejects invalid exact boundaries %j", (trim) => {
    expect(() => studioSourceRange(["one", "two"], transcript, "short", trim)).toThrow(
      "INVALID_STUDIO_TRIM",
    );
  });
});

it("requires translations only for the speech kept by a precise trim", () => {
  const translated = createLocalStudioPlan(
    { ...pkg, request: { ...pkg.request, channels: ["youtube"] } },
    transcript,
  );
  translated.outputs = translated.outputs.map((o) => ({
    ...o,
    language: "te",
    sourceTrim: { startMs: 1000, endMs: 2000 },
  }));
  translated.translations = [{ language: "te", segments: [{ id: "two", text: "మంచి మాట." }] }];
  expect(() =>
    validateStudioPlan(
      translated,
      { ...pkg, request: { ...pkg.request, channels: ["youtube"], languages: ["te"] } },
      transcript,
    ),
  ).not.toThrow();
});
