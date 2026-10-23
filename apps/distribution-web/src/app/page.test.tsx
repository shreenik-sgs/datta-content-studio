// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw Error(`Redirect: ${path}`);
  }),
  library: vi.fn(() => null),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, notFound: vi.fn() }));
vi.mock("../lib/runtime", () => ({ access: mocks.access }));
vi.mock("../lib/auth", () => ({ trustedDistributionOrigin: () => "http://localhost:3070" }));
vi.mock("../lib/analytics-policy", () => ({ analyticsEnabled: async () => false }));
vi.mock("./content-library", () => ({ ContentLibrary: mocks.library }));
import DistributionHome from "./page";

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

function signedIn(capabilities: string[]) {
  mocks.access.mockResolvedValue({
    ok: true,
    identity: { locale: "en", displayName: "Studio operator" },
    capabilities,
  });
}

it("lands settings-only Admins in Settings even when an old bookmark selects curation", async () => {
  signedIn(["operations.manage", "analytics.view"]);
  await expect(
    DistributionHome({
      searchParams: Promise.resolve({
        view: "content",
        bundle: "87aac715-58c4-444c-913b-0780ab5106a6",
      }),
    }),
  ).rejects.toThrow("Redirect: /distribution/settings");
  expect(mocks.redirect).toHaveBeenCalledWith("/distribution/settings");
  expect(mocks.access).toHaveBeenCalledTimes(1);
});

it.each(["content.create", "content.review", "content.publish"])(
  "preserves the workspace for an Admin explicitly assigned %s",
  async (capability) => {
    const capabilities = ["operations.manage", capability];
    signedIn(capabilities);
    const result = await DistributionHome({ searchParams: Promise.resolve({ view: "studio" }) });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(result.type).toBe(mocks.library);
    expect(result.props.capabilities).toEqual(capabilities);
    expect(result.props.initialView).toBe("studio");
  },
);

it("does not redirect an unauthenticated visitor to restricted Settings", async () => {
  mocks.access.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
  const result = await DistributionHome({ searchParams: Promise.resolve({}) });
  expect(result.type).toBe("main");
  expect(mocks.redirect).not.toHaveBeenCalled();
});
