// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PublicStudioPublication, StudioListing } from "../lib/studio-model";
import { PlaylistFiles } from "./playlist-files";
import { StudioPanel } from "./studio-panel";
import { value } from "./studio-workflow-fixture";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
function setup() {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  return { host, root: createRoot(host) };
}
const first = { ...value, id: "first", source: { ...value.source, title: "First recording" } };
const second = {
  ...value,
  id: "second",
  source: { ...value.source, masterId: "second-master", title: "Second recording" },
  outputs: value.outputs.map((output) => ({
    ...output,
    id: "second-output",
    channel: "facebook" as const,
    format: "reel" as const,
    title: "Second teaching",
    asset: output.asset ? { ...output.asset, filename: "second-facebook.mp4" } : null,
  })),
};

it("separates drafts from submitted work and directs an Approver only to a submitted recording", async () => {
  const { host, root } = setup();
  const onOpen = vi.fn();
  const submitted = { ...second, status: "IN_REVIEW" as const };
  try {
    await act(async () =>
      root.render(
        <PlaylistFiles
          packages={[first, submitted]}
          canReview
          canPublish
          onOpen={onOpen}
          onPreview={vi.fn()}
        />,
      ),
    );
    expect(host.textContent).toContain(
      "1 files awaiting Curator submission · 1 files ready for Approver review",
    );
    expect(host.textContent).toContain("Approval controls become available after submission");
    expect(host.textContent).toContain("publication is simulated");
    expect(
      host.querySelector('button[aria-label="Open workflow for First recording"]')?.textContent,
    ).toBe("Preview draft");
    expect(
      host.querySelector('button[aria-label="Open workflow for Second recording"]')?.textContent,
    ).toBe("Review & approve");
    expect(onOpen).not.toHaveBeenCalled();
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "Review next recording")
        ?.click(),
    );
    expect(onOpen).toHaveBeenCalledWith(submitted);
  } finally {
    await act(async () => root.unmount());
  }
});

it("gives the Curator an explicit check-and-submit entry without approving on navigation", async () => {
  const { host, root } = setup();
  const onOpen = vi.fn();
  try {
    await act(async () =>
      root.render(
        <PlaylistFiles packages={[first]} canCurate onOpen={onOpen} onPreview={vi.fn()} />,
      ),
    );
    expect(
      host.querySelector('button[aria-label="Open workflow for First recording"]')?.textContent,
    ).toBe("Check & submit");
    expect(host.textContent).not.toContain("Approval controls become available after submission");
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "Check & submit next recording")
        ?.click(),
    );
    expect(onOpen).toHaveBeenCalledWith(first);
  } finally {
    await act(async () => root.unmount());
  }
});

it("explains reviewed parts with no suitable excerpt instead of implying they are still generating", async () => {
  const { host, root } = setup();
  const onOpen = vi.fn();
  const empty = {
    ...first,
    outputs: [],
    status: "FAILED" as const,
    failure: "STUDIO_NO_SUITABLE_CHANNELS",
  };
  try {
    await act(async () =>
      root.render(<PlaylistFiles packages={[empty]} onOpen={onOpen} onPreview={vi.fn()} />),
    );
    expect(host.textContent).toContain("1 source recording with no generated files");
    expect(host.textContent).not.toContain("still need generated files");
    expect(host.textContent).not.toContain("as generation finishes");
    await act(async () => host.querySelector("button")?.click());
    expect(onOpen).toHaveBeenCalledWith(empty);
  } finally {
    await act(async () => root.unmount());
  }
});

it("explains an empty source without rejecting the successful recording with the same title", async () => {
  const { host, root } = setup();
  const onOpen = vi.fn();
  const empty = {
    ...first,
    id: "musical-source-package",
    source: { ...first.source, masterId: "musical-source" },
    outputs: [],
    status: "FAILED" as const,
    failure: "STUDIO_NO_SUITABLE_CHANNELS",
    generationProgress: {
      phase: "drafting" as const,
      provider: "gemini" as const,
      completed: 0,
      total: 1,
      excludedChannels: [
        {
          channel: "youtube" as const,
          reason: "This source contains devotional singing, not a spoken discourse.",
        },
      ],
    },
  };
  try {
    await act(async () =>
      root.render(
        <PlaylistFiles
          packages={[empty, first]}
          sourceLinks={{ "musical-source": "https://www.youtube.com/watch?v=0UO6eFncU9I" }}
          onOpen={onOpen}
          onPreview={vi.fn()}
        />,
      ),
    );
    expect(host.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(host.textContent).toContain(
      "This source contains devotional singing, not a spoken discourse.",
    );
    expect(host.textContent).toContain("A different recording with this title has 1 file.");
    expect(host.textContent).not.toContain("no complete teaching selected");
    expect(
      host.querySelector('a[href="https://www.youtube.com/watch?v=0UO6eFncU9I"]'),
    ).not.toBeNull();
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "View existing file")
        ?.click(),
    );
    expect(onOpen).toHaveBeenCalledWith(first);
  } finally {
    await act(async () => root.unmount());
  }
});

it("shows every recording's files immediately, filters by channel and previews without entering a workflow", async () => {
  const { host, root } = setup();
  const onPreview = vi.fn();
  const onOpen = vi.fn();
  try {
    await act(async () =>
      root.render(
        <PlaylistFiles packages={[first, second]} onPreview={onPreview} onOpen={onOpen} />,
      ),
    );
    expect(host.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(host.textContent).toContain("2 files across 2 recordings");
    expect(host.textContent).toContain("YouTube Shorts: 1");
    expect(host.textContent).toContain("Facebook: 1");
    const preview = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Preview second-facebook.mp4"]',
    );
    await act(async () => preview?.click());
    expect(onPreview).toHaveBeenCalledWith(second, "second-output");
    expect(onOpen).not.toHaveBeenCalled();
    const select = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Playlist file channel"]',
    );
    if (!select) throw Error("Missing channel filter");
    await act(async () => {
      select.value = "facebook";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(host.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(host.textContent).toContain("Second recording");
    expect(host.textContent).not.toContain("First recording");
  } finally {
    await act(async () => root.unmount());
  }
});

it("keeps approval separate from another account's posted receipt", async () => {
  const { host, root } = setup();
  const approved = {
    ...first,
    isTest: false,
    status: "APPROVED" as const,
    approval: {
      reviewerId: "approver",
      revision: first.revision,
      sourceRevision: first.source.revision,
      approvedAt: first.updatedAt,
    },
  };
  const publication: PublicStudioPublication = {
    id: "posting-on-account-a",
    packageId: approved.id,
    packageRevision: approved.revision,
    outputId: approved.outputs[0]?.id ?? "",
    channel: "youtube",
    isTest: false,
    status: "PUBLISHED",
    selectedAccountId: "account-a",
    attempt: 1,
    error: null,
    remoteId: "existing-video",
    remoteUrl: "https://www.youtube.com/watch?v=existing",
    createdAt: first.updatedAt,
    updatedAt: first.updatedAt,
  };
  const readiness: StudioListing["readiness"] = {
    isTest: false,
    generation: {
      available: true,
      transcription: "configured",
      intelligence: "configured",
      translation: true,
      reason: null,
    },
    channels: [
      {
        channel: "youtube",
        label: "YouTube",
        ready: true,
        reason: null,
        accountId: "account-b",
        transport: "buffer",
        accounts: [
          { id: "account-a", label: "Channel A", isDefault: false, ready: true, reason: null },
          { id: "account-b", label: "Channel B", isDefault: true, ready: true, reason: null },
        ],
      },
    ],
  };
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  try {
    await act(async () =>
      root.render(
        <PlaylistFiles
          packages={[approved]}
          publications={[publication]}
          readiness={readiness}
          onOpen={vi.fn()}
          onPreview={vi.fn()}
        />,
      ),
    );
    const reviewStatus = () =>
      host.querySelector("tbody tr td:nth-last-child(2) .lineage-status")?.textContent;
    const postingStatus = () =>
      host.querySelector("tbody tr td:last-child .lineage-status")?.textContent;
    expect(reviewStatus()).toBe("Approved");
    expect(postingStatus()).toBe("No Studio posting record");
    const account = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Posting status account"]',
    );
    if (!account) throw Error("Missing account filter");
    await act(async () => {
      account.value = "account-a";
      account.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(reviewStatus()).toBe("Approved");
    expect(postingStatus()).toBe("Posted");
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});

it.each([
  ["content.create"],
  ["content.review", "content.publish"],
  ["content.create", "content.review", "content.publish"],
] as const)(
  "opens the complete file list for roles %j, preserving one workflow only after an explicit choice",
  async (...roles) => {
    const { host, root } = setup();
    const readiness = {
      generation: { available: true, translation: true },
      publishing: { available: false },
      channels: [],
    };
    const old = {
      ...first,
      id: "old-curation",
      outputs: first.outputs.map((output) => ({
        ...output,
        id: "old-output",
        title: "Excluded earlier curation",
      })),
    };
    const requests = vi.fn(async (url: string, options?: RequestInit) => {
      expect(options?.method ?? "GET").toBe("GET");
      if (url.includes("?")) return Response.json({ packages: [second, old, first], readiness });
      if (url.endsWith("/history")) return Response.json({ history: [] });
      return Response.json({ package: second, readiness, publications: [], blockers: [] });
    });
    vi.stubGlobal("fetch", requests);
    try {
      await act(async () =>
        root.render(
          <StudioPanel
            capabilities={roles}
            bundle={{
              title: "Playlist",
              masterIds: [first.source.masterId, second.source.masterId],
              packageIds: [first.id, second.id],
            }}
          />,
        ),
      );
      expect(host.querySelectorAll("tbody tr")).toHaveLength(2);
      expect(host.querySelector('[aria-label="Content workflow"]')).toBeNull();
      expect(host.querySelectorAll('[aria-label="Series workflow"]')).toHaveLength(1);
      expect(host.querySelector('[aria-label="Recording in bundle"]')).toBeNull();
      expect(host.textContent).not.toContain("Excluded earlier curation");
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Open workflow for Second recording"]',
          )
          ?.click(),
      );
      expect(host.querySelectorAll('[aria-label="Content workflow"]')).toHaveLength(1);
      expect(host.textContent).toContain("Recording 2 of 2");
      await act(async () =>
        [...host.querySelectorAll("button")]
          .find((button) => button.textContent === "All bundle files")
          ?.click(),
      );
      expect(host.querySelectorAll("tbody tr")).toHaveLength(2);
      expect(host.querySelector('[aria-label="Content workflow"]')).toBeNull();
      expect(host.querySelectorAll('[aria-label="Series workflow"]')).toHaveLength(1);
      expect(requests.mock.calls.some(([url]) => url.endsWith("/old-curation"))).toBe(false);
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it.each(["submit", "approve", "post"] as const)(
  "keeps individual file selection within one day for %s",
  async (action) => {
    const { host, root } = setup();
    const output = value.outputs[0];
    if (!output) throw Error("MISSING_FIXTURE");
    const pkg = {
      ...first,
      status: (action === "submit" ? "DRAFT" : action === "approve" ? "IN_REVIEW" : "APPROVED") as
        | "DRAFT"
        | "IN_REVIEW"
        | "APPROVED",
      outputs: [
        { ...output, id: "a", title: "First Short" },
        { ...output, id: "b", title: "Second Short" },
      ],
    };
    try {
      await act(async () =>
        root.render(
          <PlaylistFiles
            packages={[pkg]}
            canCurate={action === "submit"}
            canReview={action === "approve"}
            canPublish={action === "post"}
            onOpen={vi.fn()}
            onPreview={vi.fn()}
            onRefresh={async () => {}}
          />,
        ),
      );
      const a = host.querySelector<HTMLInputElement>('input[aria-label="Select First Short"]');
      const b = host.querySelector<HTMLInputElement>('input[aria-label="Select Second Short"]');
      const all = host.querySelector<HTMLInputElement>(
        'input[aria-label="Select all visible files"]',
      );
      if (!a || !b || !all) throw Error("MISSING_CHECKBOXES");
      await act(async () => a.click());
      expect(a.checked).toBe(true);
      expect(b.checked).toBe(false);
      expect(all.indeterminate).toBe(true);
      expect(host.textContent).toContain("1 file selected");
      await act(async () => all.click());
      expect(a.checked && b.checked).toBe(true);
      await act(async () => b.click());
      expect(a.checked).toBe(true);
      expect(b.checked).toBe(false);
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it("shows completed MP4 previews during generation without adding them to selection or approval", async () => {
  const { host, root } = setup();
  const output = value.outputs[0];
  if (!output) throw Error("missing fixture");
  try {
    await act(async () =>
      root.render(
        <PlaylistFiles
          packages={[
            {
              ...first,
              status: "GENERATING",
              outputs: [],
              generationPreviews: [{ ...output, title: "First rendered teaching" }],
            },
          ]}
          canCurate
          canReview
          canPublish
          onOpen={vi.fn()}
          onPreview={vi.fn()}
        />,
      ),
    );
    const previews = host.querySelector('[aria-label="Completed MP4 previews"]');
    expect(previews?.textContent).toContain("Ready to preview · 1 MP4");
    expect(previews?.textContent).toContain("Nothing has been approved or posted");
    expect(previews?.querySelector("video")?.getAttribute("src")).toBe(
      `/distribution/api/studio/first/assets/${output.id}/media?preview=1`,
    );
    expect(previews?.querySelector("video")?.preload).toBe("none");
    expect(previews?.querySelector('input[type="checkbox"]')).toBeNull();
    expect(previews?.querySelector("button")).toBeNull();
    expect(host.textContent).toContain("0 files across 1 recordings");
  } finally {
    await act(async () => root.unmount());
  }
});
