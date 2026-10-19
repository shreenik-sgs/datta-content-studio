import {
  STUDIO_CONTENT_REVIEW_CHECKS,
  type StudioPackage,
  type StudioPlan,
  type StudioTranscript,
  studioContentReviewIssues,
  studioEnglishCaptionNeedsTranslation,
} from "@satsang/distribution-domain";
import { expect, it, vi } from "vitest";
import { reviewStudioContent } from "./studio-content-review";
const transcript: StudioTranscript = {
  language: "te",
  durationMs: 15000,
  provenance: "MACHINE_TRANSCRIPT",
  sourceTranscriptId: null,
  segments: [
    { id: "one", startMs: 0, endMs: 10000, text: "కథను వాళ్ళకు తెలిపితే." },
    { id: "two", startMs: 10000, endMs: 15000, text: "నమ్మకం కూడా వస్తుంది." },
  ],
};
const plan: StudioPlan = {
  outputs: [
    {
      channel: "youtube",
      language: "en",
      format: "short",
      title: "Faith",
      body: "@sgsswamiji",
      rationale: "The drafting model says this is complete.",
      sourceSegmentIds: ["one"],
    },
  ],
  translations: [
    { language: "en", segments: [{ id: "one", text: "Tell them the story to inspire faith." }] },
  ],
  skippedChannels: [],
};
const pkg = {
  source: { title: "Synthetic conditional boundary" },
  request: { captions: true },
} as StudioPackage;
function response(checks: unknown[]) {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          finishReason: "STOP",
          content: { role: "model", parts: [{ text: JSON.stringify({ checks }) }] },
        },
      ],
    }),
  );
}
const complete = {
  channel: "youtube",
  language: "en",
  ...Object.fromEntries(STUDIO_CONTENT_REVIEW_CHECKS.map((key) => [key, true])),
  reason: "Synthetic complete fixture.",
};
const input = {
  pkg,
  plan,
  transcript,
  provider: "gemini" as const,
  apiKey: "synthetic-private-key",
  model: "synthetic-model",
};
it("retains a dangling-story rejection even when its translation and later moral are faithful", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    response([
      {
        ...complete,
        openingComplete: false,
        contextComplete: false,
        reason:
          "The opening refers to an unidentified person and earlier sacrifice. The later moral does not establish that missing setup.",
      },
    ]),
  );
  const checks = await reviewStudioContent({ ...input, fetcher });
  expect(checks[0]).toMatchObject({
    openingComplete: false,
    contextComplete: false,
    captionsFaithful: true,
  });
  const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  const policy = request.systemInstruction.parts[0].text;
  expect(policy).toContain("Surrounding transcript is boundary evidence");
  expect(policy).toContain("After performing such a sacrifice");
  expect(policy).toContain("Do not repair missing context by inserting a name");
  expect(policy).toContain("A harmless discourse connector");
});
it("reviews bounded audio windows at absolute master offsets and retains a failure across windows", async () => {
  const reviewAudio = vi.fn().mockResolvedValue([
    { bytes: new Uint8Array([1, 2]), startMs: 0, endMs: 10000 },
    { bytes: new Uint8Array([3, 4]), startMs: 5000, endMs: 15000 },
  ]);
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      response([
        {
          ...complete,
          endingComplete: false,
          reason: "The omitted continuation changes the meaning.",
        },
      ]),
    )
    .mockResolvedValueOnce(response([complete]));
  const checks = await reviewStudioContent({ ...input, reviewAudio, fetcher });
  expect(reviewAudio).toHaveBeenCalledWith(plan);
  expect(checks[0]?.endingComplete).toBe(false);
  expect(checks[0]?.reason).toContain("omitted continuation");
  const requests = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  expect(requests).toHaveLength(2);
  expect(
    requests.map((r) => JSON.parse(r.contents[0].parts[0].text).audioAttachment.startMs),
  ).toEqual([0, 5000]);
  expect(requests.map((r) => JSON.parse(r.contents[0].parts[0].text).source.segments)).toEqual([
    [transcript.segments[0]],
    [transcript.segments[0]],
  ]);
  expect(Buffer.from(requests[1].contents[0].parts[1].inlineData.data, "base64")).toEqual(
    Buffer.from([3, 4]),
  );
});
it("does not approve a long-master output if extracting its source audio fails", async () => {
  const fetcher = vi.fn<typeof fetch>();
  await expect(
    reviewStudioContent({
      ...input,
      fetcher,
      reviewAudio: async () => {
        throw Error("RENDER_PROCESS_FAILED");
      },
    }),
  ).rejects.toThrow("RENDER_PROCESS_FAILED");
  expect(fetcher).not.toHaveBeenCalled();
});
it("reviews the native boundary, omitted continuation and selected translation independently", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    response([
      {
        ...complete,
        endingComplete: false,
        captionsFaithful: false,
        reason: "The consequence is in excluded segment two.",
      },
    ]),
  );
  const checks = await reviewStudioContent({
    ...input,
    originalAudio: new Uint8Array([1, 2]),
    fetcher,
  });
  expect(studioContentReviewIssues(checks)).toHaveLength(1);
  const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(request.generationConfig).not.toHaveProperty("maxOutputTokens");
  const data = JSON.parse(request.contents[0].parts[0].text);
  expect(data.source.segments).toEqual([transcript.segments[0]]);
  expect(data.excludedBoundaryContext[0].after).toEqual([transcript.segments[1]]);
  expect(data.excludedBoundaryContext[0].instruction).toContain(
    "Reject if omitting them changes the meaning",
  );
  expect(data.outputs[0]).not.toHaveProperty("rationale");
  expect(data.outputs[0].sourceSegmentIds).toEqual(["one"]);
  expect(data.outputs[0].captions).toEqual(plan.translations[0]?.segments);
  expect(request.systemInstruction.parts[0].text).toContain("ASR punctuation");
  expect(request.contents[0].parts[1].inlineData.mimeType).toBe("audio/mpeg");
  expect(JSON.stringify(request)).not.toContain("synthetic-private-key");
});

it.each([
  "teṣām ahaṁ samudhartā mṛtyu-saṁsāra-sāgarāt bhavāmi na cirāt pārtha",
  "Tri-vidham narakasyedam dvaram nasanam atmanah",
  "Kama, krodha, tatha lobha, tasmad etat trayam tyajet",
])("blocks a transliterated verse even when the AI passes it: %s", async (verse) => {
  const checks = await reviewStudioContent({
    ...input,
    plan: { ...plan, translations: [{ language: "en", segments: [{ id: "one", text: verse }] }] },
    fetcher: vi.fn<typeof fetch>().mockResolvedValue(response([complete])),
  });
  expect(checks[0]?.captionsFaithful).toBe(false);
  expect(checks[0]?.reason).toContain("untranslated Romanized speech at one");
  expect(studioEnglishCaptionNeedsTranslation(`The verse is '${verse}'.`)).toBe(true);
  for (const caption of [
    "Look at Shiva's names: Viśvam, Acyutaḥ, Viśvātmā.",
    "Jaya Guru Datta. Sri Guru Datta.",
    "Sri Gaṇapati Saccidānanda Swamiji, Śiva, Viṣṇu and Brahmā.",
    "I swiftly deliver them from the ocean of death and worldly existence, O Arjuna.",
  ])
    expect(studioEnglishCaptionNeedsTranslation(caption)).toBe(false);
});
it("reviews each teaching separately so another message cannot supply its missing context", async () => {
  const first = plan.outputs[0];
  if (!first) throw new Error("Missing fixture output");
  const outputs = ["message-01", "message-02"].flatMap((messageId) => [
    { ...first, messageId },
    { ...first, messageId, channel: "facebook" as const, format: "reel" as const },
  ]);
  const requests: { source: typeof transcript; outputs: typeof outputs }[] = [];
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const payload = JSON.parse(String(init?.body));
    const data = JSON.parse(payload.contents[0].parts[0].text);
    requests.push(data);
    return response(
      data.outputs.map((output: (typeof outputs)[number]) => ({
        ...complete,
        channel: output.channel,
        messageId: output.messageId,
        endingComplete: output.messageId !== "message-02",
      })),
    );
  });
  const checks = await reviewStudioContent({ ...input, plan: { ...plan, outputs }, fetcher });
  expect(requests).toHaveLength(2);
  expect(
    requests.map((request) => [...new Set(request.outputs.map((output) => output.messageId))]),
  ).toEqual([["message-01"], ["message-02"]]);
  expect(requests.every((request) => request.source.segments.length === 1)).toBe(true);
  expect(checks).toHaveLength(4);
  expect(studioContentReviewIssues(checks)).toHaveLength(2);
});
it("gives the independent reviewer Facebook's publishing limit when recommending repairs", async () => {
  const facebookPlan: StudioPlan = {
    ...plan,
    outputs: plan.outputs.map((output) => ({ ...output, channel: "facebook", format: "reel" })),
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(response([{ ...complete, channel: "facebook" }]));
  await reviewStudioContent({ ...input, plan: facebookPlan, fetcher });
  const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(JSON.parse(request.contents[0].parts[0].text).outputs[0].maximumVideoDurationMs).toBe(
    90_000,
  );
  expect(request.systemInstruction.parts[0].text).toContain("supplied maximumVideoDurationMs");
});
it("supplies exact selected timing and native speech without borrowing the preceding segment's start", async () => {
  const source: StudioTranscript = {
    ...transcript,
    durationMs: 1241530,
    segments: [
      { id: "before", startMs: 1146790, endMs: 1159110, text: "Excluded earlier question." },
      {
        id: "one",
        startMs: 1159110,
        endMs: 1236390,
        text: "Included complete question and explanation.",
      },
      { id: "two", startMs: 1236390, endMs: 1241530, text: "Included complete conclusion." },
    ],
  };
  const exactPlan: StudioPlan = {
    ...plan,
    outputs: plan.outputs.map((output) => ({
      ...output,
      channel: "facebook",
      format: "reel",
      sourceSegmentIds: ["one", "two"],
    })),
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(response([{ ...complete, channel: "facebook" }]));
  await reviewStudioContent({ ...input, transcript: source, plan: exactPlan, fetcher });
  const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  const output = JSON.parse(request.contents[0].parts[0].text).outputs[0];
  expect(output.selectedClip).toEqual({
    startMs: 1159110,
    endMs: 1241530,
    durationMs: 82420,
    segments: source.segments.slice(1),
  });
  expect(output.maximumVideoDurationMs).toBe(90000);
  expect(request.systemInstruction.parts[0].text).toContain(
    "never substitute the start of an adjacent excluded segment",
  );
});
it("rejects a missing video review instead of treating it as a pass", async () => {
  await expect(
    reviewStudioContent({
      ...input,
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(response([])),
    }),
  ).rejects.toThrow("STUDIO_VIDEO_REVIEW_INVALID");
});
it("does not call a provider for an empty batch", async () => {
  const fetcher = vi.fn<typeof fetch>();
  expect(await reviewStudioContent({ ...input, plan: { ...plan, outputs: [] }, fetcher })).toEqual(
    [],
  );
  expect(fetcher).not.toHaveBeenCalled();
});
it("keeps authentication failures distinct and never leaks provider bodies", async () => {
  await expect(
    reviewStudioContent({
      ...input,
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("private-provider-detail", { status: 401 })),
    }),
  ).rejects.toThrow("STUDIO_PROVIDER_AUTHENTICATION_FAILED");
});

it("reviews posts and articles as well as videos before they can be rendered", async () => {
  const article = {
    ...plan,
    outputs: [
      {
        ...plan.outputs[0],
        channel: "website",
        format: "blog",
        sourceSegmentIds: ["one", "two"],
        body: "An unsupported promise. @sgsswamiji",
      },
    ],
  } as StudioPlan;
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    response([
      {
        ...complete,
        channel: "website",
        copySupported: false,
        reason: "The source makes no such promise.",
      },
    ]),
  );
  const checks = await reviewStudioContent({ ...input, plan: article, fetcher });
  expect(studioContentReviewIssues(checks)).toEqual([expect.stringContaining("copySupported")]);
  const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(JSON.parse(request.contents[0].parts[0].text).outputs[0].format).toBe("blog");
  expect(request.systemInstruction.parts[0].text).toContain("noncontiguous source passages");
});

it("requires separate AI reviews for each message, not one pass per channel", async () => {
  const first = plan.outputs[0];
  if (!first) throw Error("Missing fixture");
  const multiple = {
    ...plan,
    outputs: [
      { ...first, messageId: "message-1" },
      { ...first, messageId: "message-2", sourceSegmentIds: ["two"] },
    ],
  };
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(response([{ ...complete, messageId: "message-1" }]))
    .mockResolvedValueOnce(
      response([
        {
          ...complete,
          messageId: "message-2",
          endingComplete: false,
          reason: "The answer is unfinished.",
        },
      ]),
    );
  const checks = await reviewStudioContent({ ...input, plan: multiple, fetcher });
  expect(studioContentReviewIssues(checks)).toEqual([expect.stringContaining("message-2")]);
  fetcher.mockResolvedValue(
    response([
      { ...complete, messageId: "message-1" },
      { ...complete, messageId: "message-1" },
    ]),
  );
  await expect(reviewStudioContent({ ...input, plan: multiple, fetcher })).rejects.toThrow(
    "STUDIO_VIDEO_REVIEW_INVALID",
  );
});

it("requires an English meaning for Sanskrit speech, rather than accepting romanization as English CC", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    response([
      {
        ...complete,
        captionsFaithful: false,
        reason: "The spoken verse is transliterated rather than translated into English.",
      },
    ]),
  );
  const checks = await reviewStudioContent({ ...input, fetcher });
  expect(studioContentReviewIssues(checks)[0]).toContain("captionsFaithful");
  const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  expect(request.systemInstruction.parts[0].text).toContain(
    "Romanized Sanskrit or Telugu is not an English translation",
  );
  expect(request.systemInstruction.parts[0].text).toContain(
    "Proper names and brief devotional greetings may remain unchanged",
  );
});

it("reviews the explicitly selected Bala Swamiji identity and channel rather than the global default", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([complete]));
  const youtubeClosing = {
    label: "Gurubhavana ADPT",
    url: "https://www.youtube.com/@gurubhavanaadpt",
  };
  await reviewStudioContent({
    ...input,
    pkg: { ...pkg, request: { ...pkg.request, sourceBranding: "bala-swamiji", youtubeClosing } },
    fetcher,
  });
  const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  const data = JSON.parse(request.contents[0].parts[0].text);
  expect(data.sourceSpeaker).toEqual({
    name: "Sri Datta Vijayananda Teertha Swamiji",
    signature: "@gurubhavanaadpt",
    portrait: false,
  });
  expect(data.youtubeClosing).toEqual(youtubeClosing);
  expect(request.systemInstruction.parts[0].text).toContain(
    "Do not attribute this recording to a different teacher",
  );
});

it("reviews the exact human trim and its edited caption instead of the whole original passage", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([complete]));
  const selected: StudioPlan = {
    ...plan,
    outputs: plan.outputs.map((o) => ({ ...o, sourceTrim: { startMs: 2000, endMs: 9500 } })),
  };
  await reviewStudioContent({
    ...input,
    useManualCaptions: true,
    plan: selected,
    pkg: {
      ...pkg,
      outputs: [
        {
          ...selected.outputs[0],
          asset: null,
          captionCues: [{ id: "one", startMs: 2000, endMs: 9500, text: "Corrected translation." }],
        } as StudioPackage["outputs"][number],
      ],
    },
    fetcher,
  });
  const request = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
  const reviewed = JSON.parse(request.contents[0].parts[0].text).outputs[0];
  expect(reviewed.selectedClip).toMatchObject({ startMs: 2000, endMs: 9500, durationMs: 7500 });
  expect(reviewed.captions).toEqual([{ id: "one", text: "Corrected translation." }]);
});
