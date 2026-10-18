// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { StudioSourceRecovery } from "./studio-source-recovery";
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
it("requires changed guidance and preserves channel, language and branding settings", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onAction = vi.fn().mockResolvedValue(null);
  const value = {
    revision: 4,
    request: {
      languages: ["en" as const],
      channels: ["youtube" as const],
      captions: true,
      allCompleteMessages: true,
      sourceBranding: "bala-swamiji" as const,
      instructions: "Find complete teachings.",
    },
  };
  try {
    await act(async () =>
      root.render(
        <StudioSourceRecovery value={value} busy={false} available onAction={onAction} />,
      ),
    );
    expect(host.querySelector("button")?.disabled).toBe(true);
    const textarea = host.querySelector("textarea");
    if (!textarea) throw Error("missing guidance");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        textarea,
        "Consider the complete explanation after the opening chant.",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelector("button")?.disabled).toBe(false);
    await act(async () =>
      host
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(onAction).toHaveBeenCalledWith("regenerate", {
      expectedRevision: 4,
      request: { ...value.request, instructions: textarea.value },
    });
  } finally {
    await act(async () => root.unmount());
  }
});
