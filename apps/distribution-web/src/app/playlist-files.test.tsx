// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PlaylistFiles } from "./playlist-files";
import { StudioPanel } from "./studio-panel";
import { value } from "./studio-workflow-fixture";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
function setup() {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  return { host, root: createRoot(host) };
}
const first = { ...value, id: "first", source: { ...value.source, title: "First recording" } };
const second = {
  ...value,
  id: "second",
  source: { ...value.source, masterId: "second-master", title: "Second recording" },
  outputs: value.outputs.map((output) => ({
    ...output,
    id: "second-output",
    channel: "facebook" as const,
    format: "reel" as const,
    title: "Second teaching",
    asset: output.asset ? { ...output.asset, filename: "second-facebook.mp4" } : null,
  })),
};

it("shows every recording's files immediately, filters by channel and previews without entering a workflow", async () => {
  const { host, root } = setup();
  const onPreview = vi.fn();
  const onOpen = vi.fn();
  try {
    await act(async () =>
      root.render(
        <PlaylistFiles packages={[first, second]} onPreview={onPreview} onOpen={onOpen} />,
      ),
    );
    expect(host.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(host.textContent).toContain("2 files across 2 recordings");
    expect(host.textContent).toContain("YouTube Shorts: 1");
    expect(host.textContent).toContain("Facebook: 1");
    const preview = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Preview second-facebook.mp4"]',
    );
    await act(async () => preview?.click());
    expect(onPreview).toHaveBeenCalledWith(second, "second-output");
    expect(onOpen).not.toHaveBeenCalled();
    const select = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Playlist file channel"]',
    );
    if (!select) throw Error("Missing channel filter");
    await act(async () => {
      select.value = "facebook";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(host.textContent).toContain("Second recording");
    expect(host.textContent).not.toContain("First recording");
  } finally {
    await act(async () => root.unmount());
  }
});

it.each([
  ["content.create"],
  ["content.review", "content.publish"],
  ["content.create", "content.review", "content.publish"],
] as const)(
  "opens the complete file list for roles %j, preserving one workflow only after an explicit choice",
  async (...roles) => {
    const { host, root } = setup();
    const readiness = {
      generation: { available: true, translation: true },
      publishing: { available: false },
      channels: [],
    };
    const old = {
      ...first,
      id: "old-curation",
      outputs: first.outputs.map((output) => ({
        ...output,
        id: "old-output",
        title: "Excluded earlier curation",
      })),
    };
    const requests = vi.fn(async (url: string, options?: RequestInit) => {
      expect(options?.method ?? "GET").toBe("GET");
      if (url.includes("?")) return Response.json({ packages: [second, old, first], readiness });
      if (url.endsWith("/history")) return Response.json({ history: [] });
      return Response.json({ package: second, readiness, publications: [], blockers: [] });
    });
    vi.stubGlobal("fetch", requests);
    try {
      await act(async () =>
        root.render(
          <StudioPanel
            capabilities={roles}
            bundle={{
              title: "Playlist",
              masterIds: [first.source.masterId, second.source.masterId],
              packageIds: [first.id, second.id],
            }}
          />,
        ),
      );
      expect(host.querySelectorAll("tbody tr")).toHaveLength(2);
      expect(host.querySelector('[aria-label="Content workflow"]')).toBeNull();
      expect(host.querySelector('[aria-label="Recording in bundle"]')).toBeNull();
      expect(host.textContent).not.toContain("Excluded earlier curation");
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Open workflow for Second recording"]',
          )
          ?.click(),
      );
      expect(host.querySelectorAll('[aria-label="Content workflow"]')).toHaveLength(1);
      expect(host.textContent).toContain("Recording 2 of 2");
      await act(async () =>
        [...host.querySelectorAll("button")]
          .find((button) => button.textContent === "All bundle files")
          ?.click(),
      );
      expect(host.querySelectorAll("tbody tr")).toHaveLength(2);
      expect(host.querySelector('[aria-label="Content workflow"]')).toBeNull();
      expect(requests.mock.calls.some(([url]) => url.endsWith("/old-curation"))).toBe(false);
    } finally {
      await act(async () => root.unmount());
    }
  },
);
