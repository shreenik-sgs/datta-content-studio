import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  ready: vi.fn(),
  list: vi.fn(),
  configure: vi.fn(),
  retry: vi.fn(),
  retryPlaylist: vi.fn(),
  retryGeneration: vi.fn(),
}));
vi.mock("./runtime", () => ({ access: mocks.access, distributionPool: vi.fn() }));
vi.mock("@satsang/distribution-db", () => ({
  createStudioRoleAuthority: vi.fn(),
  createOnlineImportRepository: () => ({
    ready: mocks.ready,
    list: mocks.list,
    retryPlaylist: mocks.retryPlaylist,
  }),
  createIntelligentContentRepository: () => ({
    configurePlaylist: mocks.configure,
    retryPlaylistItem: mocks.retry,
    retryPlaylistGeneration: mocks.retryGeneration,
  }),
}));
import { POST } from "../app/api/content/import/route";
const id = "11111111-1111-4111-8111-111111111111";
const setup = {
  action: "curate-playlist",
  id,
  confirmed: true,
  rights: {
    owner: "Rights owner",
    authorizationBasis: "Owner permission for this playlist",
    territories: ["WORLDWIDE"],
    channels: ["youtube", "facebook"],
    privacyClass: "PUBLIC",
    releaseAt: null,
    expiresAt: null,
  },
  request: {
    languages: ["en"],
    channels: ["youtube", "facebook"],
    instructions: "Complete teachings",
    captions: true,
    allCompleteMessages: true,
  },
};
const send = (body: unknown) =>
  POST(
    new Request("http://local.test/distribution/api/content/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue({
    ok: true,
    context: { userId: "curator", isTest: true, roles: ["CONTENT_COORDINATOR"] },
  });
  mocks.ready.mockResolvedValue(true);
  mocks.list.mockResolvedValue([{ id }]);
});
it("saves one confirmed plan and enforces current Curator access at the API boundary", async () => {
  expect((await send(setup)).status).toBe(202);
  expect(mocks.access).toHaveBeenCalledWith(expect.any(Request), "content.create");
  expect(mocks.configure).toHaveBeenCalledWith(
    expect.objectContaining({ userId: "curator" }),
    id,
    setup,
  );
});
it("refuses unconfirmed or invalid shared settings without creating any packages", async () => {
  for (const input of [
    { ...setup, confirmed: false },
    { ...setup, request: { ...setup.request, languages: [] } },
    { ...setup, rights: { ...setup.rights, channels: [] } },
  ])
    expect((await send(input)).status).toBe(400);
  expect(mocks.configure).not.toHaveBeenCalled();
});
it("refuses Approver-only access before any queue or settings mutation", async () => {
  mocks.access.mockResolvedValue({
    ok: false,
    response: Response.json({ error: "FORBIDDEN" }, { status: 403 }),
  });
  expect((await send(setup)).status).toBe(403);
  expect(mocks.configure).not.toHaveBeenCalled();
  expect(mocks.ready).not.toHaveBeenCalled();
});
it("resumes imports and failed generation with one bundle action without creating new packages", async () => {
  expect((await send({ action: "resume-playlist", id })).status).toBe(202);
  expect(mocks.retryPlaylist).toHaveBeenCalledWith(
    expect.objectContaining({ userId: "curator" }),
    id,
  );
  expect(mocks.retryGeneration).toHaveBeenCalledWith(
    expect.objectContaining({ userId: "curator" }),
    id,
  );
  expect(mocks.configure).not.toHaveBeenCalled();
  expect(mocks.retry).not.toHaveBeenCalled();
});
