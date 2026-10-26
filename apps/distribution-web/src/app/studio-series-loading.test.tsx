// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { StudioPanel } from "./studio-panel";
import { value } from "./studio-workflow-fixture";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
const listing = {
  packages: [{ ...value, isTest: false }],
  publications: [],
  readiness: { isTest: false, generation: { available: true, translation: true }, channels: [] },
};
async function mount() {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <StudioPanel
        capabilities={["content.create"]}
        bundle={{
          title: "Saved series",
          playlistId: "series",
          masterIds: [value.source.masterId],
          packageIds: [value.id],
          totalRecordings: 51,
        }}
      />,
    ),
  );
  return { host, root };
}
it("does not turn an initial listing failure into zero files, queued sources, or test mode", async () => {
  const requests = vi
    .fn()
    .mockRejectedValueOnce(new Error("timeout"))
    .mockImplementation(async () => Response.json(listing));
  vi.stubGlobal("fetch", requests);
  const { host, root } = await mount();
  try {
    expect(host.textContent).toContain("Your files have not been removed");
    expect(host.textContent).not.toContain("0 files across 0 recordings");
    expect(host.textContent).not.toContain("51 waiting");
    expect(host.textContent).not.toContain("Test workspace");
    expect(host.querySelector('[aria-label="All bundle files"]')).toBeNull();
    const retry = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Refresh progress",
    );
    await act(async () => retry?.click());
    expect(host.querySelector('[aria-label="All bundle files"]')).not.toBeNull();
    expect(host.textContent).toContain("files across 1 recordings");
    expect(host.textContent).not.toContain("Test workspace");
  } finally {
    await act(async () => root.unmount());
  }
});
it("retains the last loaded series files when a background refresh fails", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(Response.json(listing))
      .mockRejectedValue(new Error("temporary network failure")),
  );
  const { host, root } = await mount();
  try {
    const before = host.querySelector(".series-files-heading")?.textContent;
    expect(before).toContain("files across 1 recordings");
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(host.textContent).toContain("Unable to refresh package progress");
    expect(host.querySelector(".series-files-heading")?.textContent).toBe(before);
    expect(host.textContent).not.toContain("Test workspace");
  } finally {
    await act(async () => root.unmount());
  }
});
