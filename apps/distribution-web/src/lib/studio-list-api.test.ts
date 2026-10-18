import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ access: vi.fn(), repo: vi.fn(), list: vi.fn(), readiness: vi.fn() }));
vi.mock("./runtime", () => ({ access: m.access }));
vi.mock("./studio-runtime", async (original) => ({
  ...(await original<typeof import("./studio-runtime")>()),
  studioRepository: m.repo,
  studioReadiness: m.readiness,
}));
import { GET } from "../app/api/studio/route";

const context = {
  userId: "coordinator@example.test",
  isTest: true,
  roles: ["CONTENT_COORDINATOR"],
};

describe("Studio package list withdrawal visibility", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m.access.mockResolvedValue({ ok: true, context });
    m.repo.mockReturnValue({ list: m.list });
    m.list.mockResolvedValue([]);
    m.readiness.mockResolvedValue({ channels: [] });
  });
  it.each([
    ["", false],
    ["?includeWithdrawn=false", false],
    ["?includeWithdrawn=true", true],
  ])(
    "passes explicit source visibility into the repository for %s",
    async (query, includeWithdrawn) => {
      const response = await GET(
        new Request(`http://localhost:3020/distribution/api/studio${query}`),
      );
      expect(response.status).toBe(200);
      expect(m.list).toHaveBeenCalledWith(context, { includeWithdrawn });
    },
  );
  it.each(["yes", "1", "TRUE", ""])("refuses invalid withdrawal visibility %s", async (value) => {
    const response = await GET(
      new Request(`http://localhost:3020/distribution/api/studio?includeWithdrawn=${value}`),
    );
    expect(response.status).toBe(400);
    expect(m.list).not.toHaveBeenCalled();
  });
  it("keeps source and status filters when inspecting withdrawn package history", async () => {
    const masterId = "11111111-1111-4111-8111-111111111111";
    expect(
      (
        await GET(
          new Request(
            `http://localhost:3020/distribution/api/studio?includeWithdrawn=true&masterId=${masterId}&status=DISCARDED`,
          ),
        )
      ).status,
    ).toBe(200);
    expect(m.list).toHaveBeenCalledWith(context, {
      masterId,
      status: "DISCARDED",
      includeWithdrawn: true,
    });
  });
});
