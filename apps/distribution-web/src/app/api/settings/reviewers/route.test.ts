import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn(), list: vi.fn(), save: vi.fn() }));
vi.mock("../../../../lib/runtime", () => ({ access: mocks.access, distributionPool: () => ({}) }));
vi.mock("@satsang/distribution-db", () => ({
  listStudioReviewers: mocks.list,
  saveStudioReviewerLanguages: mocks.save,
}));
import { GET, POST } from "./route";
const operatorId = "0620f5d9-c5fb-48f8-8d04-3146fa3051ea";
const request = (body: unknown) =>
  new Request("http://localhost:3070/distribution/api/settings/reviewers", {
    method: "POST",
    headers: { cookie: `dcs_session=${"a".repeat(64)}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const command = {
  operatorId,
  languages: ["en", "hi", "te", "kn", "ta"],
  expectedLanguages: [],
  confirmProficiency: true,
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.access.mockResolvedValue({ ok: true, context: { isTest: true, roles: ["SUPER_ADMIN"] } });
  mocks.list.mockResolvedValue([]);
});
it("refuses non-admin reads and writes", async () => {
  mocks.access.mockResolvedValue({
    ok: false,
    response: Response.json({ error: "FORBIDDEN" }, { status: 403 }),
  });
  expect((await GET(request({}))).status).toBe(403);
  expect((await POST(request(command))).status).toBe(403);
  expect(mocks.list).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});
it("requires explicit proficiency confirmation and accepts all five requested languages", async () => {
  expect((await POST(request({ ...command, confirmProficiency: false }))).status).toBe(400);
  expect(mocks.save).not.toHaveBeenCalled();
  expect((await POST(request(command))).status).toBe(200);
  expect(mocks.save).toHaveBeenCalledWith(
    {},
    expect.objectContaining({
      operatorId,
      languages: command.languages,
      isTest: true,
      sessionToken: "a".repeat(64),
    }),
  );
});
it("reports a concurrent assignment edit without overwriting it", async () => {
  mocks.save.mockRejectedValue(Error("REVIEWER_LANGUAGES_CHANGED"));
  expect((await POST(request(command))).status).toBe(409);
});
