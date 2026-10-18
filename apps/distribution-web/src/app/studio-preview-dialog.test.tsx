// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { StudioPreviewDialog } from "./studio-preview-dialog";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("keeps the preview open when Strict Mode delivers a stale native close event", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    if (!this.open) return;
    this.removeAttribute("open");
    queueMicrotask(() => this.dispatchEvent(new Event("close")));
  };
  const onClose = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <React.StrictMode>
        <StudioPreviewDialog onClose={onClose}>Preview</StudioPreviewDialog>
      </React.StrictMode>,
    ),
  );
  const dialog = container.querySelector("dialog");
  expect(dialog?.open).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => dialog?.close());
  expect(onClose).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});

it.each([false, true])(
  "restores preview focus without stealing a subsequent keyboard choice (%s)",
  async (moved) => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute("open");
    };
    const opener = document.createElement("button");
    const next = document.createElement("input");
    next.type = "checkbox";
    const container = document.createElement("div");
    document.body.append(opener, container, next);
    opener.focus();
    const root = createRoot(container);
    await act(async () =>
      root.render(<StudioPreviewDialog onClose={() => {}}>Preview</StudioPreviewDialog>),
    );
    container.querySelector("button")?.focus();
    await act(async () => root.unmount());
    if (moved) next.focus();
    for (const frame of frames) frame(0);
    expect(document.activeElement).toBe(moved ? next : opener);
  },
);
