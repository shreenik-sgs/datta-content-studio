// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CurationSettings } from "./settings-panel";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
it("discovers a second YouTube account without replacing the first and saves an explicit default", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const settings = {
    revision: "a".repeat(64),
    visualPreference: "Scenic nature",
    appLinks: { web: "https://example.test" },
    maxMasterUploadMb: 1024,
    maxMasterUploadCapacityMb: 1024,
    isTest: true,
    writable: true,
    trustedMediaOrigins: [],
    runtime: { generationEnabled: true, publishingEnabled: false },
    accounts: [
      {
        id: "original-account",
        label: "Original channel",
        platform: "youtube",
        providerAccountId: "original-channel",
        isDefault: true,
        enabled: true,
        eligibilityVerified: true,
        hasToken: true,
        blocker: null,
      },
    ],
  };
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith("buffer-channels"))
      return Response.json({
        channels: [
          { id: "new-channel", label: "@DattaSannidhi", available: true },
          { id: "locked-channel", label: "Reconnect first", available: false },
        ],
      });
    if (options?.method === "POST") return Response.json({ ...settings, revision: "b".repeat(64) });
    return Response.json(settings);
  });
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function required<T>(element: T | null | undefined): T {
    if (!element) throw Error("Expected form control is missing");
    return element;
  }
  const button = (text: string) =>
    required([...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text)));
  const input = (name: string) =>
    required(host.querySelector<HTMLInputElement>(`input[name="${name}"]`));
  try {
    await act(async () => root.render(<CurationSettings />));
    await act(async () => button("YouTube & Shorts").click());
    expect(input("providerAccountId").readOnly).toBe(true);
    expect(input("accessToken").value).toBe("");
    expect(input("isDefault").disabled).toBe(true);
    await act(async () => button("Add another account").click());
    expect(input("providerAccountId").readOnly).toBe(false);
    expect(input("isDefault").checked).toBe(false);
    await act(async () => button("Find my YouTube channels").click());
    expect(host.textContent).toContain("Enter your Buffer API key above");
    expect(fetcher).toHaveBeenCalledTimes(1);
    input("accessToken").value = "synthetic-test-key";
    expect(input("accessToken").type).toBe("password");
    await act(async () => button("Find my YouTube channels").click());
    const select = required(
      [...host.querySelectorAll("select")].find((s) =>
        s.querySelector('option[value="new-channel"]'),
      ),
    );
    expect(
      select.querySelector<HTMLOptionElement>('option[value="locked-channel"]')?.disabled,
    ).toBe(true);
    await act(async () => {
      select.value = "new-channel";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(input("providerAccountId").value).toBe("new-channel");
    expect(input("label").value).toBe("@DattaSannidhi");
    await act(async () => input("isDefault").click());
    await act(async () => button("Save connection").click());
    const saved = JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body));
    expect(saved).toMatchObject({
      action: "account",
      expectedRevision: settings.revision,
      account: {
        label: "@DattaSannidhi",
        providerAccountId: "new-channel",
        isDefault: true,
        accessToken: "synthetic-test-key",
      },
    });
    expect(saved.account.id).toBeUndefined();
    expect(host.textContent).toContain("Settings saved");
    expect(host.textContent).not.toContain("synthetic-test-key");
  } finally {
    await act(async () => root.unmount());
  }
});
