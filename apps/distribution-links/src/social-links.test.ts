import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SOCIAL_PLACEMENTS,
  type SocialLinkReceipt,
  type TrackedLinkRecord,
} from "@satsang/distribution-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSocialEventOutbox } from "./event-outbox";
import { createLinkHandler, createLinkServer } from "./service";
import { trackedFixture } from "./test-fixtures";
let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
const record: TrackedLinkRecord = {
  ...trackedFixture,
  cta: {
    ...trackedFixture.cta,
    intent: "LEARN",
    destination: { path: `/content/room/${trackedFixture.contentId}`, requiresIdentity: true },
    fallback: { path: "/explore", requiresIdentity: false },
  },
  social: {
    channel: "instagram",
    promise: "FULL_DISCOURSE",
    canonicalId: `room:${trackedFixture.contentId}`,
    canonicalRevision: "v1",
    accessMode: "AUTH_REQUIRED",
    fallbackAccessMode: "PUBLIC",
    approvalPackageSha256: "a".repeat(64),
  },
};
const url = `http://localhost/s/${record.token}`;
function handler(value = record, events?: { enqueue(event: SocialLinkReceipt): Promise<void> }) {
  return createLinkHandler({
    enabled: true,
    stage: "TEST",
    socialLinksEnabled: true,
    cache: { read: async () => value },
    now: () => value.checkedAt,
    ...(events ? { events } : {}),
  });
}
function receipt(): SocialLinkReceipt {
  return {
    version: 1,
    isTest: true,
    id: randomUUID(),
    occurredAt: record.checkedAt,
    name: "tracked_link_resolved",
    activationId: record.activationId,
    campaignId: record.campaignId,
    contentId: record.contentId,
    derivativeId: record.derivativeId,
    ctaId: record.cta.id,
    channel: "instagram",
    canonicalId: `room:${record.contentId}`,
    fallbackReason: null,
  };
}
describe("DL01–08/DL15–17 universal social resolver", () => {
  it("preserves flag-OFF legacy behavior and refuses unapproved legacy records at /s", async () => {
    const cache = { read: vi.fn().mockResolvedValue(record) };
    const off = createLinkHandler({ enabled: true, stage: "TEST", cache });
    expect((await off(new Request(url))).status).toBe(404);
    expect(cache.read).not.toHaveBeenCalled();
    expect((await handler(trackedFixture)(new Request(url))).status).toBe(404);
  });
  it("redirects exact content for browsers and returns the same sanitized path for native clients across 17 placements", async () => {
    for (const channel of SOCIAL_PLACEMENTS) {
      const value = { ...record, social: { ...record.social, channel } } as TrackedLinkRecord;
      const browser = await handler(value)(new Request(url));
      expect(browser.status).toBe(302);
      expect(browser.headers.get("location")).toBe(record.cta.destination.path);
      const native = await handler(value)(
        new Request(url, { headers: { accept: "application/json" } }),
      );
      expect(await native.json()).toEqual({
        version: 1,
        isTest: true,
        attributionId: null,
        destination: record.cta.destination.path,
        requiresIdentity: true,
        accessMode: "AUTH_REQUIRED",
        usedFallback: false,
        fallbackReason: null,
        language: "en",
      });
    }
  });
  it("returns configured fallback and an explicit reason after withdrawal or expired validation", async () => {
    const stopped = await handler({ ...record, status: "STOPPED" })(
      new Request(url, { headers: { accept: "application/json" } }),
    );
    expect(await stopped.json()).toMatchObject({
      destination: "/explore",
      requiresIdentity: false,
      fallbackReason: "SOURCE_OR_ACTIVATION_WITHDRAWN",
    });
    const stale = createLinkHandler({
      enabled: true,
      stage: "TEST",
      socialLinksEnabled: true,
      cache: { read: async () => record },
      now: () => new Date(Date.parse(record.checkedAt) + 31000).toISOString(),
    });
    expect((await stale(new Request(url))).headers.get("X-Distribution-Fallback-Reason")).toBe(
      "VALIDATION_STALE",
    );
  });
  it("opens content even when attribution storage rejects or hangs and ignores HEAD for counts", async () => {
    const enqueue = vi.fn().mockRejectedValue(Error("disk unavailable"));
    expect(
      (
        await handler(record, { enqueue })(
          new Request(url, {
            headers: {
              cookie: "private",
              "user-agent": "private",
              referer: "https://private.test",
            },
          }),
        )
      ).status,
    ).toBe(302);
    const event = enqueue.mock.calls[0]?.[0];
    expect(JSON.stringify(event)).not.toMatch(/private|token|cookie|user-agent|referer|actorKey/);
    expect(event).toMatchObject({
      name: "tracked_link_resolved",
      canonicalId: `room:${record.contentId}`,
    });
    enqueue.mockClear();
    await handler(record, { enqueue })(new Request(url, { method: "HEAD" }));
    expect(enqueue).not.toHaveBeenCalled();
    enqueue.mockImplementation(() => new Promise(() => {}));
    const start = performance.now();
    expect((await handler(record, { enqueue })(new Request(url))).status).toBe(302);
    expect(performance.now() - start).toBeLessThan(250);
  });
  it("negotiates JSON through the real HTTP server and returns only a durably enqueued receipt ID", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const server = createLinkServer(handler(record, { enqueue }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw Error("address");
      const response = await fetch(`http://127.0.0.1:${address.port}/s/${record.token}`, {
        headers: { Accept: "application/json", Cookie: "secret", Referer: "https://private.test" },
        redirect: "manual",
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        attributionId: enqueue.mock.calls[0]?.[0].id,
        destination: record.cta.destination.path,
      });
      expect(JSON.stringify(enqueue.mock.calls[0]?.[0])).not.toMatch(
        /secret|private|cookie|referer/,
      );
      enqueue.mockRejectedValue(Error("disk"));
      const failed = await fetch(`http://127.0.0.1:${address.port}/s/${record.token}`, {
        headers: { Accept: "application/json" },
      });
      expect(((await failed.json()) as { attributionId: string | null }).attributionId).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("durably retries the same anonymous receipt after collector failure and process restart", async () => {
    root = await mkdtemp(join(realpathSync(tmpdir()), "social-event-outbox-"));
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    const options = {
      root,
      coreOrigin: "http://localhost:3020",
      key: "k".repeat(32),
      fetcher,
      now: () => Date.parse(record.checkedAt),
    };
    const first = createSocialEventOutbox(options);
    const event = receipt();
    await first.enqueue(event);
    await first.enqueue(event);
    expect((await readdir(root)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    expect(await first.drainOnce()).toEqual({ delivered: 0, pending: 1 });
    const stored = await readFile(join(root, `${event.id}.json`), "utf8");
    expect(JSON.parse(stored)).toEqual(event);
    const restarted = createSocialEventOutbox(options);
    fetcher.mockResolvedValue(new Response(null, { status: 204 }));
    expect(await restarted.drainOnce()).toEqual({ delivered: 1, pending: 0 });
    expect(fetcher.mock.calls.map((call) => JSON.parse(call[1].body).id)).toEqual([
      event.id,
      event.id,
    ]);
    expect(fetcher).toHaveBeenLastCalledWith(
      "http://localhost:3020/api/v1/content/events/internal",
      expect.objectContaining({ redirect: "error" }),
    );
    await expect(
      first.enqueue({ ...event, actorKey: "private" } as SocialLinkReceipt),
    ).rejects.toThrow();
    expect(() =>
      createSocialEventOutbox({ ...options, coreOrigin: "https://external.test" }),
    ).toThrow("LOCAL_CORE_REQUIRED");
  });
});
