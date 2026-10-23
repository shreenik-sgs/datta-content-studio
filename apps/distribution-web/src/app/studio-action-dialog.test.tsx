// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { StudioActionDialog } from "./studio-action-dialog";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("keeps confirmation open in Strict Mode and ignores Escape while an action is in flight", async () => {
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
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (busy: boolean) => (
    <React.StrictMode>
      <StudioActionDialog
        title="Approve selected files"
        closeLabel="Cancel"
        busy={busy}
        onClose={onClose}
      >
        Summary
      </StudioActionDialog>
    </React.StrictMode>
  );
  await act(async () => root.render(render(true)));
  expect(host.querySelector("dialog")?.open).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
  expect(host.querySelector("button")?.disabled).toBe(true);
  await act(async () => {
    host.querySelector("dialog")?.dispatchEvent(new Event("cancel", { cancelable: true }));
  });
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => root.render(render(false)));
  await act(async () => {
    host.querySelector("dialog")?.dispatchEvent(new Event("cancel", { cancelable: true }));
  });
  expect(onClose).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
  expect(document.body.style.overflow).toBe("");
});

it("restores keyboard focus to the action button and preserves the underlying page scroll", async () => {
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
  const host = document.createElement("div");
  document.body.append(opener, host);
  opener.focus();
  const focus = vi.spyOn(opener, "focus");
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <StudioActionDialog
        title="Post selected files"
        closeLabel="Cancel"
        busy={false}
        onClose={() => {}}
      >
        Summary
      </StudioActionDialog>,
    ),
  );
  host.querySelector("button")?.focus();
  await act(async () => root.unmount());
  for (const frame of frames) frame(0);
  expect(document.activeElement).toBe(opener);
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
});
