import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  createTranscript: vi.fn(),
  reviewTranscript: vi.fn(),
}));
vi.mock("../../../../../lib/runtime", () => ({ access: mocks.access }));
vi.mock("../../../../../lib/editorial-runtime", () => ({ editorialRepository: () => mocks }));
import { POST } from "./route";
const id = "40919b6e-8c9c-45eb-b569-3e380a484ad5";
const context = { userId: "operator-id", isTest: true };
const request = (body: unknown) =>
  new Request("http://localhost:3070/api/editorial/room/transcript", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const params = (action: string) => ({ params: Promise.resolve({ id, action }) });
describe("DS-DIST-R2-REVIEW editorial endpoint boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.access.mockResolvedValue({ ok: true, context, repo: { get: vi.fn() } });
  });
  it("DS-DIST-R2-REVIEW an unauthorized request cannot create or review", async () => {
    mocks.access.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "sign_in_required" }, { status: 401 }),
    });
    expect((await POST(request({}), params("transcript"))).status).toBe(401);
    expect(mocks.createTranscript).not.toHaveBeenCalled();
  });
  it("DS-DIST-R2-SOURCE stale sources return a conflict", async () => {
    mocks.createTranscript.mockRejectedValue(new Error("SOURCE_VERSION_STALE"));
    const response = await POST(
      request({
        expectedSourceVersionId: id,
        language: "en",
        durationMs: 5000,
        segments: [
          {
            id: "one",
            startMs: 0,
            endMs: 5000,
            originalText: "Practice daily.",
            displayText: "Practice daily.",
          },
        ],
      }),
      params("transcript"),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "SOURCE_VERSION_STALE" });
  });
  it("DS-DIST-R2-REVIEW only an explicit human review command approves", async () => {
    mocks.reviewTranscript.mockResolvedValue({ id, review: { decision: "APPROVED" } });
    const response = await POST(
      request({ expectedRevision: 1, decision: "APPROVED" }),
      params("review"),
    );
    expect(response.status).toBe(200);
    expect(mocks.access).toHaveBeenCalledWith(expect.any(Request), "content.review");
    expect(mocks.reviewTranscript).toHaveBeenCalledWith(context, id, {
      expectedRevision: 1,
      decision: "APPROVED",
    });
    expect(
      (
        await POST(
          request({ expectedRevision: 1, decision: "APPROVED", reviewerId: "forged" }),
          params("review"),
        )
      ).status,
    ).toBe(400);
    expect(mocks.reviewTranscript).toHaveBeenCalledTimes(1);
  });
  it("DS-DIST-R2-PROVENANCE manual input cannot forge provider or approval provenance", async () => {
    const response = await POST(
      request({
        expectedSourceVersionId: id,
        language: "en",
        durationMs: 5000,
        segments: [
          {
            id: "one",
            startMs: 0,
            endMs: 5000,
            originalText: "Practice daily.",
            displayText: "Practice daily.",
          },
        ],
        review: { decision: "APPROVED" },
      }),
      params("transcript"),
    );
    expect(response.status).toBe(400);
    expect(mocks.createTranscript).not.toHaveBeenCalled();
  });
});
