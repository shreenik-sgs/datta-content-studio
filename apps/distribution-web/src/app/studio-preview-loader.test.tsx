// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { StudioPreviewLoader } from "./studio-preview-loader";
import { value } from "./studio-workflow-fixture";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
async function mount() {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const loaded = vi.fn((pkg, output) => <span>{`${pkg.id}: ${output.title}`}</span>);
  await act(async () =>
    root.render(
      <StudioPreviewLoader
        packageId={value.id}
        outputId={value.outputs[0]?.id ?? "missing"}
        revision={value.revision}
      >
        {loaded}
      </StudioPreviewLoader>,
    ),
  );
  return { host, root, loaded };
}
it("loads complete file evidence on demand before showing a preview", async () => {
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const { host, root, loaded } = await mount();
  try {
    expect(host.textContent).toContain("Loading file and review details");
    expect(loaded).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledWith(
      `/distribution/api/studio/${value.id}`,
      expect.objectContaining({ cache: "no-store" }),
    );
    await act(async () => resolve(Response.json({ package: value })));
    expect(loaded).toHaveBeenCalledWith(value, value.outputs[0]);
    expect(host.textContent).toContain(value.outputs[0]?.title);
  } finally {
    await act(async () => root.unmount());
  }
});
it("keeps a failed preview retryable without accepting summary-only evidence", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(Response.json({ package: { ...value, summaryOnly: true } }))
      .mockResolvedValueOnce(Response.json({ package: value })),
  );
  const { host, root, loaded } = await mount();
  try {
    expect(host.textContent).toContain("Your file and edits are saved");
    expect(loaded).not.toHaveBeenCalled();
    await act(async () => host.querySelector("button")?.click());
    expect(loaded).toHaveBeenCalledWith(value, value.outputs[0]);
  } finally {
    await act(async () => root.unmount());
  }
});
it("aborts an outstanding read when the preview closes", async () => {
  const fetcher = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", fetcher);
  const { root } = await mount();
  const signal = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal;
  if (!signal) throw Error("Missing cancellation signal");
  expect(signal.aborted).toBe(false);
  await act(async () => root.unmount());
  expect(signal.aborted).toBe(true);
});
