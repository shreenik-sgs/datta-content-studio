// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ReviewerLanguages } from "./reviewer-languages";
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
it("shows saved assignments and submits only explicitly checked languages with confirmation", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const reviewer = {
    id: "r",
    displayName: "Content Approver",
    languages: ["en", "hi", "te", "kn", "ta"],
  };
  const fetcher = vi.fn(async () => Response.json({ reviewers: [reviewer] }));
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<ReviewerLanguages />));
    expect(host.textContent).toContain("Reviewer languages");
    expect(
      [...host.querySelectorAll<HTMLInputElement>('input[name="language"]:checked')].map(
        (i) => i.value,
      ),
    ).toEqual(reviewer.languages);
    const confirmed = host.querySelector<HTMLInputElement>('input[name="confirmed"]');
    expect(confirmed?.required).toBe(true);
    expect(confirmed?.checked).toBe(false);
    await act(async () => confirmed?.click());
    await act(async () =>
      host
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(
      JSON.parse((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body as string),
    ).toMatchObject({
      languages: reviewer.languages,
      expectedLanguages: reviewer.languages,
      confirmProficiency: true,
    });
    expect(host.textContent).toContain("Languages saved for Content Approver");
  } finally {
    await act(async () => root.unmount());
  }
});
