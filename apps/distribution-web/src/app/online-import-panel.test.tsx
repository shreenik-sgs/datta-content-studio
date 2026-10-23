// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { OnlineImportPanel } from "./online-import-panel";
import { value } from "./studio-workflow-fixture";
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

it("opens a bookmarked series directly at all files, including recordings beyond the first page", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const bundleId = "00000000-0000-4000-8000-000000000001";
  const packages = Array.from({ length: 51 }, (_, index) => ({
    ...structuredClone(value),
    id: `package-${index}`,
    source: { ...value.source, masterId: `master-${index}`, title: `Recording ${index + 1}` },
  }));
  const children = packages.map((pkg, index) => ({
    id: `child-${index}`,
    masterId: pkg.source.masterId,
    source: {
      provider: "youtube",
      kind: "video",
      id: String(index).padStart(11, "0"),
      url: `https://www.youtube.com/watch?v=${String(index).padStart(11, "0")}`,
    },
  }));
  const parent = {
    id: bundleId,
    title: "Entire series",
    source: { provider: "youtube", kind: "bundle" },
    childIds: children.map((child) => child.id),
    curation: {
      items: Object.fromEntries(
        children.map((child, index) => [
          child.id,
          { packageId: packages[index]?.id, status: "DRAFT" },
        ]),
      ),
    },
  };
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    expect(options?.method ?? "GET").toBe("GET");
    if (url === `/distribution/api/content/import?rootId=${bundleId}`)
      return Response.json({ items: [parent, ...children], available: true });
    if (url.includes("/distribution/api/studio?")) {
      expect(new URL(url, "http://localhost").searchParams.get("playlistId")).toBe(bundleId);
      return Response.json({
        packages,
        readiness: {
          generation: { available: true },
          publishing: { available: false },
          channels: [],
        },
      });
    }
    throw Error(`Unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <OnlineImportPanel
          locale="en"
          showForm={false}
          initialBundleId={bundleId}
          onOpen={vi.fn()}
        />,
      ),
    );
    expect(host.textContent).toContain("51 files across 51 recordings");
    expect(host.querySelectorAll("tbody tr")).toHaveLength(51);
    expect(host.textContent).toContain("Recording 51");
    expect(host.querySelector('[aria-label="Content workflow"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it("explains a removed bookmarked series without falling back to an unrelated source", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ items: [], available: true })),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <OnlineImportPanel
          locale="en"
          showForm={false}
          initialBundleId="missing"
          onOpen={vi.fn()}
        />,
      ),
    );
    expect(host.textContent).toContain("no longer available in this workspace");
    expect(host.textContent).toContain("Back to sources");
    expect(host.querySelector('[aria-label="Content workflow"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
it("removes a stale import-progress warning when the next poll succeeds", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let fail = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (fail) throw Error("temporarily offline");
      return Response.json({ items: [], available: true });
    }),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<OnlineImportPanel locale="en" showForm onOpen={vi.fn()} />));
    expect(host.textContent).toContain("Reconnecting automatically");
    fail = false;
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(host.textContent).not.toContain("Reconnecting automatically");
  } finally {
    await act(async () => root.unmount());
  }
});
it("keeps a blocked playlist accessible as one bundle instead of separate failed-video workspaces", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const child = {
    id: "child",
    source: {
      provider: "youtube",
      kind: "video",
      id: "g0zlErdfXlg",
      url: "https://youtube.com/watch?v=g0zlErdfXlg",
    },
    title: "Teaching",
    status: "FAILED",
    masterId: null,
    parentId: "parent",
    childIds: null,
    error: "ONLINE_SOURCE_RESTRICTED",
    createdAt: "2026-10-13T00:00:00Z",
    updatedAt: "2026-10-13T00:00:00Z",
  };
  const parent = {
    ...child,
    id: "parent",
    source: { ...child.source, kind: "playlist" },
    title: "Playlist",
    parentId: null,
    status: "COMPLETE",
    childIds: ["child"],
    error: null,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        items: [parent, child],
        groupedMasterIds: child.masterId ? [child.masterId] : [],
        available: true,
      }),
    ),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(<OnlineImportPanel locale="en" showForm={false} onOpen={vi.fn()} />),
    );
    expect(host.textContent).toContain("Continue playlist");
    expect(host.textContent).not.toContain("requires a login");
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "Continue playlist")
        ?.click(),
    );
    expect(host.textContent).toContain("0 of 1 recordings downloaded");
    expect(host.textContent).toContain("requires a login, membership or other access");
    expect(host.textContent).toContain("Generate curated content for all");
    expect(host.textContent).not.toContain("Retry this download");
  } finally {
    await act(async () => root.unmount());
  }
});
it("explains when the service is unavailable and keeps upload available outside this form", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ items: [], available: false })),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<OnlineImportPanel locale="en" showForm onOpen={vi.fn()} />));
    expect(host.textContent).toContain("Online imports are temporarily unavailable");
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
});

it("keeps the newly completed master visible and keeps earlier imports out of Start New Curation", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let submitted = false;
  const item = {
    id: "new",
    source: {
      provider: "youtube",
      kind: "video",
      id: "g0zlErdfXlg",
      url: "https://www.youtube.com/watch?v=g0zlErdfXlg",
    },
    title: "New master",
    status: "COMPLETE",
    masterId: "master",
    parentId: null,
    childIds: null,
    error: null,
    createdAt: "2026-10-13T00:00:00Z",
    updatedAt: "2026-10-13T00:00:00Z",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === "POST") {
        submitted = true;
        return Response.json({ item: { ...item, status: "QUEUED" } });
      }
      return Response.json({
        items: [
          { ...item, id: "old", title: "Old completed master" },
          ...(submitted ? [item] : []),
        ],
        available: true,
      });
    }),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<OnlineImportPanel locale="en" showForm onOpen={vi.fn()} />));
    expect(host.textContent).not.toContain("Old completed master");
    const url = host.querySelector<HTMLInputElement>('input[name="url"]');
    const form = host.querySelector("form");
    if (!url || !form) throw Error("Missing form");
    url.value = "https://evil.test/video";
    await act(async () =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(host.textContent).toContain("Paste a full YouTube or Facebook video link");
    expect(submitted).toBe(false);
    url.value = item.source.url;
    await act(async () =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(host.textContent).toContain("Continue to permissions");
    expect(host.querySelector("details")?.open).toBe(true);
    expect(host.textContent).not.toContain("Old completed master");
    await act(async () =>
      root.render(<OnlineImportPanel locale="en" showForm={false} onOpen={vi.fn()} />),
    );
    expect(host.textContent).not.toContain("Continue to permissions");
    expect(host.querySelector('section[aria-label="Online video imports"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it.each([false, true])(
  "offers recovery before playlist expansion without an empty bundle (verification: %s)",
  async (verification) => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const item = {
      id: "parent",
      source: {
        provider: "youtube",
        kind: "playlist",
        id: "PL123",
        url: "https://youtube.com/playlist?list=PL123",
      },
      title: "Blocked playlist",
      status: "FAILED",
      parentId: null,
      childIds: null,
      masterId: null,
      error: "ONLINE_SOURCE_RESTRICTED",
      ...(verification
        ? {
            serviceIssue: {
              provider: "youtube",
              code: "ONLINE_PROVIDER_VERIFICATION_REQUIRED",
              retryAt: null,
              attempts: 1,
            },
          }
        : {}),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ items: [item], available: true })),
    );
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(<OnlineImportPanel locale="en" showForm={false} onOpen={vi.fn()} />),
      );
      await act(async () =>
        [...host.querySelectorAll("button")]
          .find((b) => b.textContent === "Continue playlist")
          ?.click(),
      );
      expect(host.textContent).toContain(
        verification ? "Verify YouTube access" : "Resume playlist",
      );
      if (verification) expect(host.textContent).toContain("Verify YouTube access");
      expect(host.textContent).not.toContain("Generate curated content for all");
      expect(host.textContent).not.toContain("0 of 0");
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it("groups an independently imported first recording under its playlist and keeps Approver setup read-only", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const child = {
    id: "child",
    source: {
      provider: "youtube",
      kind: "video",
      id: "g0zlErdfXlg",
      url: "https://youtube.com/watch?v=g0zlErdfXlg",
    },
    title: "First recording",
    status: "COMPLETE",
    masterId: "master",
    parentId: null,
    childIds: null,
  };
  const parent = {
    ...child,
    id: "parent",
    title: "Whole playlist",
    source: { ...child.source, kind: "playlist" },
    masterId: null,
    childIds: [child.id],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ items: [child, parent], groupedMasterIds: ["master"], available: true }),
    ),
  );
  const grouped = vi.fn();
  const selection = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <OnlineImportPanel
          locale="en"
          showForm={false}
          capabilities={["content.review"]}
          onOpen={vi.fn()}
          onGroupedMasters={grouped}
          onBundleSelection={selection}
        />,
      ),
    );
    expect(grouped).toHaveBeenCalledWith(["master"]);
    expect(host.querySelectorAll("li")).toHaveLength(1);
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "Continue playlist")
        ?.click(),
    );
    expect(selection).toHaveBeenLastCalledWith(true);
    expect(host.textContent).toContain("Content Curator will set up");
    expect(host.querySelector("form")).toBeNull();
    expect(host.textContent).not.toContain("Generate curated content for all");
  } finally {
    await act(async () => root.unmount());
  }
});

it.each(["lost-response", "refresh-failed"])(
  "recovers from %s without exposing raw errors or replaying a mutation",
  async (failure) => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let submitted = false;
    const item = {
      id: "new",
      source: {
        provider: "youtube",
        kind: "video",
        id: "g0zlErdfXlg",
        url: "https://youtube.com/watch?v=g0zlErdfXlg",
      },
      status: "QUEUED",
      parentId: null,
      childIds: null,
      masterId: null,
    };
    const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
      expect(options?.signal).toBeDefined();
      if (options?.method === "POST") {
        submitted = true;
        if (failure === "lost-response") throw Error("private upstream diagnostic");
        return Response.json({ item });
      }
      if (submitted) throw Error("private database diagnostic");
      return Response.json({ items: [], available: true });
    });
    vi.stubGlobal("fetch", fetcher);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(<OnlineImportPanel locale="en" showForm onOpen={vi.fn()} />),
      );
      const form = host.querySelector("form");
      const url = host.querySelector<HTMLInputElement>('input[name="url"]');
      if (!form || !url) throw Error("missing form");
      url.value = item.source.url;
      await act(async () =>
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(fetcher.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
      expect(host.textContent).not.toContain("private");
      expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
      expect(host.textContent).toContain(
        failure === "lost-response" ? "may already be queued" : "Your request was saved",
      );
      if (failure === "refresh-failed") expect(host.textContent).toContain("Import queued");
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it("lets the Curator name a normal playlist link before import", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const fetcher = vi.fn(async (_url: string, options?: RequestInit) =>
    Response.json(
      options?.method === "POST"
        ? {
            item: {
              id: "named",
              source: { kind: "playlist" },
              status: "QUEUED",
              title: "My teachings",
            },
          }
        : { items: [], available: true },
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<OnlineImportPanel locale="en" showForm onOpen={vi.fn()} />));
    const name = host.querySelector<HTMLInputElement>('input[name="title"]');
    const url = host.querySelector<HTMLInputElement>('input[name="url"]');
    if (!name || !url) throw Error("fields");
    name.value = "My teachings";
    url.value = "https://www.youtube.com/playlist?list=PLMyTeachings001";
    await act(async () =>
      host
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    const post = fetcher.mock.calls.find(([, options]) => options?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({
      action: "import",
      title: "My teachings",
      includePlaylist: true,
    });
  } finally {
    await act(async () => root.unmount());
  }
});
