import type { DistributionCapability } from "@satsang/distribution-domain";
// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ContentLibrary } from "./content-library";

vi.mock("./studio-panel", () => ({ StudioPanel: () => <section>Existing curations</section> }));
vi.mock("./outreach-panel", () => ({
  OutreachPanel: () => <section>Campaigns and invitations</section>,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
function setup() {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      Response.json(
        url.endsWith("upload-policy")
          ? { maxMasterBytes: 250 * 1024 * 1024 }
          : { items: [], available: true },
      ),
    ),
  );
  const host = document.createElement("div");
  document.body.append(host);
  return { host, root: createRoot(host) };
}
it.each<DistributionCapability[]>([
  ["content.create"],
  ["content.create", "content.review", "content.publish", "campaigns.manage", "operations.manage"],
])(
  "makes both source choices visible without outreach tools for capabilities %s",
  async (...capabilities) => {
    const { host, root } = setup();
    const button = (label: string) =>
      [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
    try {
      await act(async () =>
        root.render(
          <ContentLibrary
            locale="en"
            displayName={null}
            stage="TEST"
            capabilities={capabilities}
            initialView="content"
          />,
        ),
      );
      expect(host.querySelector('input[name="url"]')).not.toBeNull();
      const progress = host.querySelector('section[aria-label="Content workflow"]');
      expect(progress?.querySelectorAll("ol > li")).toHaveLength(6);
      expect(progress?.textContent).toContain("Step 1 of 6");
      expect(progress?.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
      expect(progress?.querySelector("li")?.textContent).toContain("You are here");
      expect(host.querySelector('input[name="includePlaylist"]')).not.toBeNull();
      expect(button("Next: Import source")?.disabled).toBe(false);
      expect(host.querySelector<HTMLInputElement>('input[name="includePlaylist"]')?.checked).toBe(
        true,
      );
      expect(button("Upload raw master")).toBeDefined();
      expect(button("Source approvals")).toBeUndefined();
      await act(async () => button("Upload raw master")?.click());
      expect(host.querySelectorAll('section[aria-label="Content workflow"]')).toHaveLength(1);
      expect(host.textContent).toContain("Step 1 of 6");
      expect(host.querySelector('input[type="file"]')).not.toBeNull();
      await act(async () => button("Back to workspace")?.click());
      expect(button("Campaigns")).toBeUndefined();
      await act(async () => button("Curation Complete Library")?.click());
      expect(host.querySelector('section[aria-label="Content workflow"]')).toBeNull();
      expect(host.textContent).toContain("Approved files are locked");
      // Switching through existing work must return to the same entry screen.
      await act(async () => button("Continue Existing Curation")?.click());
      expect(host.querySelector('section[aria-label="Content workflow"]')).toBeNull();
      expect(host.textContent).toContain(
        "Select a playlist or series to work on all its recordings together",
      );
      expect(host.querySelector('input[name="url"]')).toBeNull();
      if (capabilities.includes("campaigns.manage")) {
        await act(async () => button("Campaigns")?.click());
        expect(host.textContent).toContain("Campaigns and invitations");
      }
      await act(async () => button("Start New Curation")?.click());
      expect(host.querySelector('input[name="url"]')).not.toBeNull();
      expect(host.textContent).not.toContain("Campaigns and invitations");
      expect(button("Source approvals")).toBeUndefined();
    } finally {
      await act(async () => root.unmount());
    }
  },
);
it("explains the missing Curator role to an Approver instead of advertising hidden inputs", async () => {
  const { host, root } = setup();
  try {
    await act(async () =>
      root.render(
        <ContentLibrary
          locale="en"
          displayName={null}
          stage="TEST"
          capabilities={["content.review", "content.publish"]}
          initialView="content"
        />,
      ),
    );
    expect(host.textContent).toContain("Content Curator access required");
    expect(host.textContent).toContain("Your current account does not have that role");
    expect(host.querySelector('input[name="url"]')).toBeNull();
    expect(host.textContent).not.toContain("Upload a recording from your computer");
    expect(host.textContent).not.toContain("Campaigns");
    expect(host.textContent).toContain("Review existing curations");
  } finally {
    await act(async () => root.unmount());
  }
});

it("retries upload settings separately and clears the warning after recovery", async () => {
  const { host, root } = setup();
  let fail = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("upload-policy"))
        return fail
          ? Response.json({ error: "UNAVAILABLE" }, { status: 503 })
          : Response.json({ maxMasterBytes: 250 * 1024 * 1024 });
      return Response.json({ items: [], available: true });
    }),
  );
  const button = (label: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  try {
    await act(async () =>
      root.render(
        <ContentLibrary
          locale="en"
          displayName={null}
          stage="TEST"
          capabilities={["content.create"]}
          initialView="content"
        />,
      ),
    );
    expect(host.textContent).not.toContain("Unable to load the upload limit");
    await act(async () => button("Upload raw master")?.click());
    expect(host.textContent).toContain("Unable to load the upload limit");
    fail = false;
    await act(async () => button("Retry upload settings")?.click());
    expect(host.textContent).not.toContain("Unable to load the upload limit");
    expect(host.textContent).toContain("Up to 250 MB");
  } finally {
    await act(async () => root.unmount());
  }
});
