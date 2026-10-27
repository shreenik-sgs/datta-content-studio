import { afterEach, expect, it, vi } from "vitest";
import { value } from "../app/studio-workflow-fixture";
import type { StudioDetail } from "./studio-model";
import {
  type SeriesRow,
  prepareSeriesRows,
  runSeriesAction,
  seriesRequest,
} from "./studio-series-actions";
const detail: StudioDetail = {
  package: value,
  publications: [],
  blockers: [],
  readiness: {
    isTest: true,
    generation: {
      available: true,
      transcription: "test",
      intelligence: "test",
      translation: true,
      reason: null,
    },
    channels: [],
  },
};
const output = value.outputs[0];
if (!output) throw Error("MISSING_OUTPUT");
const row: SeriesRow = {
  id: output.id,
  outputId: output.id,
  detail,
  title: value.source.title,
  count: 1,
};
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
afterEach(() => vi.unstubAllGlobals());

it("shows the server's fresh contributor-role blocker before posting without creating a job", async () => {
  const pkg = { ...value, status: "APPROVED" as const };
  const fetcher = vi.fn(async (url: string) =>
    response(
      url.includes("publication-preflight")
        ? {
            blocker: "REQUESTER_ROLE_REVOKED",
            operator: {
              id: "op-1",
              displayName: "Studio Admin",
              roles: ["SUPER_ADMIN"],
              active: true,
            },
          }
        : { ...detail, package: pkg },
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  const rows = await prepareSeriesRows([pkg], "post");
  expect(rows[0]?.blocker).toContain("Admin must review");
  expect(rows[0]?.blocker).toContain("Account concerned: Studio Admin (Admin)");
  expect(fetcher.mock.calls.some(([url]) => url.includes("publication-preflight?revision="))).toBe(
    true,
  );
  expect(
    fetcher.mock.calls.every((args) => !(args as unknown as [string, RequestInit])[1]?.method),
  ).toBe(true);
});

it("prepares all 49 recordings using reads only, ignoring excluded/empty or already submitted packages", async () => {
  const packages = Array.from({ length: 49 }, (_, i) => ({ ...value, id: `p-${i}` }));
  const fetcher = vi.fn(async (_url: string) => response(detail));
  vi.stubGlobal("fetch", fetcher);
  const progress = vi.fn();
  const prepared = await prepareSeriesRows(
    [...packages, { ...value, outputs: [] }, { ...value, status: "IN_REVIEW" }],
    "submit",
    progress,
  );
  expect(prepared).toHaveLength(49);
  expect(fetcher).toHaveBeenCalledTimes(49);
  expect(
    fetcher.mock.calls.every((args) => !(args as unknown as [string, RequestInit])[1]?.method),
  ).toBe(true);
  expect(fetcher.mock.calls.every((args) => String(args[0]).endsWith("?view=action"))).toBe(true);
  expect(progress).toHaveBeenLastCalledWith(49, 49);
});
it("recovers a transient preflight read without retrying authorization failures", async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("connection interrupted"))
    .mockResolvedValueOnce(response(detail))
    .mockResolvedValueOnce(response({ error: "FORBIDDEN" }, 403));
  vi.stubGlobal("fetch", fetcher);
  expect(await seriesRequest("/read")).toEqual(detail);
  await expect(seriesRequest("/read")).rejects.toThrow("FORBIDDEN");
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it("retries a temporary gateway read once but fails closed if it still cannot load", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response("Unavailable", { status: 502 }))
    .mockRejectedValueOnce(new TypeError("connection interrupted"));
  vi.stubGlobal("fetch", fetcher);
  await expect(prepareSeriesRows([value], "submit")).rejects.toThrow("STUDIO_SERIES_LOAD_FAILED");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls.every((args) => args[1]?.method !== "POST")).toBe(true);
});
it("does not offer draft approval and reports pending corrections before submission", async () => {
  const fetcher = vi.fn(async () =>
    response({
      ...detail,
      package: { ...value, outputs: [{ ...value.outputs[0], correction: { state: "pending" } }] },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  expect(await prepareSeriesRows([value], "approve")).toEqual([]);
  expect(fetcher).not.toHaveBeenCalled();
  expect((await prepareSeriesRows([value], "submit"))[0]?.blocker).toContain("correction");
});
it("queues only selected file IDs and explicit destination, preserving the package revision", async () => {
  const fetcher = vi.fn(async () =>
    response({
      publications: [{ outputId: output.id, packageRevision: 4, status: "QUEUED" }],
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const report = vi.fn();
  await runSeriesAction(
    "post",
    [{ ...row, id: "file-b", outputId: output.id }],
    { youtube: "chosen-account" },
    report,
  );
  expect(fetcher).toHaveBeenCalledOnce();
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url.endsWith(`/${value.id}/publish`)).toBe(true);
  expect(JSON.parse(String(init.body))).toEqual({
    expectedRevision: 4,
    outputIds: [output.id],
    accounts: { youtube: "chosen-account" },
  });
});
it("reports per-recording validation failures and continues other selected recordings", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(response({ error: "STUDIO_CORRECTIONS_PENDING" }, 409))
    .mockResolvedValueOnce(response({ package: value }));
  vi.stubGlobal("fetch", fetcher);
  const results: { ok: boolean }[] = [];
  await runSeriesAction(
    "submit",
    [row, { ...row, id: "other", detail: { ...detail, package: { ...value, id: "other" } } }],
    {},
    (r) => results.push(r),
  );
  expect(results.map((r) => r.ok)).toEqual([false, true]);
});
it("stops after an ambiguous network failure so unattempted recordings are not silently retried", async () => {
  const fetcher = vi.fn().mockRejectedValue(new Error("network"));
  vi.stubGlobal("fetch", fetcher);
  const report = vi.fn();
  await runSeriesAction(
    "submit",
    [row, { ...row, id: "other", detail: { ...detail, package: { ...value, id: "other" } } }],
    {},
    report,
  );
  expect(fetcher).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledOnce();
  expect(report.mock.calls[0]?.[0]).toMatchObject({ ok: false });
});
it("reports remote removal as pending, rather than claiming it deleted a YouTube video", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      response({
        results: [
          {
            publication: { id: "post-1", remoteUrl: "https://youtu.be/video" },
            result: "REMOVE_ON_CHANNEL",
          },
        ],
      }),
    ),
  );
  const report = vi.fn();
  await runSeriesAction(
    "retract",
    [{ ...row, id: "post-1", publication: { id: "post-1" } as never }],
    {},
    report,
  );
  expect(report.mock.calls[0]?.[0]).toMatchObject({
    ok: false,
    message: expect.stringContaining("Still published"),
  });
});
it("shows language assignment blockers before bulk approval and performs no mutation", async () => {
  const pkg = { ...value, status: "IN_REVIEW" as const };
  const blocker =
    "Your Approver account is not assigned to review Telugu. Ask an Admin to open Settings → Reviewer languages.";
  const fetcher = vi.fn(async (url: string) =>
    response(
      url.includes("/api/content/")
        ? { content: { state: "APPROVED" } }
        : { ...detail, package: pkg, reviewAssignment: { sourceLanguage: "te", blocker } },
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  const rows = await prepareSeriesRows([pkg], "approve");
  expect(rows[0]?.blocker).toBe(blocker);
  await expect(runSeriesAction("approve", rows, {}, vi.fn())).rejects.toThrow(
    "INVALID_STUDIO_OUTPUT_SELECTION",
  );
  expect(fetcher.mock.calls).toHaveLength(2);
});

it.each(["submit", "approve"] as const)(
  "%s sends only the selected Short within a recording",
  async (action) => {
    const fetcher = vi.fn(async () => response({ package: value }));
    vi.stubGlobal("fetch", fetcher);
    await runSeriesAction(action, [row], {}, vi.fn());
    expect(
      JSON.parse(String((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body)),
    ).toMatchObject({ outputIds: [output.id] });
  },
);
it("preflights mixed file states and per-file blockers without blocking a ready sibling", async () => {
  const first = {
    ...output,
    id: "draft-one",
    workflow: { status: "DRAFT" as const, actorId: "curator", updatedAt: value.updatedAt },
  };
  const second = { ...first, id: "draft-two" };
  const pkg = {
    ...value,
    status: "IN_REVIEW" as const,
    outputs: [
      first,
      second,
      { ...first, id: "submitted", workflow: { ...first.workflow, status: "IN_REVIEW" as const } },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      response({
        ...detail,
        package: pkg,
        blockers: ["ASSETS_REQUIRE_REGENERATION"],
        outputBlockers: { [first.id]: [], [second.id]: ["ASSETS_REQUIRE_REGENERATION"] },
      }),
    ),
  );
  const rows = await prepareSeriesRows([pkg], "submit");
  expect(rows.map((r) => r.outputId)).toEqual([first.id, second.id]);
  expect(rows[0]?.blocker).toBeUndefined();
  expect(rows[1]?.blocker).toBeTruthy();
});
