import { readFile } from "node:fs/promises";
import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  access: vi.fn(),
  recoveryTarget: vi.fn(),
  attachOriginal: vi.fn(),
  writeFile: vi.fn(),
  removeUnreferenced: vi.fn(),
  importVerificationRequest: vi.fn(),
}));
vi.mock("./runtime", () => ({
  access: m.access,
  distributionPool: vi.fn(),
  privateAssets: () => ({ writeFile: m.writeFile, removeUnreferenced: m.removeUnreferenced }),
}));
vi.mock("./import-verification", () => ({
  importVerificationRequest: m.importVerificationRequest,
}));
vi.mock("@satsang/distribution-db", () => ({
  createOnlineImportRepository: () => m,
  createStudioRoleAuthority: vi.fn(),
  onlineImportTransactionRolledBack: () => false,
}));
import { POST as upload } from "../app/api/content/import/[id]/original/route";
import { POST as verification } from "../app/api/content/import/[id]/verification/route";
const id = "f7612b2d-54cf-4ffd-a8b4-b57821c61943";
const bundle = "f7612b2d-54cf-4ffd-a8b4-b57821c61944";
const ctx = { userId: "curator", isTest: true, roles: ["CONTENT_COORDINATOR"] };
const args = { params: Promise.resolve({ id }) };
const file = () =>
  new Request(`http://localhost/distribution/api/content/import/${id}/original?bundle=${bundle}`, {
    method: "POST",
    headers: { "Content-Type": "video/mp4", "X-Original-Filename": "Original.mp4" },
    body: new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109]),
  });
beforeEach(() => {
  vi.resetAllMocks();
  m.access.mockResolvedValue({ ok: true, context: ctx });
  m.recoveryTarget.mockResolvedValue({ root: { id: bundle, childIds: [id] } });
  m.writeFile.mockImplementation(async (input) => {
    expect((await readFile(input.path)).length).toBe(12);
    return { storageKey: "private" };
  });
  m.attachOriginal.mockResolvedValue({ masterId: "master", duplicate: false });
  m.removeUnreferenced.mockResolvedValue(undefined);
});
it("streams an original to storage then attaches inside the authenticated playlist, even without a download worker", async () => {
  const response = await upload(file(), args);
  expect(response.status).toBe(201);
  expect(m.access).toHaveBeenCalledTimes(2);
  expect(m.attachOriginal).toHaveBeenCalledWith(ctx, bundle, id, {
    asset: { storageKey: "private" },
    title: "Original",
  });
  expect(m.removeUnreferenced).not.toHaveBeenCalled();
});
it("refuses approvers, cross-bundle files and revoked sessions before saving", async () => {
  m.access.mockResolvedValueOnce({ ok: false, response: Response.json({}, { status: 403 }) });
  expect((await upload(file(), args)).status).toBe(403);
  m.recoveryTarget.mockResolvedValueOnce({ root: { id: bundle, childIds: [] } });
  expect((await upload(file(), args)).status).toBe(409);
  m.access
    .mockResolvedValueOnce({ ok: true, context: ctx })
    .mockResolvedValueOnce({ ok: false, response: Response.json({}, { status: 403 }) });
  expect((await upload(file(), args)).status).toBe(403);
  expect(m.writeFile).not.toHaveBeenCalled();
});
it("cleans a duplicate asset but retains bytes after an uncertain commit", async () => {
  m.attachOriginal.mockResolvedValueOnce({ masterId: "master", duplicate: true });
  expect((await upload(file(), args)).status).toBe(201);
  expect(m.removeUnreferenced).toHaveBeenCalledOnce();
  m.removeUnreferenced.mockClear();
  m.attachOriginal.mockRejectedValueOnce(Error("connection lost after COMMIT"));
  expect((await upload(file(), args)).status).toBe(503);
  expect(m.removeUnreferenced).not.toHaveBeenCalled();
});
it("forwards only validated actions and server identity to verification", async () => {
  const request = (body: unknown) =>
    new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  expect(
    (await verification(request({ action: "start", userId: "other", isTest: false }), args)).status,
  ).toBe(400);
  expect(m.importVerificationRequest).not.toHaveBeenCalled();
  m.importVerificationRequest.mockResolvedValueOnce({ status: "OPEN" });
  expect((await verification(request({ action: "start" }), args)).status).toBe(200);
  expect(m.importVerificationRequest).toHaveBeenCalledWith(ctx, id, { action: "start" });
});
