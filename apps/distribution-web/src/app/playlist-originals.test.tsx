import type { OnlineImport } from "@satsang/distribution-domain";
// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PlaylistOriginals } from "./playlist-originals";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
it("uploads a selected bundle sequentially, retains successful files and retries only failed originals", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const parent = {
    id: "bundle",
    source: { kind: "playlist" },
    childIds: ["one", "two"],
  } as OnlineImport;
  const items = ["one", "two"].map(
    (id, index) =>
      ({
        id,
        masterId: null,
        source: { kind: "video", provider: "youtube", id: index ? "ABCDEFGHIJK" : "g0zlErdfXlg" },
      }) as OnlineImport,
  );
  let fail = true;
  const fetcher = vi.fn(async (url: string) => {
    if (url.includes("/two/") && fail)
      return Response.json({ error: "unavailable" }, { status: 503 });
    return Response.json({ masterId: "saved" }, { status: 201 });
  });
  vi.stubGlobal("fetch", fetcher);
  const onSaved = vi.fn(async () => undefined);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(<PlaylistOriginals item={parent} items={items} onSaved={onSaved} />),
    );
    const input = host.querySelector('input[type="file"]');
    if (!input) throw Error("missing input");
    Object.defineProperty(input, "files", {
      value: [
        new File(["first"], "g0zlErdfXlg.mp4", { type: "video/mp4" }),
        new File(["second"], "ABCDEFGHIJK.mp4", { type: "video/mp4" }),
      ],
    });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect([...host.querySelectorAll("select")].map((select) => select.value)).toEqual([
      "one",
      "two",
    ]);
    await act(async () => host.querySelector("button")?.click());
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("1 recording(s) need another attempt");
    fail = false;
    await act(async () => host.querySelector("button")?.click());
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.lastCall?.[0]).toContain("/two/original?bundle=bundle");
    expect(onSaved).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
  }
});
