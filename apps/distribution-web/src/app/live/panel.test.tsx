// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { LiveCurationPanel } from "./panel";
vi.mock("../studio-panel", () => ({
  StudioPanel: ({ bundle }: { bundle: { packageIds: string[] } }) => (
    <div data-testid="bundle">{bundle.packageIds.join(",")}</div>
  ),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
const channel = {
  channelId: "UCaaaaaaaaaaaaaaaaaaaaaa",
  name: "Practices channel",
  handle: "@fixture",
  enabled: true,
};
const state = {
  available: true,
  channelError: null,
  channels: [channel],
  monitors: [],
  broadcasts: [],
};
async function mount(roles: string[], value = state) {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(value)),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<LiveCurationPanel capabilities={roles as never} />));
  return { host, root };
}
it("keeps the setup simple and requires explicit future-broadcast permission", async () => {
  const { host, root } = await mount(["content.create"]);
  try {
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "Set up monitoring")
        ?.click(),
    );
    expect(host.textContent).toContain("Practices channel");
    expect(host.querySelector('input[name="confirm"]')?.hasAttribute("required")).toBe(true);
    expect((host.querySelector('textarea[name="basis"]') as HTMLTextAreaElement).value).toBe("");
    expect(host.textContent).toContain("Each Short still needs human approval");
    expect(host.textContent).not.toContain("Publish now");
  } finally {
    await act(async () => root.unmount());
  }
});
it("disables starting when the capture worker heartbeat is unavailable", async () => {
  const { host, root } = await mount(["content.create"], { ...state, available: false });
  try {
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "Set up monitoring")
        ?.click(),
    );
    expect(
      [...host.querySelectorAll("button")].find((b) => b.textContent === "Start monitoring")
        ?.disabled,
    ).toBe(true);
    expect(host.textContent).toContain("not running");
  } finally {
    await act(async () => root.unmount());
  }
});
it("lets an approver open every section in a single broadcast bundle without setup controls", async () => {
  const value = {
    ...state,
    broadcasts: [
      {
        id: "broadcast",
        channelId: channel.channelId,
        videoId: "abcdefghijk",
        title: "Live program",
        status: "ENDED",
        capturedMs: 1200000,
        error: null,
        capturedFrom: null,
        windows: [
          { id: "a", masterId: "master-a", packageId: "package-a" },
          { id: "b", masterId: "master-b", packageId: "package-b" },
        ],
      },
    ],
  };
  const { host, root } = await mount(["content.review", "content.publish"], value as never);
  try {
    expect(host.textContent).not.toContain("Set up monitoring");
    await act(async () =>
      [...host.querySelectorAll("button")].find((b) => b.textContent === "Open broadcast")?.click(),
    );
    expect(host.querySelector('[data-testid="bundle"]')?.textContent).toBe("package-a,package-b");
    expect(host.textContent).toContain("Broadcast capture ended");
  } finally {
    await act(async () => root.unmount());
  }
});
