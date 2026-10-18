// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { StorageCleanup } from "./storage-cleanup";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
it.each([
  { blockers: [] as string[] },
  { blockers: ["Generation is active."] },
  { blockers: ["A Content Approver must delete approved content."] },
])("requires a preview and explicit confirmation; blockers=%s", async ({ blockers }) => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const data = JSON.parse(String(init.body));
    return Response.json(
      data.action === "preview"
        ? {
            preview: {
              title: "Fixture",
              token: "a".repeat(64),
              masterCount: 1,
              packageCount: 2,
              fileCount: 6,
              bytes: 1024 ** 3,
              sharedFileCount: 1,
              blockers,
            },
          }
        : { job: { id: "job" } },
    );
  });
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const click = async (label: string) =>
    act(async () => {
      [...host.querySelectorAll("button")].find((b) => b.textContent === label)?.click();
    });
  try {
    await act(async () => root.render(<StorageCleanup kind="master" id="fixture" />));
    await click("Delete master…");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1].body))).toMatchObject({
      action: "preview",
      selection: { kind: "master", id: "fixture", mode: "all" },
    });
    const deletion = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Permanently delete selected files",
    );
    expect(deletion).toBeDefined();
    expect(host.textContent).toContain("1.00 GB");
    expect(host.textContent).toContain("shared files");
    if (blockers.length) {
      expect(host.textContent).toContain(blockers[0]);
      expect(deletion?.disabled).toBe(true);
      expect(deletion?.getAttribute("aria-describedby")).toBeTruthy();
      expect(host.textContent).toContain("Check again");
      if (blockers[0]?.includes("Content Approver")) {
        expect(host.textContent).toContain("Content Approver required");
        expect(host.textContent).toContain("Sign in with a Content Approver account");
      } else expect(host.textContent).toContain("Deletion is blocked");
      await click("Permanently delete selected files");
      expect(fetcher).toHaveBeenCalledTimes(1);
    } else {
      expect(deletion?.disabled).toBe(false);
      await click("Permanently delete selected files");
      expect(host.textContent).toContain("Cleanup queued");
      expect(JSON.parse(String(fetcher.mock.calls[1]?.[1].body))).toMatchObject({
        action: "delete",
        confirmed: true,
        token: "a".repeat(64),
      });
    }
  } finally {
    await act(async () => root.unmount());
  }
});

it("refreshes the plan when changing scope and keeps deletion disabled if preview fails", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const { selection } = JSON.parse(String(init.body));
    return selection.mode === "all"
      ? Response.json({ error: "Unable to check storage. Try again." }, { status: 503 })
      : Response.json({
          preview: {
            title: "Draft package",
            token: "b".repeat(64),
            masterCount: 0,
            packageCount: 1,
            fileCount: 3,
            bytes: 1024,
            sharedFileCount: 0,
            blockers: [],
          },
        });
  });
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<StorageCleanup kind="master" id="fixture" />));
    await act(async () => host.querySelector("button")?.click());
    const deletion = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Permanently delete selected files",
    );
    expect(deletion?.disabled).toBe(true);
    expect(host.textContent).toContain("Unable to check storage");
    const select = host.querySelector("select");
    if (!select) throw Error("Missing cleanup scope");
    await act(async () => {
      select.value = "generated";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1].body))).toMatchObject({
      action: "preview",
      selection: { mode: "generated" },
    });
    expect(deletion?.disabled).toBe(false);
    expect(host.textContent).not.toContain("Unable to check storage");
  } finally {
    await act(async () => root.unmount());
  }
});
