import { generateKeyPairSync } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignedLinkCachePublisher, createSignedLinkCacheReader } from "./cache";
import { createLinkHandler, createLinkServer, linksRuntimeConfig } from "./service";
import { trackedFixture } from "./test-fixtures";
let root: string;
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  root = await mkdtemp(join(realpathSync(tmpdir()), "distribution-links-http-"));
  const key = generateKeyPairSync("ed25519");
  const privateKeyPem = key.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = key.publicKey.export({ type: "spki", format: "pem" }).toString();
  const publisher = createSignedLinkCachePublisher({ root, privateKeyPem, keyId: "test" });
  await publisher.publish(trackedFixture);
  const cache = createSignedLinkCacheReader({ root, publicKeys: { test: publicKeyPem } });
  let clock = trackedFixture.checkedAt;
  const handler = createLinkHandler({ enabled: true, stage: "TEST", cache, now: () => clock });
  return {
    publisher,
    cache,
    handler,
    setClock: (value: string) => {
      clock = value;
    },
  };
}
const url = `http://127.0.0.1:3071/outreach/${trackedFixture.token}`;
describe("DS-DIST-R4 public isolated resolver", () => {
  it("DS-DIST-R4-OFF opens nothing by default and enforces TEST gating for requests", async () => {
    expect(linksRuntimeConfig({})).toBeNull();
    expect(() =>
      linksRuntimeConfig({ DISTRIBUTION_LINKS_ENABLED: "true", DISTRIBUTION_LINKS_STAGE: "ON" }),
    ).toThrow("LOCAL_TEST_RESOLVER_ONLY");
    const cache = { read: vi.fn() };
    const handler = createLinkHandler({ enabled: false, stage: "TEST", cache });
    expect((await handler(new Request(url))).status).toBe(404);
    expect(cache.read).not.toHaveBeenCalled();
  });
  it("DS-DIST-R4-LANDING serves approved escaped text without network calls and redirects exact identity metadata", async () => {
    const f = await fixture();
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("NETWORK_FORBIDDEN"));
    const page = await f.handler(new Request(url));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Approved meditation");
    expect(html).toContain(`/outreach/${trackedFixture.token}/continue`);
    expect(html).not.toContain("<script");
    const next = await f.handler(new Request(`${url}/continue`));
    expect(next.status).toBe(302);
    expect(next.headers.get("location")).toBe("/practice/flute-meditation");
    expect(next.headers.get("X-Distribution-Requires-Identity")).toBe("1");
    expect(next.headers.get("X-Distribution-World")).toBe("TEST");
    expect(next.headers.get("X-Distribution-Language")).toBe("en");
    expect(next.headers.get("cache-control")).toBe("no-store");
    expect(network).not.toHaveBeenCalled();
    for (const path of [
      `${url}?next=https://evil.test`,
      `${url}/continue?url=https://evil.test`,
      url.replace(trackedFixture.token, "bad"),
    ])
      expect((await f.handler(new Request(path))).status).toBe(404);
  });
  it("DS-DIST-R4-FALLBACK works during Hub outage and after signed stop while anonymous destinations do not require login", async () => {
    const f = await fixture();
    f.setClock("2026-09-29T12:01:00.000Z");
    expect((await f.handler(new Request(`${url}/continue`))).headers.get("location")).toBe(
      "/practice/koti-parayana",
    );
    await f.publisher.publish({ ...trackedFixture, sequence: 2, status: "STOPPED" });
    f.setClock(trackedFixture.checkedAt);
    expect((await f.handler(new Request(`${url}/continue`))).headers.get("location")).toBe(
      "/practice/koti-parayana",
    );
    const alternate = {
      ...trackedFixture,
      token: "B".repeat(43),
      title: "<img src=x onerror=alert(1)>",
      cta: { ...trackedFixture.cta, destination: { path: "/community", requiresIdentity: false } },
    };
    await f.publisher.publish(alternate);
    const next = await f.handler(
      new Request(`${url.replace(trackedFixture.token, alternate.token)}/continue`),
    );
    expect(next.headers.get("X-Distribution-Requires-Identity")).toBe("0");
    const page = await (
      await f.handler(new Request(url.replace(trackedFixture.token, alternate.token)))
    ).text();
    expect(page).toContain("&lt;img");
    expect(page).not.toContain("<img");
  });
  it("DS-DIST-R4-CACHE cached loopback P95 is below 250ms without Hub, DB or providers", async () => {
    const f = await fixture();
    const server = createLinkServer(f.handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("TEST_SERVER_MISSING");
      const elapsed: number[] = [];
      for (let i = 0; i < 100; i++) {
        const before = performance.now();
        const response = await fetch(
          `http://127.0.0.1:${address.port}/outreach/${trackedFixture.token}/continue`,
          { redirect: "manual" },
        );
        expect(response.status).toBe(302);
        await response.arrayBuffer();
        elapsed.push(performance.now() - before);
      }
      elapsed.sort((a, b) => a - b);
      const p50 = elapsed[49] ?? Number.POSITIVE_INFINITY;
      const p95 = elapsed[94] ?? Number.POSITIVE_INFINITY;
      console.info(
        JSON.stringify({
          measurement: "DS-DIST-R4 local loopback cache",
          samples: 100,
          p50Ms: Number(p50.toFixed(2)),
          p95Ms: Number(p95.toFixed(2)),
          includes: "HTTP, private file read, Ed25519 verification, response",
          excludes: "internet latency and mobile landing",
        }),
      );
      await writeFile(
        join(realpathSync(tmpdir()), "distribution-links-latency.json"),
        JSON.stringify(
          {
            samples: 100,
            p50Ms: p50,
            p95Ms: p95,
            surface: "Local Mac loopback HTTP, filesystem + signature check",
            checkedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      expect(p95).toBeLessThanOrEqual(250);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
