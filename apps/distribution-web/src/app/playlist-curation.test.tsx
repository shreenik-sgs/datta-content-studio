import type { OnlineImport } from "@satsang/distribution-domain";
// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PlaylistCuration } from "./playlist-curation";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
const parent: OnlineImport = {
  id: "playlist",
  source: {
    provider: "youtube",
    kind: "playlist",
    id: "PLfixture",
    url: "https://youtube.com/playlist?list=PLfixture",
  },
  title: "Sixteen teachings",
  status: "COMPLETE",
  masterId: null,
  parentId: null,
  childIds: Array.from({ length: 16 }, (_, i) => `child-${i}`),
  error: null,
  createdAt: "2026-10-13T00:00:00Z",
  updatedAt: "2026-10-13T00:00:00Z",
};
const items =
  parent.childIds?.map((id, i) => ({
    ...parent,
    id,
    parentId: parent.id,
    childIds: null,
    status: i === 0 ? ("COMPLETE" as const) : ("QUEUED" as const),
    masterId: i === 0 ? "master-0" : null,
    title: `Teaching ${i + 1}`,
    source: { ...parent.source, kind: "video" as const },
  })) ?? [];
async function mount(item = parent, children = items) {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("FormData", window.FormData);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const send = vi.fn().mockResolvedValue(undefined);
  const open = vi.fn();
  await act(async () =>
    root.render(
      <PlaylistCuration
        onReload={vi.fn()}
        item={item}
        items={children}
        busy={false}
        send={send}
        open={open}
      />,
    ),
  );
  return { host, root, send, open };
}
it("collects one confirmation for the whole playlist, with English captions and YouTube/Facebook defaults", async () => {
  const { host, root, send } = await mount();
  const form = host.querySelector("form");
  if (!form) throw Error("missing form");
  expect(host.textContent).toContain("Generate curated content for all 16 videos");
  const confirmation = form.elements.namedItem("confirmed") as HTMLInputElement;
  expect(confirmation.required).toBe(true);
  expect(form.checkValidity()).toBe(false);
  confirmation.checked = true;
  expect(form.checkValidity()).toBe(true);
  await act(async () =>
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0]?.[0]).toMatchObject({
    action: "curate-playlist",
    id: "playlist",
    confirmed: true,
    request: {
      languages: ["en"],
      channels: ["youtube", "facebook"],
      captions: true,
      allCompleteMessages: true,
    },
    rights: {
      privacyClass: "PUBLIC",
      territories: ["WORLDWIDE"],
      channels: ["youtube", "facebook"],
    },
  });
  await act(async () => root.unmount());
});
it("explains missing selections before submitting and retains other settings", async () => {
  const { host, root, send } = await mount();
  for (const input of host.querySelectorAll<HTMLInputElement>('input[name="language"]'))
    input.checked = false;
  await act(async () =>
    host
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(send).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Select at least one output language",
  );
  expect(host.querySelector('input[name="language"]')?.closest("details")?.open).toBe(true);
  expect(document.activeElement?.getAttribute("name")).toBe("language");
  expect((host.querySelector('input[name="captions"]') as HTMLInputElement).checked).toBe(true);
  await act(async () => root.unmount());
});

it("distinguishes a blocked download retry from manual CAPTCHA verification", async () => {
  const { host, root } = await mount({
    ...parent,
    serviceIssue: {
      provider: "youtube",
      code: "ONLINE_PROVIDER_VERIFICATION_REQUIRED",
      retryAt: null,
      attempts: 1,
    },
  });
  expect(host.textContent).toContain("Verify YouTube access");
  expect(host.textContent).toContain("Upload original recordings");
  expect(host.textContent).toContain("Generate curated content for all 16 videos");
  expect(host.textContent).not.toContain("Check cloud import access");
  await act(async () => root.unmount());
});
it("keeps per-video details collapsed and resumes the bundle without per-video retry buttons", async () => {
  const { host, root, send } = await mount({
    ...parent,
    curation: {
      requestedBy: "curator",
      confirmedAt: parent.createdAt,
      rights: {
        owner: "owner",
        authorizationBasis: "permission",
        privacyClass: "PUBLIC",
        territories: ["WORLDWIDE"],
        channels: ["youtube"],
        releaseAt: null,
        expiresAt: null,
      },
      request: { languages: ["en"], channels: ["youtube"], captions: true, instructions: "" },
      items: {
        "child-0": { packageId: "approved", status: "APPROVED", existing: true },
        "child-1": { error: "PLAYLIST_QUEUE_FAILED" },
      },
    },
  });
  expect(host.querySelector("form")).toBeNull();
  expect(host.querySelector("details")?.open).toBe(false);
  expect(host.textContent).not.toContain("Retry this download");
  expect(host.textContent).not.toContain("Retry this curation");
  expect(host.textContent).toContain("Existing curation preserved");
  expect(host.textContent).toContain("Waiting to download");
  expect(host.querySelector("progress")?.value).toBe(1);
  expect(host.querySelector("progress")?.max).toBe(16);
  const retry = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Retry unfinished videos",
  );
  await act(async () => retry?.click());
  expect(send).toHaveBeenCalledWith({
    action: "resume-playlist",
    id: "playlist",
  });
  await act(async () => root.unmount());
});

it("counts a no-excerpt assessment separately and does not offer an unchanged bundle retry", async () => {
  const { host, root } = await mount(
    {
      ...parent,
      curation: {
        requestedBy: "curator",
        confirmedAt: parent.createdAt,
        rights: {
          owner: "owner",
          authorizationBasis: "permission",
          privacyClass: "PUBLIC",
          territories: ["WORLDWIDE"],
          channels: ["youtube"],
          releaseAt: null,
          expiresAt: null,
        },
        request: { languages: ["en"], channels: ["youtube"], captions: true, instructions: "" },
        items: {
          "child-0": { packageId: "music", status: "FAILED", error: "STUDIO_NO_SUITABLE_CHANNELS" },
        },
      },
    },
    items.map((item) => ({ ...item, status: "COMPLETE", masterId: item.id })),
  );
  expect(host.textContent).toContain("No suitable excerpt found");
  expect(host.textContent).toContain("excluded from automatic retries");
  expect(host.textContent).not.toContain("Retry unfinished videos");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector("progress")?.value).toBe(0);
  await act(async () => root.unmount());
});

it("applies Gurubhavana branding and YouTube-only outputs to every series member", async () => {
  const { host, root, send } = await mount({
    ...parent,
    source: { ...parent.source, kind: "bundle" },
  });
  const select = host.querySelector<HTMLSelectElement>('select[name="sourceBranding"]');
  if (!select) throw Error("missing profile");
  await act(async () => {
    select.value = "bala-swamiji";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const form = host.querySelector("form");
  if (!form) throw Error("missing form");
  (form.elements.namedItem("confirmed") as HTMLInputElement).checked = true;
  expect(form.checkValidity()).toBe(true);
  await act(async () =>
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      request: expect.objectContaining({
        channels: ["youtube"],
        languages: ["en"],
        allCompleteMessages: true,
        sourceBranding: "bala-swamiji",
        youtubeClosing: {
          label: "Gurubhavana ADPT",
          url: "https://www.youtube.com/@gurubhavanaadpt",
        },
      }),
      rights: expect.objectContaining({
        channels: ["youtube"],
        owner: "Gurubhavana ADPT / Avadhoota Datta Peetham",
      }),
    }),
  );
  await act(async () => root.unmount());
});
