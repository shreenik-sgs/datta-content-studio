import type { QuoteCandidate, TranscriptVersion } from "@satsang/distribution-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  get: vi.fn(),
  listTranscripts: vi.fn(),
  listQuotes: vi.fn(),
  listGlossary: vi.fn(),
}));
vi.mock("../../../../lib/runtime", () => ({ access: mocks.access }));
vi.mock("../../../../lib/editorial-runtime", () => ({ editorialRepository: () => mocks }));
import { GET } from "./route";
const id = "40919b6e-8c9c-45eb-b569-3e380a484ad5";
const context = { userId: "operator-id", isTest: true };
const review = {
  decision: "APPROVED" as const,
  reviewerId: "human-reviewer",
  reviewedAt: "2026-09-29T12:00:00Z",
  revision: 2,
};
const transcript: TranscriptVersion = {
  id: "transcript-1",
  parentVersionId: null,
  number: 1,
  masterVersionId: "source-version-1",
  sourceSha256: "a".repeat(64),
  language: "en",
  revision: 2,
  durationMs: 5000,
  segments: [
    {
      id: "s1",
      startMs: 0,
      endMs: 5000,
      originalText: "Practice with devotion.",
      displayText: "Practice with devotion.",
    },
  ],
  provenance: {
    provider: "manual",
    model: null,
    promptVersion: null,
    schemaVersion: 1,
    recipeVersion: "manual-1",
  },
  review,
};
const quote: QuoteCandidate = {
  id: "quote-1",
  kind: "EXACT_QUOTE",
  masterVersionId: transcript.masterVersionId,
  sourceSha256: transcript.sourceSha256,
  transcriptVersionId: transcript.id,
  transcriptRevision: 2,
  segmentIds: ["s1"],
  startMs: 0,
  endMs: 5000,
  text: "Practice with devotion.",
  revision: 2,
  review,
  provenance: transcript.provenance,
};
const run = () =>
  GET(new Request(`http://localhost:3070/distribution/api/editorial/${id}`), {
    params: Promise.resolve({ id }),
  });
describe("DS-DIST-R2-QUOTE current eligibility is separate from immutable historical review", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.access.mockResolvedValue({ ok: true, context, repo: { get: mocks.get } });
    mocks.get.mockResolvedValue({
      currentVersion: { id: transcript.masterVersionId },
      language: "en",
      state: "APPROVED",
    });
    mocks.listTranscripts.mockResolvedValue([transcript]);
    mocks.listQuotes.mockResolvedValue([quote]);
    mocks.listGlossary.mockResolvedValue([]);
  });
  it("DS-DIST-R2-REVIEW refuses unauthenticated reads before touching persistence", async () => {
    mocks.access.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "sign_in_required" }, { status: 401 }),
    });
    expect((await run()).status).toBe(401);
    expect(mocks.listTranscripts).not.toHaveBeenCalled();
  });
  it("DS-DIST-R2-QUOTE marks a current, human approved exact quote eligible", async () => {
    expect((await (await run()).json()).quoteEligibility[quote.id]).toEqual({ allowed: true });
  });
  it("DS-DIST-R2-QUOTE preserves past approval but marks corrected transcript quotes ineligible", async () => {
    mocks.listTranscripts.mockResolvedValue([
      transcript,
      {
        ...transcript,
        id: "transcript-2",
        parentVersionId: transcript.id,
        number: 2,
        revision: 1,
        review: null,
      },
    ]);
    const body = await (await run()).json();
    expect(body.quotes[0].review).toEqual(review);
    expect(body.quoteEligibility[quote.id]).toEqual({
      allowed: false,
      reason: "TRANSCRIPT_SUPERSEDED",
    });
  });
  it("DS-DIST-R2-QUOTE rejects historical approval after source replacement or withdrawal", async () => {
    mocks.get.mockResolvedValue({
      currentVersion: { id: "source-version-2" },
      language: "en",
      state: "DRAFT",
    });
    expect((await (await run()).json()).quoteEligibility[quote.id]).toEqual({
      allowed: false,
      reason: "SOURCE_VERSION_STALE",
    });
    mocks.get.mockResolvedValue({
      currentVersion: { id: transcript.masterVersionId },
      language: "en",
      state: "WITHDRAWN",
    });
    expect((await (await run()).json()).quoteEligibility[quote.id]).toEqual({
      allowed: false,
      reason: "CONTENT_WITHDRAWN",
    });
  });
});
