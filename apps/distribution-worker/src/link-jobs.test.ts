import { describe, expect, it, vi } from "vitest";
import type { PersistedActivation, TrackedLinkRecord } from "./link-jobs";
import {
  createLocalDestinationChecker,
  linkJobConfig,
  runLinkDeliveryOnce,
  runLinkRefreshOnce,
} from "./link-jobs";
const activation = {
  id: "activation",
  pinnedCta: {
    destination: { path: "/practice/flute-meditation" },
    fallback: { path: "/practice/koti-parayana" },
  },
} as PersistedActivation;
const record = { status: "ACTIVE" } as TrackedLinkRecord;
describe("DS-DIST-R4 bounded local materializer", () => {
  it("DS-DIST-R4-OFF does not read signing configuration while disabled", () => {
    expect(linkJobConfig({})).toBeNull();
    expect(() =>
      linkJobConfig({
        DISTRIBUTION_LINK_JOBS_ENABLED: "true",
        STUDIO_DESTINATION_ORIGIN: "https://staging.example",
      }),
    ).toThrow();
  });
  it("DS-DIST-R4-AVAILABILITY calls only the authorized local core endpoint and refuses redirects or mismatched evidence", async () => {
    const checkedAt = new Date().toISOString();
    const paths = ["/practice/flute-meditation", "/practice/koti-parayana"];
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        version: 1,
        isTest: true,
        checkedAt,
        results: paths.map((path) => ({ path, available: true, requiresIdentity: true })),
      }),
    );
    const check = createLocalDestinationChecker({
      origin: "http://localhost:3020",
      key: "a".repeat(32),
      fetcher,
    });
    expect((await check(paths, new AbortController().signal)).results).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:3020/api/v1/destination-status",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: expect.objectContaining({ Authorization: `Bearer ${"a".repeat(32)}` }),
      }),
    );
    expect(() =>
      createLocalDestinationChecker({ origin: "https://remote.test", key: "secret", fetcher }),
    ).toThrow("LOCAL_CORE_REQUIRED");
    await expect(check(["https://evil.test"], new AbortController().signal)).rejects.toThrow();
    fetcher.mockResolvedValue(
      Response.json({
        version: 1,
        isTest: true,
        checkedAt,
        results: [{ path: "/community", available: true, requiresIdentity: true }],
      }),
    );
    await expect(check(paths, new AbortController().signal)).rejects.toThrow(
      "DESTINATION_UNAVAILABLE",
    );
  });
  it("DS-DIST-R4-OUTAGE skips failed availability checks rather than invalidating approval or reading source secrets", async () => {
    const repository = {
      refreshCandidates: vi.fn().mockResolvedValue([activation]),
      refresh: vi.fn(),
      deliverNext: vi.fn(),
    };
    const checkDestinations = vi.fn().mockRejectedValue(new Error("core offline"));
    expect(
      await runLinkRefreshOnce({
        repository,
        checkDestinations,
        signal: new AbortController().signal,
      }),
    ).toEqual({ refreshed: 0, unavailable: 1 });
    expect(repository.refresh).not.toHaveBeenCalled();
  });
  it("DS-DIST-R4-OUTBOX publishes only repository-selected records and cancellation opens no work", async () => {
    const publisher = { publish: vi.fn().mockResolvedValue(undefined) };
    const repository = {
      refreshCandidates: vi.fn(),
      refresh: vi.fn(),
      deliverNext: vi
        .fn()
        .mockImplementationOnce(async ({ publish }) => {
          await publish(record);
          return record;
        })
        .mockResolvedValue(null),
    };
    expect(
      await runLinkDeliveryOnce({ repository, publisher, signal: new AbortController().signal }),
    ).toBe(1);
    expect(publisher.publish).toHaveBeenCalledExactlyOnceWith(record);
    repository.deliverNext.mockClear();
    expect(await runLinkDeliveryOnce({ repository, publisher, signal: AbortSignal.abort() })).toBe(
      0,
    );
    expect(repository.deliverNext).not.toHaveBeenCalled();
  });
});
