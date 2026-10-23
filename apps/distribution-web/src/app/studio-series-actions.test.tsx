// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PublicStudioPackage, StudioDetail } from "../lib/studio-model";
import { StudioSeriesActions } from "./studio-series-actions";
import { value } from "./studio-workflow-fixture";
const output = value.outputs[0];
if (!output) throw Error("MISSING_OUTPUT");
const response = (data: unknown) => new Response(JSON.stringify(data));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
async function render(
  packages: PublicStudioPackage[],
  role: "curator" | "approver",
  check: (host: HTMLElement, fetcher: ReturnType<typeof vi.fn>) => Promise<void>,
  selectedOutputIds: ReadonlySet<string> = new Set(
    packages.flatMap((p) => p.outputs.map((o) => o.id)),
  ),
  sourceState: "APPROVED" | "RIGHTS_CLEARED" = "APPROVED",
) {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST")
      return response({
        package: value,
        publications: [{ outputId: "file-two", packageRevision: 4, status: "QUEUED" }],
      });
    const pkg = packages.find((p) => url.endsWith(p.id)) ?? packages[0] ?? value;
    if (url.includes("/content/"))
      return response({ content: { id: pkg.source.masterId, state: sourceState } });
    return response({
      package: pkg,
      blockers: [],
      publications: [],
      readiness: {
        isTest: true,
        channels: [
          {
            channel: "youtube",
            accounts: [
              {
                id: "guru",
                label: "GuruBhavanamADPT",
                isDefault: true,
                channelUrl: "https://www.youtube.com/@gurubhavana",
                privacy: "private",
              },
            ],
          },
        ],
      },
    } as unknown as StudioDetail);
  });
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <StudioSeriesActions
        packages={packages}
        canCurate={role === "curator"}
        canReview={role === "approver"}
        canPublish={role === "approver"}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        selectedOutputIds={selectedOutputIds}
      />,
    ),
  );
  try {
    await check(host, fetcher);
  } finally {
    await act(async () => root.unmount());
  }
}
const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === text) as HTMLButtonElement;
async function chooseAction(host: HTMLElement, action: string) {
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="File action"]');
  if (!select) throw Error("Missing action selector");
  await act(async () => {
    select.value = action;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const posts = (fetcher: ReturnType<typeof vi.fn>) =>
  fetcher.mock.calls.filter((call) => call[1]?.method === "POST");
const checks = (host: HTMLElement) =>
  host.querySelectorAll<HTMLInputElement>('dialog input[type="checkbox"]');

it("has one selected action, no All shortcut or second selection list, and submits only selected recordings", async () => {
  const second = {
    ...value,
    id: "second",
    source: { ...value.source, title: "Day 2" },
    outputs: [{ ...output, id: "second-file" }],
  };
  await render(
    [value, second],
    "curator",
    async (host, fetcher) => {
      expect(button(host, "Submit All")).toBeUndefined();
      expect(button(host, "Approve Selected")).toBeUndefined();
      expect(host.querySelector("dialog")).toBeNull();
      await act(async () => button(host, "Submit Selected").click());
      expect(host.querySelector("dialog")?.open).toBe(true);
      expect(host.querySelector("table")).toBeNull();
      expect(host.textContent).not.toContain("Choose recordings");
      expect(checks(host)).toHaveLength(1); // acknowledgement only
      expect(host.textContent).toContain("1 file in 1 recordings ready");
      expect(posts(fetcher)).toHaveLength(0);
      expect(button(host, "Confirm submit · 1 files").disabled).toBe(true);
      await act(async () => checks(host)[0]?.click());
      await act(async () => button(host, "Confirm submit · 1 files").click());
      expect(posts(fetcher)).toHaveLength(1);
      expect(posts(fetcher)[0]?.[0]).toContain("/second/submit");
      expect(host.textContent).toContain("Submitted for Approver review");
    },
    new Set(["second-file"]),
  );
});

it("uses the exact table selection for posting and shows the target without adding sibling outputs", async () => {
  await render(
    [
      {
        ...value,
        status: "APPROVED",
        outputs: [...value.outputs, { ...output, id: "file-two", title: "Second" }],
      },
    ],
    "approver",
    async (host, fetcher) => {
      expect(button(host, "Post All")).toBeUndefined();
      await act(async () => button(host, "Post Selected").click());
      expect(host.textContent).toContain("1 file in 1 recordings ready");
      expect(checks(host)).toHaveLength(1);
      expect(host.textContent).toContain("https://www.youtube.com/@gurubhavana");
      expect(host.textContent).toContain("GuruBhavanamADPT");
      expect(posts(fetcher)).toHaveLength(0);
      await act(async () => checks(host)[0]?.click());
      await act(async () => button(host, "Confirm post · 1 files (test)").click());
      expect(JSON.parse(posts(fetcher)[0]?.[1].body)).toMatchObject({
        outputIds: ["file-two"],
        accounts: { youtube: "guru" },
      });
    },
    new Set(["file-two"]),
  );
});

it("requires table selection and cannot bypass Curator submission", async () => {
  await render(
    [value],
    "curator",
    async (host, fetcher) => {
      expect(button(host, "Submit Selected").disabled).toBe(true);
      expect(fetcher).not.toHaveBeenCalled();
    },
    new Set(),
  );
  await render([value], "approver", async (host, fetcher) => {
    expect(button(host, "Submit Selected")).toBeUndefined();
    expect(button(host, "Approve Selected").disabled).toBe(true);
    await chooseAction(host, "post");
    expect(button(host, "Post Selected").disabled).toBe(true);
    await chooseAction(host, "retract");
    expect(button(host, "Retract All")).toBeUndefined();
    await act(async () => button(host, "Retract Selected").click());
    expect(host.textContent).toContain("No posting requests exist in Studio");
    expect(posts(fetcher)).toHaveLength(0);
  });
});

it("approves submitted selections only after acknowledgement without posting", async () => {
  await render([{ ...value, status: "IN_REVIEW" }], "approver", async (host, fetcher) => {
    expect(button(host, "Approve All")).toBeUndefined();
    await act(async () => button(host, "Approve Selected").click());
    expect(posts(fetcher)).toHaveLength(0);
    expect(button(host, "Confirm approve · 1 files").disabled).toBe(true);
    await act(async () => checks(host)[0]?.click());
    await act(async () => button(host, "Confirm approve · 1 files").click());
    expect(posts(fetcher)).toHaveLength(1);
    expect(posts(fetcher)[0]?.[0]).toContain("/review");
    expect(JSON.parse(posts(fetcher)[0]?.[1].body)).toMatchObject({
      decision: "APPROVED",
      confirmTranscript: true,
      confirmTeachingIntegrity: true,
    });
    expect(host.textContent).toContain("posting is a separate action");
  });
});

it("cancel returns to the table; reopening requires fresh review and source-rights acknowledgements", async () => {
  await render(
    [{ ...value, status: "IN_REVIEW" }],
    "approver",
    async (host, fetcher) => {
      await act(async () => button(host, "Approve Selected").click());
      expect(checks(host)).toHaveLength(2);
      await act(async () => checks(host)[1]?.click());
      expect(button(host, "Confirm approve · 1 files").disabled).toBe(true);
      await act(async () => checks(host)[0]?.click());
      expect(button(host, "Confirm approve · 1 files").disabled).toBe(false);
      await act(async () => button(host, "Cancel").click());
      expect(host.querySelector("dialog")).toBeNull();
      await act(async () => button(host, "Approve Selected").click());
      expect([...checks(host)].every((c) => !c.checked)).toBe(true);
      expect(button(host, "Confirm approve · 1 files").disabled).toBe(true);
      expect(posts(fetcher)).toHaveLength(0);
    },
    undefined,
    "RIGHTS_CLEARED",
  );
});

it("reports an unavailable preflight and allows returning to the unchanged selection", async () => {
  await render([value], "curator", async (host, fetcher) => {
    fetcher.mockRejectedValueOnce(Error("offline"));
    await act(async () => button(host, "Submit Selected").click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("No action was taken");
    expect(host.querySelector("dialog .primary")).toBeNull();
    await act(async () => button(host, "Cancel").click());
    expect(button(host, "Submit Selected").disabled).toBe(false);
    expect(posts(fetcher)).toHaveLength(0);
  });
});

it("blocks a recording that changed after table selection instead of approving unseen edits", async () => {
  await render([{ ...value, status: "IN_REVIEW" }], "approver", async (host, fetcher) => {
    fetcher.mockResolvedValueOnce(
      response({
        package: { ...value, status: "IN_REVIEW", revision: value.revision + 1 },
        blockers: [],
        publications: [],
      }),
    );
    await act(async () => button(host, "Approve Selected").click());
    expect(host.textContent).toContain("This recording changed after selection");
    expect(button(host, "Confirm approve · 0 files").disabled).toBe(true);
    expect(posts(fetcher)).toHaveLength(0);
  });
});
