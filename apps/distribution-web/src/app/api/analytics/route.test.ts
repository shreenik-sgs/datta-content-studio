import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  enabled: vi.fn(),
  dashboard: vi.fn(),
  ingest: vi.fn(),
  approvePolicy: vi.fn(),
  reconcile: vi.fn(),
  providerSnapshot: vi.fn(),
}));
vi.mock("../../../lib/runtime", () => ({ access: mocks.access }));
vi.mock("../../../lib/analytics-policy", () => ({ analyticsEnabled: mocks.enabled }));
vi.mock("../../../lib/analytics-runtime", () => ({ analyticsRepository: () => mocks }));
import { GET, POST } from "./route";
const ctx = { userId: "analytics@example.test", isTest: true };
const request = (input: unknown) =>
  new Request("http://localhost/distribution/api/analytics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue({ ok: true, context: ctx });
  mocks.enabled.mockResolvedValue(true);
  mocks.dashboard.mockResolvedValue({ snapshots: [] });
  mocks.ingest.mockResolvedValue({ inserted: 1, duplicates: 0 });
});
describe("analytics route release and authorization boundaries", () => {
  it("checks separate read and operations grants before repository access", async () => {
    expect((await GET(new Request("http://localhost"))).status).toBe(200);
    expect(mocks.access).toHaveBeenLastCalledWith(expect.any(Request), "analytics.view");
    await POST(
      request({
        action: "reconcile",
        campaignId: randomUUID(),
        windowStart: "2026-10-01T00:00:00Z",
        windowEnd: "2026-10-02T00:00:00Z",
      }),
    );
    expect(mocks.access).toHaveBeenLastCalledWith(expect.any(Request), "operations.manage");
    mocks.access.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "FORBIDDEN" }, { status: 403 }),
    });
    expect((await POST(request({ action: "ingest", events: [] }))).status).toBe(403);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
  it("refuses every operation while the core release flag is off", async () => {
    mocks.enabled.mockResolvedValue(false);
    expect((await GET(new Request("http://localhost"))).status).toBe(404);
    expect(
      (
        await POST(
          request({
            action: "approve_policy",
            requestId: randomUUID(),
            retentionDays: 30,
            approvalReference: randomUUID(),
          }),
        )
      ).status,
    ).toBe(404);
    expect(mocks.dashboard).not.toHaveBeenCalled();
    expect(mocks.approvePolicy).not.toHaveBeenCalled();
  });
  it("bounds a streamed body without trusting content-length", async () => {
    const response = await POST(
      new Request("http://localhost", { method: "POST", body: "x".repeat(1024 * 1024 + 1) }),
    );
    expect(response.status).toBe(413);
    expect(mocks.ingest).not.toHaveBeenCalled();
  });
  it("refuses free text and personal identifiers on fixture envelopes", async () => {
    const event = {
      version: 1,
      id: randomUUID(),
      name: "tracked_link.opened",
      occurredAt: new Date().toISOString(),
      correlationId: randomUUID(),
      actorKey: "a".repeat(64),
      campaignId: randomUUID(),
      activationId: null,
      contentId: null,
      ctaId: null,
      consentBasis: "explicit_consent",
      consentReceipt: randomUUID(),
      source: "operator_fixture",
      sourceEventId: randomUUID(),
      participationId: null,
    };
    expect(
      (
        await POST(
          request({ action: "ingest", events: [{ ...event, email: "fixture@example.test" }] }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await POST(request({ action: "ingest", events: [{ ...event, consentReceipt: null }] })))
        .status,
    ).toBe(400);
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect((await POST(request({ action: "ingest", events: [event] }))).status).toBe(200);
    expect(mocks.ingest).toHaveBeenCalledWith(ctx, [event]);
  });
  it("returns only a completion acknowledgement for privileged reconciliation", async () => {
    mocks.reconcile.mockResolvedValue({ sourceEvents: 1, unmatchedCompletions: 1 });
    const response = await POST(
      request({
        action: "reconcile",
        campaignId: randomUUID(),
        windowStart: "2026-10-01T00:00:00Z",
        windowEnd: "2026-10-02T00:00:00Z",
      }),
    );
    expect(await response.json()).toEqual({ ok: true });
  });
  it("does not leak database errors or session data", async () => {
    mocks.dashboard.mockRejectedValue(new Error("postgres://private-internal-secret"));
    const response = await GET(new Request("http://localhost"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
