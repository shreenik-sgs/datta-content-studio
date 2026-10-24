import type { PrivateAssetStore } from "@satsang/distribution-assets";
import type { createOnlineImportRepository } from "@satsang/distribution-db";
import { afterEach, expect, it, vi } from "vitest";
import {
  type VerificationBrowser,
  createImportVerificationManager,
  youtubeCookieJar,
} from "./import-verification-browser";
import type { downloadOnlineVideo } from "./online-video-download";
import {
  allowedVerificationHost,
  allowedVideoHost,
  publicVideoAddress,
} from "./online-video-network";
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
const ctx = { userId: "curator", isTest: true, roles: ["CONTENT_COORDINATOR"] };
function setup(fail = false) {
  let now = Date.now();
  let complete = false;
  const source = {
    provider: "youtube" as const,
    kind: "video" as const,
    id: "g0zlErdfXlg",
    url: "https://www.youtube.com/watch?v=g0zlErdfXlg",
  };
  const row = { id: "import", source, masterId: null };
  const repo = {
    recoveryTarget: vi.fn(async () => ({
      root: { ...row, masterId: complete ? "master" : null },
      target: row,
    })),
    claimVerification: vi.fn(async () => ({
      ...row,
      isTest: true,
      requestedBy: ctx.userId,
      language: "te",
      category: "pravachanams",
      leaseToken: "lease",
    })),
    list: vi.fn(async () => [row]),
    renew: vi.fn(),
    complete: vi.fn(async () => {
      complete = true;
      return { duplicate: false };
    }),
    fail: vi.fn(),
    retryPlaylist: vi.fn(),
  };
  const browser = {
    snapshot: vi.fn<VerificationBrowser["snapshot"]>(async () => ({
      image: "data:image/jpeg;base64,AA==",
      origin: "https://www.youtube.com",
    })),
    command: vi.fn(),
    credentials: vi.fn(async () => ({ cookies: "SECRET_COOKIES", userAgent: "Browser agent" })),
    close: vi.fn(async () => undefined),
  };
  const download = vi.fn(async (request: Parameters<typeof downloadOnlineVideo>[0]) => {
    if (fail) throw Error("ONLINE_PROVIDER_VERIFICATION_REQUIRED");
    await request.save?.({
      path: "/private/master.mp4",
      filename: "master.mp4",
      title: "Teaching",
    });
    return { kind: "video" as const };
  });
  const manager = createImportVerificationManager(
    {
      repository: repo as unknown as ReturnType<typeof createOnlineImportRepository>,
      store: {
        writeFile: vi.fn(async () => ({ storageKey: "master" })),
        removeUnreferenced: vi.fn(),
      } as unknown as PrivateAssetStore,
      isTest: true,
      env: {},
      signal: new AbortController().signal,
    },
    { open: vi.fn(async () => browser), download, clock: () => now },
  );
  closers.push(manager.close);
  return {
    manager,
    repo,
    browser,
    download,
    advance: () => {
      now += 16 * 60000;
    },
  };
}
it("only verifies after storing a real recording, then reuses credentials just for that bundle", async () => {
  const { manager, browser, download, repo } = setup();
  const opened = await manager.handle(ctx, "import", { action: "start" });
  expect(opened.status).toBe("OPEN");
  expect(download).not.toHaveBeenCalled();
  expect(
    await manager.handle(ctx, "import", { action: "check", sessionId: opened.sessionId }),
  ).toMatchObject({ status: "CHECKING" });
  let status = opened;
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    status = await manager.handle(ctx, "import", { action: "status", sessionId: opened.sessionId });
    if (status.status === "VERIFIED") break;
  }
  expect(status?.status).toBe("VERIFIED");
  expect(repo.complete).toHaveBeenCalledOnce();
  expect(browser.close).toHaveBeenCalledOnce();
  expect(JSON.stringify(status)).not.toContain("SECRET");
  const request = {
    source: {
      provider: "youtube" as const,
      kind: "video" as const,
      id: "g0zlErdfXlg",
      url: "https://www.youtube.com/watch?v=g0zlErdfXlg",
    },
    signal: new AbortController().signal,
    maxBytes: 1000,
  };
  await manager.download(request);
  expect(download.mock.lastCall?.[0]).toMatchObject({
    browserSession: { cookies: "SECRET_COOKIES" },
  });
  await manager.download({
    ...request,
    source: {
      ...request.source,
      id: "ABCDEFGHIJK",
      url: "https://www.youtube.com/watch?v=ABCDEFGHIJK",
    },
  });
  expect(download.mock.lastCall?.[0].browserSession).toBeUndefined();
});
it("failed access never reports verified or resumes the playlist", async () => {
  const { manager, repo } = setup(true);
  const opened = await manager.handle(ctx, "import", { action: "start" });
  await manager.handle(ctx, "import", { action: "check", sessionId: opened.sessionId });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(
    await manager.handle(ctx, "import", { action: "status", sessionId: opened.sessionId }),
  ).toMatchObject({ status: "FAILED", error: "VERIFICATION_FAILED" });
  expect(repo.complete).not.toHaveBeenCalled();
  expect(repo.retryPlaylist).not.toHaveBeenCalled();
});
it.each(["status", "check"] as const)(
  "stops a rejected Google sign-in on %s without reading credentials or attempting a download",
  async (action) => {
    const { manager, repo, browser, download } = setup();
    const opened = await manager.handle(ctx, "import", { action: "start" });
    browser.snapshot.mockResolvedValue({
      origin: "https://accounts.google.com",
      error: "VERIFICATION_SIGN_IN_BLOCKED",
    });
    const failed = await manager.handle(ctx, "import", { action, sessionId: opened.sessionId });
    expect(failed).toMatchObject({ status: "FAILED", error: "VERIFICATION_SIGN_IN_BLOCKED" });
    expect(failed.image).toBeUndefined();
    expect(failed.origin).toBeUndefined();
    expect(browser.close).toHaveBeenCalledOnce();
    await manager.handle(ctx, "import", { action: "check", sessionId: opened.sessionId });
    expect(browser.credentials).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(repo.claimVerification).not.toHaveBeenCalled();
    expect(repo.retryPlaylist).not.toHaveBeenCalled();
    expect(manager.paused()).toBe(false);
  },
);
it("isolates operators, imports, worlds, expired sessions and revocation", async () => {
  const { manager, repo, advance } = setup();
  const opened = await manager.handle(ctx, "import", { action: "start" });
  const status = { action: "status" as const, sessionId: opened.sessionId };
  await expect(manager.handle({ ...ctx, userId: "other" }, "import", status)).rejects.toThrow(
    "VERIFICATION_EXPIRED",
  );
  await expect(manager.handle(ctx, "other", status)).rejects.toThrow("VERIFICATION_EXPIRED");
  await expect(manager.handle({ ...ctx, isTest: false }, "import", status)).rejects.toThrow(
    "FORBIDDEN",
  );
  repo.recoveryTarget.mockRejectedValueOnce(Error("FORBIDDEN"));
  await expect(manager.handle(ctx, "import", status)).rejects.toThrow("FORBIDDEN");
  advance();
  await expect(manager.handle(ctx, "import", status)).rejects.toThrow("VERIFICATION_EXPIRED");
});
it("passes only YouTube cookies and rejects cookie file injection", () => {
  const cookie = {
    name: "SID",
    value: "secret",
    domain: ".youtube.com",
    path: "/",
    secure: true,
    httpOnly: true,
    expires: -1,
    sameSite: "Lax" as const,
  };
  expect(
    youtubeCookieJar([cookie, { ...cookie, domain: ".google.com", value: "GOOGLE_PRIVATE" }]),
  ).not.toContain("GOOGLE_PRIVATE");
  expect(youtubeCookieJar([cookie])).toContain(".youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsecret");
  expect(() => youtubeCookieJar([{ ...cookie, value: "a\nb" }])).toThrow("VERIFICATION_FAILED");
});
it("allows verification hosts only on its private browser proxy and never private IPs", () => {
  expect(allowedVerificationHost("accounts.google.com")).toBe(true);
  expect(allowedVideoHost("accounts.google.com")).toBe(false);
  expect(allowedVerificationHost("accounts.google.com.evil.test")).toBe(false);
  expect(allowedVerificationHost("169.254.169.254")).toBe(false);
  expect(publicVideoAddress("169.254.169.254")).toBe(false);
});
