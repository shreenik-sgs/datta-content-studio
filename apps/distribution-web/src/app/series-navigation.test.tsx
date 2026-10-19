// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SeriesNavigation } from "./series-navigation";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
const id = "00000000-0000-4000-8000-000000000001";
function setup() {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  return { host, root: createRoot(host) };
}
it("links a single recording to its entire series and prevents leaving during an edit", async () => {
  const { host, root } = setup();
  const fetcher = vi.fn(async () =>
    Response.json({ bundles: [{ id, title: "Vishnu Purana", recordings: 51 }] }),
  );
  vi.stubGlobal("fetch", fetcher);
  try {
    await act(async () => root.render(<SeriesNavigation masterId="master-one" disabled={false} />));
    const link = host.querySelector<HTMLAnchorElement>("a");
    expect(link?.textContent).toBe("All series files");
    expect(link?.getAttribute("href")).toBe(`/distribution?view=studio&bundle=${id}`);
    expect(host.textContent).toContain("51 recordings");
    expect(fetcher).toHaveBeenCalledWith(
      "/distribution/api/content/import?masterId=master-one",
      expect.objectContaining({ cache: "no-store" }),
    );
    await act(async () => root.render(<SeriesNavigation masterId="master-one" disabled />));
    expect(link?.getAttribute("aria-disabled")).toBe("true");
    expect(link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))).toBe(
      false,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
  }
});
it("recovers a failed lookup, and does not carry another recording's series forward", async () => {
  const { host, root } = setup();
  let failed = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (failed) return new Response(null, { status: 503 });
      return Response.json({ bundles: [] });
    }),
  );
  try {
    await act(async () => root.render(<SeriesNavigation masterId="first" disabled={false} />));
    expect(host.textContent).toContain("Your recording is still available");
    failed = false;
    await act(async () => host.querySelector("button")?.click());
    expect(host.textContent).toBe("");
    await act(async () => root.render(<SeriesNavigation masterId="second" disabled={false} />));
    expect(host.querySelector("a")).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
