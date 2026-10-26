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
async function mount(item = parent, children = items, canCurate = true) {
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
        canCurate={canCurate}
        onReload={vi.fn()}
        item={item}
        items={children}
        busy={false}
        send={send}
        open={open}
        onReview={vi.fn()}
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

it("keeps source ownership and uses the confirmed subscription channel for every series member", async () => {
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
  const facebook = host.querySelector<HTMLInputElement>('input[name="channel"][value="facebook"]');
  expect(facebook?.matches(":disabled")).toBe(false);
  expect(facebook?.checked).toBe(true);
  expect(facebook?.closest("details")?.open).toBe(true);
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
        channels: ["youtube", "facebook"],
        languages: ["en"],
        allCompleteMessages: true,
        sourceBranding: "bala-swamiji",
        youtubeClosing: {
          label: "Sri Datta Vijayananda Teertha Swamiji",
          url: "https://www.youtube.com/@sridattavijayam",
        },
      }),
      rights: expect.objectContaining({
        channels: ["youtube", "facebook"],
        owner: "Gurubhavana ADPT / Avadhoota Datta Peetham",
      }),
    }),
  );
  await act(async () => root.unmount());
});

it("uses the full bundle count while recording details are still loading", async () => {
  const item: OnlineImport = {
    ...parent,
    curation: {
      requestedBy: "curator",
      confirmedAt: parent.createdAt,
      rights: {
        owner: "owner",
        authorizationBasis: "permission",
        privacyClass: "PUBLIC" as const,
        territories: ["WORLDWIDE"],
        channels: ["youtube"],
        releaseAt: null,
        expiresAt: null,
      },
      request: {
        languages: ["en" as const],
        channels: ["youtube" as const],
        captions: true,
        instructions: "",
      },
      items: Object.fromEntries(
        (parent.childIds ?? []).map((id) => [id, { packageId: id, status: "DRAFT" as const }]),
      ),
    },
  };
  const { host, root } = await mount(item, items.slice(0, 2));
  expect(host.textContent).toContain("Checking download progress");
  expect(host.textContent).toContain("16 of 16 recordings in curation");
  expect(host.textContent).toContain("Progress for all 16 videos");
  expect(host.textContent).not.toContain("16 of 2");
  expect(host.querySelector("progress")?.max).toBe(16);
  await act(async () => root.unmount());
});

it("queues one section-discovery command for the whole bundle only for its curator", async () => {
  const item: OnlineImport = {
    ...parent,
    curation: {
      requestedBy: "curator",
      confirmedAt: parent.createdAt,
      rights: {
        owner: "Owner",
        authorizationBasis: "Permission",
        privacyClass: "PUBLIC",
        territories: ["WORLDWIDE"],
        channels: ["youtube"],
        releaseAt: null,
        expiresAt: null,
      },
      request: {
        channels: ["youtube"],
        languages: ["en"],
        captions: true,
        allCompleteMessages: true,
        instructions: "",
      },
      items: { "child-0": { packageId: "package", status: "DRAFT" } },
    },
  };
  const { host, root, send } = await mount(item);
  const button = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === "Find more Shorts across this bundle",
  );
  expect(button).toBeTruthy();
  await act(async () => button?.click());
  expect(send).toHaveBeenCalledWith({ action: "discover-playlist", id: parent.id });
  expect(host.textContent).toContain("existing files and edits stay intact");
  await act(async () => root.unmount());
  const approver = await mount(item, items, false);
  expect(approver.host.textContent).not.toContain("Find more Shorts across this bundle");
  await act(async () => approver.root.unmount());
  if (!item.curation) throw Error("missing fixture");
  item.curation.items["child-0"] = {
    packageId: "package",
    status: "GENERATING",
    outputCount: 2,
  };
  const updating = await mount(item);
  expect(updating.host.querySelector("progress")?.value).toBe(1);
  expect(updating.host.textContent).toContain("Existing files remain available while updates");
  const viewFiles = [...updating.host.querySelectorAll("button")].find(
    (b) => b.textContent === "Review curated content",
  );
  expect(viewFiles?.disabled).toBe(false);
  await act(async () => updating.root.unmount());
});

it("retains the curator's channel selections when the speaker changes and rejects an empty channel selection", async () => {
  const { host, root, send } = await mount();
  const facebook = host.querySelector<HTMLInputElement>('input[name="channel"][value="facebook"]');
  const instagram = host.querySelector<HTMLInputElement>(
    'input[name="channel"][value="instagram"]',
  );
  await act(async () => {
    facebook?.click();
    instagram?.click();
  });
  const select = host.querySelector<HTMLSelectElement>('select[name="sourceBranding"]');
  if (!select) throw Error("missing speaker");
  await act(async () => {
    select.value = "bala-swamiji";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(facebook?.checked).toBe(false);
  expect(instagram?.checked).toBe(true);
  for (const input of host.querySelectorAll<HTMLInputElement>('input[name="channel"]'))
    input.checked = false;
  await act(async () =>
    host
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(send).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Select at least one channel",
  );
  await act(async () => root.unmount());
});
it("lets the curator pause an unfinished bundle and resume selected channels with its saved settings", async () => {
  const item: OnlineImport = {
    ...parent,
    curation: {
      requestedBy: "curator",
      confirmedAt: parent.createdAt,
      rights: {
        owner: "Saved owner",
        authorizationBasis: "Saved permission",
        privacyClass: "PUBLIC",
        territories: ["WORLDWIDE"],
        channels: ["youtube"],
        releaseAt: null,
        expiresAt: null,
      },
      request: {
        languages: ["en"],
        channels: ["youtube"],
        captions: true,
        instructions: "Saved guidance",
        sourceBranding: "bala-swamiji",
        youtubeClosing: {
          label: "Gurubhavana ADPT",
          url: "https://www.youtube.com/@gurubhavanaadpt",
        },
      },
      items: {
        "child-0": { packageId: "pending", status: "GENERATING", outputCount: 0, existing: false },
      },
    },
  };
  if (!item.curation) throw Error("missing curation");
  const active = await mount(item);
  const pause = [...active.host.querySelectorAll("button")].find(
    (b) => b.textContent === "Pause and change channels",
  );
  expect(pause).toBeTruthy();
  await act(async () => pause?.click());
  expect(active.send).toHaveBeenCalledWith({ action: "pause-playlist-settings", id: parent.id });
  await act(async () => active.root.unmount());
  const paused = await mount({ ...item, curation: { ...item.curation, pausedForSettings: true } });
  const form = paused.host.querySelector("form");
  if (!form) throw Error("missing form");
  expect(paused.host.textContent).toContain("Save channels and resume all 16 recordings");
  expect(paused.host.textContent).not.toContain("Retry unfinished videos");
  expect((form.elements.namedItem("sourceBranding") as HTMLSelectElement).value).toBe(
    "bala-swamiji",
  );
  expect((form.elements.namedItem("owner") as HTMLInputElement).value).toBe("Saved owner");
  const fb = form.querySelector<HTMLInputElement>('input[name="channel"][value="facebook"]');
  if (!fb) throw Error("missing Facebook choice");
  expect(fb.disabled).toBe(false);
  expect(fb.checked).toBe(false);
  fb.checked = true;
  (form.elements.namedItem("confirmed") as HTMLInputElement).checked = true;
  await act(async () =>
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(paused.send).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "curate-playlist",
      request: expect.objectContaining({
        channels: ["youtube", "facebook"],
        sourceBranding: "bala-swamiji",
        instructions: "Saved guidance",
      }),
      rights: expect.objectContaining({
        owner: "Saved owner",
        authorizationBasis: "Saved permission",
      }),
    }),
  );
  await act(async () => paused.root.unmount());
  const locked = await mount({
    ...item,
    curation: {
      ...item.curation,
      items: { "child-0": { packageId: "done", status: "IN_REVIEW", outputCount: 1 } },
    },
  });
  expect(locked.host.textContent).not.toContain("Pause and change channels");
  await act(async () => locked.root.unmount());
});

it("shows active discovery in the overview without expanding video details, and hides it when paused", async () => {
  const item: OnlineImport = {
    ...parent,
    childIds: parent.childIds?.slice(0, 7) ?? [],
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
      items: Object.fromEntries(
        items.slice(0, 7).map((child, index) => [
          child.id,
          {
            packageId: `package-${index}`,
            status: index === 0 ? "GENERATING" : "QUEUED",
            outputCount: 0,
            generationProgress:
              index === 0
                ? {
                    phase: "reviewing",
                    provider: "gemini",
                    completed: 0,
                    total: 1,
                    discoverySection: 27,
                    discoverySections: 29,
                  }
                : null,
          },
        ]),
      ),
    },
  };
  const { host, root } = await mount(item, items.slice(0, 7));
  try {
    const progress = host.querySelector('[aria-label="Series generation progress"]');
    expect(progress?.textContent).toContain("1 processing · 6 queued");
    expect(progress?.textContent).toContain("Reviewing section 27 of 29");
    expect(progress?.closest("details")).toBeNull();
    if (!item.curation) throw Error("missing curation");
    const paused = { ...item, curation: { ...item.curation, pausedForSettings: true } };
    await act(async () =>
      root.render(
        <PlaylistCuration
          item={paused}
          items={items.slice(0, 7)}
          busy={false}
          send={vi.fn()}
          open={vi.fn()}
        />,
      ),
    );
    expect(host.querySelector('[aria-label="Series generation progress"]')).toBeNull();
    expect(host.textContent).toContain("Generation is paused");
  } finally {
    await act(async () => root.unmount());
  }
});
