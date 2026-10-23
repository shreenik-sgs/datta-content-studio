import { afterEach, expect, it, vi } from "vitest";
import { value } from "../app/studio-workflow-fixture";
import type { StudioDetail } from "./studio-model";
import { type SeriesRow, prepareSeriesRows, runSeriesAction } from "./studio-series-actions";
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
const row: SeriesRow = { id: value.id, detail, title: value.source.title, count: 1 };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
afterEach(() => vi.unstubAllGlobals());

it("prepares all 49 recordings using reads only, ignoring excluded/empty or already submitted packages", async () => {
  const packages = Array.from({ length: 49 }, (_, i) => ({ ...value, id: `p-${i}` }));
  const fetcher = vi.fn(async () => response(detail));
  vi.stubGlobal("fetch", fetcher);
  const prepared = await prepareSeriesRows(
    [...packages, { ...value, outputs: [] }, { ...value, status: "IN_REVIEW" }],
    "submit",
  );
  expect(prepared).toHaveLength(49);
  expect(fetcher).toHaveBeenCalledTimes(49);
  expect(
    fetcher.mock.calls.every((args) => !(args as unknown as [string, RequestInit])[1]?.method),
  ).toBe(true);
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
