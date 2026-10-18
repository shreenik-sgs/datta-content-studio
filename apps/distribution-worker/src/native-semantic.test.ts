import { INTEGRITY_CHECKS } from "@satsang/distribution-domain";
import { describe, expect, it, vi } from "vitest";
import { type NativeSemanticInput, createOpenAiNativeSemanticAdapter } from "./native-semantic";
const transcript: NativeSemanticInput["transcript"] = {
  id: "11111111-1111-4111-8111-111111111111",
  parentVersionId: null,
  number: 1,
  masterVersionId: "22222222-2222-4222-8222-222222222222",
  sourceSha256: "a".repeat(64),
  language: "te",
  revision: 2,
  durationMs: 5000,
  segments: [
    { id: "s", startMs: 0, endMs: 5000, originalText: "కృత్రిమ పరీక్ష", displayText: "కృత్రిమ పరీక్ష" },
  ],
  provenance: {
    provider: "manual",
    model: null,
    promptVersion: null,
    schemaVersion: 1,
    recipeVersion: "manual-v1",
  },
  review: {
    decision: "APPROVED",
    revision: 2,
    reviewerId: "local",
    reviewedAt: "2026-10-03T12:00:00Z",
  },
};
const input: NativeSemanticInput = {
  transcript,
  annotations: [
    {
      segmentId: "s",
      confidence: 0.7,
      speakerId: "fixture",
      speakerName: "Synthetic speaker",
      languageSpans: [{ startMs: 0, endMs: 5000, language: "te" }],
      words: [],
      englishShadow: null,
      uncertainty: ["Synthetic sample"],
    },
  ],
  glossary: [],
  privacyClass: "PUBLIC",
  authorizationBasis: "Synthetic contract test only",
  semanticShadow: true,
};
const result = {
  shadows: [{ segmentId: "s", englishShadow: "Synthetic test" }],
  teachings: [
    {
      id: "t",
      segmentIds: ["s"],
      kind: "conclusion",
      nativeSummary: "కృత్రిమ పరీక్ష",
      englishShadow: "Synthetic test",
      requiredContextIds: [],
    },
  ],
  candidates: [
    {
      id: "c",
      segmentIds: ["s"],
      startMs: 0,
      endMs: 5000,
      rationale: "Synthetic full segment",
      attributedSpeakerId: "fixture",
      checks: INTEGRITY_CHECKS.map((check) => ({
        check,
        status: "PASS",
        evidence: "Synthetic test",
        segmentIds: ["s"],
      })),
      scores: {
        fidelity: 1,
        selfContainment: 1,
        contextCompleteness: 1,
        significance: 1,
        clarity: 1,
        accessibility: 1,
        visualSuitability: 1,
        hook: 1,
      },
    },
  ],
};
const configured = (fetcher: typeof fetch) =>
  createOpenAiNativeSemanticAdapter({
    apiKey: "synthetic-only",
    model: "explicit-test-model",
    contractApproval: "test",
    retentionApproval: "test",
    fetcher,
  });
describe("native semantic provider contract (no live vendor calls)", () => {
  it("sends only bounded native source, disables storage, and preserves human review", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        status: "completed",
        output: [
          { type: "message", content: [{ type: "output_text", text: JSON.stringify(result) }] },
        ],
      }),
    );
    const out = await configured(fetcher).analyze(input, new AbortController().signal);
    const [url, request] = requiredValue(fetcher.mock.calls[0]);
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(request?.body as string);
    expect(body).toMatchObject({
      store: false,
      background: false,
      model: "explicit-test-model",
      text: { format: { strict: true, type: "json_schema" } },
    });
    expect(body.tools).toBeUndefined();
    expect(out.annotations[0]?.confidence).toBe(0.7);
    expect(out.candidates[0]?.checks.find((c) => c.check === "visual_audio")?.status).toBe(
      "REVIEW",
    );
    expect(out.provenance.provider).toBe("openai");
  });
  it("fails closed before network access for unapproved, private and oversized sources", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      configured(fetcher).analyze(
        { ...input, transcript: { ...transcript, review: null } },
        new AbortController().signal,
      ),
    ).rejects.toThrow("TRANSCRIPT_NOT_APPROVED");
    await expect(
      configured(fetcher).analyze(
        { ...input, privacyClass: "PRIVATE" as "PUBLIC" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("NATIVE_PUBLIC_SOURCE_REQUIRED");
    expect(fetcher).not.toHaveBeenCalled();
    expect(() =>
      createOpenAiNativeSemanticAdapter({
        apiKey: "",
        model: "test",
        contractApproval: "",
        retentionApproval: "",
      }),
    ).toThrow("NATIVE_PROVIDER_NOT_ADOPTED");
  });
  it("does not store incomplete, refusal or malformed provider output", async () => {
    for (const body of [
      { status: "incomplete" },
      { status: "completed", output: [{ type: "message", content: [{ type: "refusal" }] }] },
      {
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }],
      },
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
      await expect(
        configured(fetcher).analyze(input, new AbortController().signal),
      ).rejects.toThrow();
    }
  });
});

function requiredValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("REQUIRED_VALUE_MISSING");
  return value;
}
