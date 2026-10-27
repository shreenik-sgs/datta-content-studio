import type { OnlineImport } from "@satsang/distribution-domain";
// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SeriesWorkflow } from "./series-workflow";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
it("persists one confirmed workflow action, then reads server progress with no browser scheduling", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const send = vi.fn(async () => {});
  const item = {
    id: "bundle",
    curation: {
      request: { channels: ["youtube"], captions: true, allCompleteMessages: true },
      items: {},
    },
  } as OnlineImport;
  try {
    await act(async () =>
      root.render(<SeriesWorkflow item={item} canCurate busy={false} send={send} />),
    );
    expect(host.querySelector("button")?.disabled).toBe(true);
    await act(async () => host.querySelector<HTMLInputElement>("input")?.click());
    await act(async () => host.querySelector("button")?.click());
    expect(send).toHaveBeenCalledExactlyOnceWith({
      action: "series-workflow",
      id: "bundle",
      operation: "start",
      confirmed: true,
    });
    const at = "2026-10-27T00:00:00Z";
    if (!item.curation) throw Error("fixture");
    item.curation.workflow = {
      id: "workflow",
      version: 3,
      state: "running",
      phase: "stories",
      sourceIds: [],
      members: {},
      requestedBy: "curator",
      createdAt: at,
      updatedAt: at,
      history: [],
    };
    await act(async () =>
      root.render(<SeriesWorkflow item={item} canCurate={false} busy={false} send={send} />),
    );
    expect(host.textContent).toContain("Discovering and reviewing complete stories");
    expect(host.querySelector("button")).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
  }
});
