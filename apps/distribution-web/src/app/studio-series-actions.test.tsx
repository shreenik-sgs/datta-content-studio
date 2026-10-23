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
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
async function render(
  packages: PublicStudioPackage[],
  role: "curator" | "approver",
  check: (host: HTMLElement, fetcher: ReturnType<typeof vi.fn>) => Promise<void>,
  selectedOutputIds?: ReadonlySet<string>,
  sourceState: "APPROVED" | "RIGHTS_CLEARED" = "APPROVED",
) {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
        onPreview={vi.fn()}
        {...(selectedOutputIds ? { selectedOutputIds } : {})}
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
it("Curator can submit selected recordings only after explicit confirmation, with no approval controls", async () => {
  const second = { ...value, id: "second", source: { ...value.source, title: "Day 2" } };
  await render([value, second], "curator", async (host, fetcher) => {
    expect(button(host, "Approve All")).toBeUndefined();
    await act(async () => button(host, "Submit Selected").click());
    expect(posts(fetcher)).toHaveLength(0);
    const checks = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    await act(async () => checks[1]?.click());
    expect(host.textContent).toContain("1 files in 1 recordings selected");
    expect(button(host, "Confirm submit · 1 files").disabled).toBe(true);
    await act(async () => checks[2]?.click());
    await act(async () => button(host, "Confirm submit · 1 files").click());
    expect(posts(fetcher)).toHaveLength(1);
    expect(posts(fetcher)[0]?.[0]).toContain("/second/submit");
    expect(host.textContent).toContain("Submitted for Approver review");
  });
});

it("uses the table selection for posting without silently including other files", async () => {
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
      await act(async () => button(host, "Post Selected").click());
      expect(host.textContent).toContain("1 files in 1 recordings selected");
      expect(posts(fetcher)).toHaveLength(0);
      const checks = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      expect(checks[0]?.checked).toBe(false);
      expect(checks[1]?.checked).toBe(true);
      await act(async () => checks[checks.length - 1]?.click());
      await act(async () => button(host, "Confirm post · 1 files (test)").click());
      expect(JSON.parse(posts(fetcher)[0]?.[1].body).outputIds).toEqual(["file-two"]);
    },
    new Set(["file-two"]),
  );
});
it("Approver cannot bypass Curator submission, and empty retraction does not mutate drafts", async () => {
  await render([value], "approver", async (host, fetcher) => {
    expect(button(host, "Submit All")).toBeUndefined();
    expect(button(host, "Approve All").disabled).toBe(true);
    await chooseAction(host, "post");
    expect(button(host, "Post All").disabled).toBe(true);
    await chooseAction(host, "retract");
    await act(async () => button(host, "Retract All").click());
    expect(host.textContent).toContain("No posting requests exist in Studio");
    expect(posts(fetcher)).toHaveLength(0);
  });
});
it("Approver can approve a submitted series after review acknowledgement without automatically posting", async () => {
  await render([{ ...value, status: "IN_REVIEW" }], "approver", async (host, fetcher) => {
    await act(async () => button(host, "Approve All").click());
    expect(posts(fetcher)).toHaveLength(0);
    const checks = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(button(host, "Confirm approve · 1 files").disabled).toBe(true);
    await act(async () => checks[checks.length - 1]?.click());
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
it("requires a fresh source-rights acknowledgement when bulk approval selection expands or clears", async () => {
  const first = { ...value, status: "IN_REVIEW" as const };
  const second = {
    ...first,
    id: "second",
    source: { ...value.source, masterId: "second-master", title: "Day 2" },
  };
  await render(
    [first, second],
    "approver",
    async (host, fetcher) => {
      await act(async () => button(host, "Approve All").click());
      const acknowledgement = (text: string) => {
        const input = [...host.querySelectorAll("label")]
          .find((label) => label.textContent?.includes(text))
          ?.querySelector<HTMLInputElement>('input[type="checkbox"]');
        if (!input) throw Error(`Missing acknowledgement: ${text}`);
        return input;
      };
      const rights = () => acknowledgement("I reviewed the listed master permissions");
      const review = () => acknowledgement("I reviewed the native transcript");
      const rowChecks = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      await act(async () => rowChecks[1]?.click());
      await act(async () => {
        rights().click();
        review().click();
      });
      expect(button(host, "Confirm approve · 1 files").disabled).toBe(false);

      await act(async () => button(host, "Select all eligible").click());
      expect(rights().checked).toBe(false);
      expect(review().checked).toBe(false);
      expect(button(host, "Confirm approve · 2 files").disabled).toBe(true);
      await act(async () => review().click());
      expect(button(host, "Confirm approve · 2 files").disabled).toBe(true);
      await act(async () => rights().click());
      expect(button(host, "Confirm approve · 2 files").disabled).toBe(false);

      await act(async () => button(host, "Clear selection").click());
      await act(async () => button(host, "Select all eligible").click());
      expect(rights().checked).toBe(false);
      expect(review().checked).toBe(false);
      expect(button(host, "Confirm approve · 2 files").disabled).toBe(true);
      expect(posts(fetcher)).toHaveLength(0);
    },
    undefined,
    "RIGHTS_CLEARED",
  );
});
it("Post Selected identifies target account and needs confirmation for the exact file count", async () => {
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
      await act(async () => button(host, "Post Selected").click());
      const checks = host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      await act(async () => checks[1]?.click());
      expect(host.textContent).toContain("GuruBhavanamADPT");
      expect(host.textContent).toContain("https://www.youtube.com/@gurubhavana");
      expect(button(host, "Confirm post · 1 files (test)").disabled).toBe(true);
      await act(async () => checks[checks.length - 1]?.click());
      await act(async () => button(host, "Confirm post · 1 files (test)").click());
      const sent = posts(fetcher);
      expect(sent).toHaveLength(1);
      expect(JSON.parse(sent[0]?.[1].body)).toMatchObject({
        outputIds: ["file-two"],
        accounts: { youtube: "guru" },
      });
    },
  );
});
