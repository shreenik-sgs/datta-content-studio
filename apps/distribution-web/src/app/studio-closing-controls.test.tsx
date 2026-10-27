// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { StudioClosingControls } from "./studio-closing-controls";
import { value } from "./studio-workflow-fixture";

it("requires confirmation for the native closing job and never offers it for approved files", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onAction = vi.fn(async () => null);
  const target = {
    label: "Teaching channel",
    url: "https://www.youtube.com/@teaching",
    fullVideosUrl: "https://www.youtube.com/@originals",
  };
  const pkg = { ...value, request: { ...value.request, youtubeClosing: target } };
  try {
    await act(async () =>
      root.render(<StudioClosingControls value={pkg} busy={false} available onAction={onAction} />),
    );
    expect(host.querySelector("button")?.disabled).toBe(true);
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click());
    await act(async () =>
      host
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(onAction).toHaveBeenCalledExactlyOnceWith("verify-closings", {
      expectedRevision: value.revision,
      target,
    });
    await act(async () =>
      root.render(
        <StudioClosingControls
          value={{ ...pkg, status: "APPROVED" }}
          busy={false}
          available
          onAction={onAction}
        />,
      ),
    );
    expect(host.textContent).toBe("");
    expect(onAction).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
