import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreTopNavigation } from "../app/core-top-navigation";
import { type CoreNavigation, readCoreNavigation } from "./core-navigation";

const coreOrigin = "http://localhost:3020";
const cookie = "ds_session=11111111-1111-4111-8111-111111111111";
const request = () =>
  new Request(`${coreOrigin}/distribution`, {
    headers: { cookie: `private=hidden; ${cookie}`, "x-roles": "SUPER_ADMIN" },
  });
const icon = {
  viewBox: "0 0 1000 1000",
  transform: "translate(0 1000) scale(1 -1)",
  on: "M0 0L1 1Z",
  off: "M1 1L0 0Z",
} as const;
const navigation: CoreNavigation = {
  version: 1,
  locale: "en",
  label: "SGS Datta Sannidhi",
  tabs: [
    { key: "practices", href: "/home", label: "Practices", icon },
    { key: "content", href: "/distribution", label: "Content", icon },
    { key: "you", href: "/profile", label: "Profile", icon },
  ],
};
const fetchImpl = vi.fn<typeof fetch>();
const read = (overrides = {}) =>
  readCoreNavigation(request(), { coreOrigin, fetchImpl, ...overrides });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("React", React);
  fetchImpl.mockImplementation(async () => Response.json(navigation));
});
afterEach(() => vi.unstubAllGlobals());

describe("Hub navigation via the versioned core contract", () => {
  it("forwards only the opaque session to the configured core without caching or following redirects", async () => {
    expect(await read()).toEqual(navigation);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`${coreOrigin}/api/v1/navigation`);
    expect(init).toMatchObject({ method: "GET", cache: "no-store", redirect: "error" });
    const sent = new Headers(init?.headers);
    expect(sent.get("cookie")).toBe(cookie);
    expect(sent.get("x-roles")).toBeNull();
  });
  it("does not send credentials to untrusted origins or manufacture links from headers", async () => {
    expect(await read({ coreOrigin: "https://trusted.example.test/evil" })).toBeNull();
    expect(await readCoreNavigation(new Request(coreOrigin), { coreOrigin, fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("rejects unsupported contracts, non-core destinations and revoked sessions", async () => {
    for (const invalid of [
      { ...navigation, version: 2 },
      { ...navigation, tabs: [{ ...navigation.tabs[0], href: "//localhost" }] },
      { ...navigation, tabs: [{ ...navigation.tabs[0], href: "javascript:alert(1)" }] },
    ]) {
      fetchImpl.mockResolvedValueOnce(Response.json(invalid));
      expect(await read()).toBeNull();
    }
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect(await read()).toBeNull();
  });
  it("accepts a validated profile timezone while remaining compatible with older core contracts", async () => {
    expect((await read())?.timezone).toBeUndefined();
    fetchImpl.mockResolvedValueOnce(Response.json({ ...navigation, timezone: "Asia/Kolkata" }));
    expect((await read())?.timezone).toBe("Asia/Kolkata");
    fetchImpl.mockResolvedValueOnce(
      Response.json({ ...navigation, timezone: "Invalid/ProfileZone" }),
    );
    expect(await read()).toBeNull();
  });
  it("bounds a stalled core response so the Hub can still provide fallback navigation", async () => {
    const response = Response.json(navigation);
    vi.spyOn(response, "text").mockImplementationOnce(() => new Promise(() => {}));
    fetchImpl.mockResolvedValueOnce(response);
    expect(await read({ timeoutMs: 20 })).toBeNull();
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
  it("leaves the Hub basePath for core tabs and marks only Content as selected", () => {
    const html = renderToStaticMarkup(
      <CoreTopNavigation navigation={navigation} coreOrigin={coreOrigin} />,
    );
    expect(html).toContain(`href="${coreOrigin}/home"`);
    expect(html).toContain(`href="${coreOrigin}/profile"`);
    expect(html).toContain(`href="${coreOrigin}/distribution" aria-current="page"`);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).not.toContain("/distribution/home");
    expect(html).toContain('class="core-top-navigation"');
  });
  it("retains an escape to Home and Profile if the core navigation service is unavailable", () => {
    const html = renderToStaticMarkup(
      <CoreTopNavigation navigation={null} coreOrigin={coreOrigin} />,
    );
    expect(html).toContain(`href="${coreOrigin}/home"`);
    expect(html).toContain(`href="${coreOrigin}/profile"`);
  });
});
