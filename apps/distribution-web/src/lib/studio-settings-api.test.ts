import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_STUDIO_VISUAL_PREFERENCE } from "@satsang/distribution-domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn() }));
vi.mock("./runtime", () => ({ access: mocks.access }));
import { GET, POST } from "../app/api/settings/route";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hub-settings-api-"));
  const path = join(root, "test.json");
  await writeFile(path, JSON.stringify({ version: 1, accounts: [], trustedMediaOrigins: [] }), {
    mode: 0o600,
  });
  vi.stubEnv("STUDIO_CHANNEL_CONFIG_TEST_FILE", path);
  vi.stubEnv("STUDIO_CHANNEL_CONFIG_KEY", "ab".repeat(32));
  mocks.access.mockResolvedValue({ ok: true, context: { isTest: true } });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
const get = () => GET(new Request("http://localhost/distribution/api/settings"));
const post = (body: unknown) =>
  POST(
    new Request("http://localhost/distribution/api/settings", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
it("requires settings authority on reads and writes", async () => {
  mocks.access.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
  expect((await get()).status).toBe(403);
  expect((await post({})).status).toBe(403);
  expect(mocks.access).toHaveBeenLastCalledWith(expect.any(Request), "operations.manage");
});
it("remembers visual preferences across reads and unrelated changes without accepting stale edits", async () => {
  const initial = await (await get()).json();
  expect(initial.visualPreference).toBe(DEFAULT_STUDIO_VISUAL_PREFERENCE);
  const preference =
    "Sacred, serene nature: rivers, forests and mountains matched to the teaching.";
  const saved = await post({
    action: "visuals",
    expectedRevision: initial.revision,
    visualPreference: preference,
  });
  expect(saved.status).toBe(200);
  const state = await (await get()).json();
  expect(state.visualPreference).toBe(preference);
  expect(
    (
      await post({
        action: "visuals",
        expectedRevision: initial.revision,
        visualPreference: "stale",
      })
    ).status,
  ).toBe(409);
  expect(
    (await post({ action: "uploads", expectedRevision: state.revision, maxMasterUploadMb: 150 }))
      .status,
  ).toBe(200);
  const current = await (await get()).json();
  expect(current.visualPreference).toBe(preference);
  for (const visualPreference of ["", " ", "x".repeat(1001), "bad\u0000value"])
    expect(
      (await post({ action: "visuals", expectedRevision: current.revision, visualPreference }))
        .status,
    ).toBe(400);
  expect((await (await get()).json()).visualPreference).toBe(preference);
});
it("saves, redacts, retains blank secrets and disconnects an account", async () => {
  let state = await (await get()).json();
  const account = {
    platform: "x",
    providerAccountId: "ashrama-x",
    enabled: false,
    eligibilityVerified: false,
    accessToken: "synthetic-private-secret",
  };
  let response = await post({ action: "account", expectedRevision: state.revision, account });
  expect(response.status).toBe(200);
  state = await response.json();
  expect(JSON.stringify(state)).not.toContain("synthetic-private-secret");
  expect(state.accounts[0].hasToken).toBe(true);
  response = await post({
    action: "account",
    expectedRevision: state.revision,
    account: { ...account, accessToken: "" },
  });
  expect(response.status).toBe(200);
  state = await response.json();
  expect(state.accounts[0].hasToken).toBe(true);
  response = await post({ action: "disconnect", expectedRevision: state.revision, platform: "x" });
  expect(response.status).toBe(200);
  expect((await response.json()).accounts).toEqual([]);
});
it("cannot enable WhatsApp delivery merely by supplying a token", async () => {
  const state = await (await get()).json();
  const response = await post({
    action: "account",
    expectedRevision: state.revision,
    account: {
      platform: "whatsapp",
      providerAccountId: "1234567890",
      enabled: true,
      eligibilityVerified: true,
      accessToken: "synthetic-whatsapp-token",
    },
  });
  expect(response.status).toBe(400);
  expect((await response.json()).error).toBe("WHATSAPP_RECIPIENT_DELIVERY_NOT_CONFIGURED");
});
it("does not expose unknown legacy credential fields or defaults", async () => {
  await writeFile(
    join(root, "test.json"),
    JSON.stringify({
      version: 1,
      trustedMediaOrigins: [],
      accounts: [
        {
          id: "legacy-x",
          platform: "x",
          transport: "buffer",
          providerAccountId: "x-channel",
          world: "PRODUCTION",
          enabled: false,
          eligibilityVerified: false,
          accessToken: "synthetic-main-secret",
          futureCredential: "synthetic-extra-secret",
          defaults: { unexpectedCredential: "synthetic-nested-secret" },
        },
      ],
    }),
    { mode: 0o600 },
  );
  const response = await get();
  expect(response.status).toBe(200);
  const body = await response.text();
  for (const secret of [
    "synthetic-main-secret",
    "synthetic-extra-secret",
    "synthetic-nested-secret",
  ])
    expect(body).not.toContain(secret);
});
it("persists the admin upload limit, enforces capacity, and rejects stale saves", async () => {
  const initial = await (await get()).json();
  expect(initial.maxMasterUploadMb).toBe(250);
  const saved = await post({
    action: "uploads",
    expectedRevision: initial.revision,
    maxMasterUploadMb: 150,
  });
  expect(saved.status).toBe(200);
  expect((await (await get()).json()).maxMasterUploadMb).toBe(150);
  expect(
    (await post({ action: "uploads", expectedRevision: initial.revision, maxMasterUploadMb: 100 }))
      .status,
  ).toBe(409);
  const current = await (await get()).json();
  for (const maxMasterUploadMb of [0, 251, 2.5]) {
    expect(
      (await post({ action: "uploads", expectedRevision: current.revision, maxMasterUploadMb }))
        .status,
    ).toBe(400);
  }
  expect((await (await get()).json()).maxMasterUploadMb).toBe(150);
});

it("stores three app links, preserves them across other settings and permits empty store links", async () => {
  let state = await (await get()).json();
  expect(state.appLinks).toEqual({ web: "https://sgsdattasannidhi.org/" });
  const appLinks = {
    web: "https://sgsdattasannidhi.org/",
    ios: "https://apps.apple.com/app/id123",
    android: "",
  };
  expect(
    (await post({ action: "app-links", expectedRevision: state.revision, appLinks })).status,
  ).toBe(200);
  const outdated = state.revision;
  state = await (await get()).json();
  expect(state.appLinks).toEqual({ web: appLinks.web, ios: appLinks.ios });
  expect((await post({ action: "app-links", expectedRevision: outdated, appLinks })).status).toBe(
    409,
  );
  expect(
    (await post({ action: "uploads", expectedRevision: state.revision, maxMasterUploadMb: 250 }))
      .status,
  ).toBe(200);
  state = await (await get()).json();
  expect(state.appLinks.ios).toBe(appLinks.ios);
  expect(
    (
      await post({
        action: "app-links",
        expectedRevision: state.revision,
        appLinks: { ...appLinks, ios: "javascript:alert(1)" },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await post({
        action: "app-links",
        expectedRevision: state.revision,
        appLinks: { ...appLinks, ios: "" },
      })
    ).status,
  ).toBe(200);
  expect((await (await get()).json()).appLinks).toEqual({ web: appLinks.web });
});

it("keeps multiple YouTube accounts and their secrets separate with one default", async () => {
  let state = await (await get()).json();
  const first = {
    platform: "youtube",
    label: "@DattaSannidhi",
    providerAccountId: "channel-one",
    enabled: true,
    eligibilityVerified: true,
    accessToken: "synthetic-token-one",
    defaults: {
      youtube: { privacy: "private", madeForKids: false, isAiGenerated: false, categoryId: "27" },
    },
  };
  let response = await post({
    action: "account",
    expectedRevision: state.revision,
    account: first,
  });
  expect(response.status).toBe(200);
  state = await response.json();
  const firstId = state.accounts[0].id;
  expect(state.accounts[0]).toMatchObject({ label: "@DattaSannidhi", isDefault: true });
  response = await post({
    action: "account",
    expectedRevision: state.revision,
    account: {
      ...first,
      label: "Second YouTube channel",
      providerAccountId: "channel-two",
      accessToken: "synthetic-token-two",
    },
  });
  expect(response.status).toBe(200);
  state = await response.json();
  const secondId = state.accounts.find((a: { id: string }) => a.id !== firstId).id;
  expect(state.accounts).toHaveLength(2);
  expect(state.accounts.filter((a: { isDefault: boolean }) => a.isDefault)).toHaveLength(1);
  expect(state.accounts.find((a: { id: string }) => a.id === firstId).isDefault).toBe(true);
  response = await post({
    action: "account",
    expectedRevision: state.revision,
    account: { ...first, id: firstId, label: "Renamed first", accessToken: "" },
  });
  expect(response.status).toBe(200);
  state = await response.json();
  expect(state.accounts).toHaveLength(2);
  expect(JSON.stringify(state)).not.toContain("synthetic-token");
  response = await post({
    action: "default-account",
    expectedRevision: state.revision,
    accountId: secondId,
  });
  expect(response.status).toBe(200);
  state = await response.json();
  expect(state.accounts.find((a: { id: string }) => a.id === firstId).isDefault).toBe(false);
  expect(state.accounts.find((a: { id: string }) => a.id === secondId).isDefault).toBe(true);
  expect(
    (
      await post({
        action: "account",
        expectedRevision: state.revision,
        account: { ...first, id: firstId, providerAccountId: "new-target" },
      })
    ).status,
  ).toBe(400);
  expect(
    (await post({ action: "disconnect", expectedRevision: state.revision, platform: "youtube" }))
      .status,
  ).toBe(400);
  expect(
    (
      await post({
        action: "disconnect",
        expectedRevision: state.revision,
        platform: "youtube",
        accountId: secondId,
      })
    ).status,
  ).toBe(400);
  response = await post({
    action: "disconnect",
    expectedRevision: state.revision,
    platform: "youtube",
    accountId: firstId,
  });
  expect(response.status).toBe(200);
  state = await response.json();
  expect(state.accounts).toHaveLength(1);
  expect(state.accounts[0].id).toBe(secondId);
});

it("saves named YouTube targets without fabricated credentials and connects the same target later", async () => {
  let state = await (await get()).json();
  for (const [label, url] of [
    ["GuruBhavanamADPT", "https://www.youtube.com/@gurubhavana"],
    ["Another channel", "https://www.youtube.com/@another"],
  ]) {
    const response = await post({
      action: "youtube-target",
      expectedRevision: state.revision,
      label,
      url,
    });
    expect(response.status).toBe(200);
    state = await response.json();
  }
  expect(state.accounts).toHaveLength(2);
  const guru = state.accounts[0];
  expect(guru).toMatchObject({
    label: "GuruBhavanamADPT",
    channelUrl: "https://www.youtube.com/@gurubhavana",
    connectionPending: true,
    hasToken: false,
    providerAccountId: "",
    enabled: false,
    isDefault: true,
    blocker: "CHANNEL_NOT_CONNECTED",
  });
  expect(state.accounts[1].isDefault).toBe(false);
  expect(
    (
      await post({
        action: "youtube-target",
        expectedRevision: state.revision,
        label: "Duplicate",
        url: guru.channelUrl,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await post({
        action: "youtube-target",
        expectedRevision: state.revision,
        label: "Invalid",
        url: "javascript:alert(1)",
      })
    ).status,
  ).toBe(400);
  const account = {
    id: guru.id,
    platform: "youtube",
    label: guru.label,
    providerAccountId: "buffer-guru",
    enabled: false,
    eligibilityVerified: false,
    accessToken: "",
  };
  expect(
    (await post({ action: "account", expectedRevision: state.revision, account })).status,
  ).toBe(400);
  let response = await post({
    action: "account",
    expectedRevision: state.revision,
    account: { ...account, accessToken: "synthetic-guru-token" },
  });
  expect(response.status).toBe(200);
  state = await response.json();
  expect(state.accounts.find((a: { id: string }) => a.id === guru.id)).toMatchObject({
    id: guru.id,
    label: guru.label,
    channelUrl: guru.channelUrl,
    connectionPending: false,
    hasToken: true,
    isDefault: true,
    providerAccountId: "buffer-guru",
  });
  expect(JSON.stringify(state)).not.toContain("synthetic-guru-token");
  response = await post({
    action: "account",
    expectedRevision: state.revision,
    account: { ...account, providerAccountId: "wrong-channel", accessToken: "" },
  });
  expect(response.status).toBe(400);
  expect((await response.json()).error).toBe("ACCOUNT_DESTINATION_IMMUTABLE");
});
