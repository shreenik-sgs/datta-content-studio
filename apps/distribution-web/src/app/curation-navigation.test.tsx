// @vitest-environment jsdom
import type { ContentMaster, DistributionCapability } from "@satsang/distribution-domain";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PublicStudioPackage } from "../lib/studio-model";
import { ContentLibrary } from "./content-library";
import { value } from "./studio-workflow-fixture";

// Specialist tools are outside this journey; keep the library, picker and workflow real.
vi.mock("./editorial-panel", () => ({ EditorialPanel: () => null }));
vi.mock("./native-panel", () => ({ NativePanel: () => null }));
vi.mock("./variants-panel", () => ({ VariantsPanel: () => null }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
const master = (number: number, title: string): ContentMaster => {
  const id = `${String(number).padStart(8, "0")}-1111-4111-8111-111111111111`;
  return {
    id,
    title,
    language: "te",
    category: "other",
    isTest: true,
    revision: 1,
    state: "DRAFT",
    currentVersion: {
      id: `${String(number).padStart(8, "0")}-2222-4222-8222-222222222222`,
      masterId: id,
      number: 1,
      sha256: "a".repeat(64),
      byteSize: 100,
      mimeType: "video/mp4",
      originalName: "master.mp4",
      createdAt: value.createdAt,
      createdBy: "fixture",
    },
    rights: null,
    approval: null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
};
const first = master(1, "Kindness recording");
const second = master(2, "Daily practice recording");
const unstarted = master(3, "New uploaded recording");
const approved = master(4, "Completed recording");
const pkg = (
  source: ContentMaster,
  status: PublicStudioPackage["status"],
  id = source.id,
): PublicStudioPackage => ({
  ...structuredClone(value),
  id,
  status,
  source: { ...value.source, masterId: source.id, title: source.title },
});
function setup(packages: PublicStudioPackage[]) {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      requests.push(url);
      if (options?.method === "POST") throw Error("Navigation must not change content");
      const path = new URL(url, "http://local.test");
      const readiness = {
        generation: { available: true, translation: true },
        publishing: { available: false },
        channels: [],
      };
      if (path.pathname.endsWith("upload-policy"))
        return Response.json({ maxMasterBytes: 250 * 1024 * 1024 });
      if (path.pathname.endsWith("/import")) return Response.json({ items: [], available: true });
      if (path.pathname.endsWith("/history")) return Response.json({ history: [] });
      if (path.pathname.endsWith("/detail")) {
        const source = [first, second, unstarted, approved].find((s) =>
          path.pathname.includes(s.id),
        );
        return Response.json({ content: source });
      }
      if (path.pathname === "/distribution/api/content")
        return Response.json({ items: [first, second, unstarted, approved], nextOffset: null });
      if (path.pathname === "/distribution/api/studio")
        return Response.json({
          packages: packages.filter(
            (p) =>
              !path.searchParams.has("masterId") ||
              p.source.masterId === path.searchParams.get("masterId"),
          ),
          readiness,
        });
      const current = packages.find((p) => path.pathname === `/distribution/api/studio/${p.id}`);
      if (current)
        return Response.json({ package: current, readiness, blockers: [], publications: [] });
      throw Error(`Unexpected navigation request ${path.pathname}`);
    }),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const button = (name: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
  const card = (name: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button.content-card")].find(
      (b) => b.querySelector("h3")?.textContent === name,
    );
  const click = async (element: HTMLButtonElement | undefined) => {
    expect(element).toBeDefined();
    await act(async () => element?.click());
  };
  const workflow = () => host.querySelector('section[aria-label="Content workflow"]');
  return { host, root, requests, button, card, click, workflow };
}

it.each<{ role: string; capabilities: DistributionCapability[] }>([
  { role: "Curator", capabilities: ["content.create"] },
  { role: "Approver", capabilities: ["content.review", "content.publish"] },
  { role: "combined", capabilities: ["content.create", "content.review", "content.publish"] },
])(
  "selects a master before showing its real progress and resets cleanly across all tabs ($role)",
  async ({ capabilities }) => {
    const oldBatch = { ...pkg(first, "DRAFT", "old-batch"), updatedAt: "2026-10-09T08:00:00.000Z" };
    const { host, root, button, card, click, workflow, requests } = setup([
      oldBatch,
      pkg(second, "IN_REVIEW"),
      pkg(first, "DRAFT"),
      pkg(approved, "APPROVED"),
    ]);
    try {
      await act(async () =>
        root.render(
          <ContentLibrary
            locale="en"
            displayName={null}
            stage="TEST"
            capabilities={capabilities}
            initialView="studio"
          />,
        ),
      );
      expect(workflow()).toBeNull();
      expect(host.textContent).toContain("Choose a source to continue");
      expect(host.querySelectorAll("button.content-card")).toHaveLength(3);
      expect(card(approved.title)).toBeUndefined();
      expect(card(first.title)?.textContent).toContain("2 curations");
      expect(card(unstarted.title)?.textContent).toContain("Step 1 of 6");
      await click(card(first.title));
      expect(workflow()?.textContent).toContain("Step 3 of 6");
      expect(workflow()?.querySelectorAll("ol > li")).toHaveLength(6);
      expect(workflow()?.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
      expect(host.querySelectorAll("button.content-card")).toHaveLength(0);
      expect(host.textContent).not.toContain(second.title);
      expect(requests).toContain(`/distribution/api/studio/${first.id}`);
      expect(host.querySelector<HTMLSelectElement>(".package-selection select")?.value).toBe(
        first.id,
      );
      expect(host.querySelectorAll(".package-selection option")).toHaveLength(2);
      expect(Boolean(button("Continue to approval review"))).toBe(
        capabilities.includes("content.create") && capabilities.includes("content.review"),
      );
      await click(button("Back to masters"));
      expect(workflow()).toBeNull();
      await click(card(second.title));
      expect(workflow()?.textContent).toContain("Step 4 of 6");
      expect(host.textContent).not.toContain(first.title);
      expect(Boolean(button("Approve package"))).toBe(capabilities.includes("content.review"));
      // Clicking the current tab must return to the picker, not keep an invisible selection.
      await click(button("Continue Existing Curation"));
      expect(workflow()).toBeNull();
      expect(card(first.title)).toBeDefined();
      await click(card(unstarted.title));
      expect(workflow()?.textContent).toContain("Step 1 of 6");
      expect(host.textContent).not.toContain(first.title);
      await click(button("Back to workspace"));
      expect(workflow()).toBeNull();
      expect(card(unstarted.title)).toBeDefined();
      await click(button("Curation Complete Library"));
      expect(workflow()).toBeNull();
      expect(host.querySelectorAll("button.content-card")).toHaveLength(1);
      await click(card(approved.title));
      expect(host.textContent).toContain("Approved and locked");
      expect(host.querySelector('textarea[name="instructions"]')).toBeNull();
      expect(button("Approve package")).toBeUndefined();
      await click(button("Start New Curation"));
      expect(workflow()?.textContent).toContain("Step 1 of 6");
      expect(host.querySelectorAll("button.content-card")).toHaveLength(0);
      expect(Boolean(host.querySelector('input[name="url"]'))).toBe(
        capabilities.includes("content.create"),
      );
      await click(button("Continue Existing Curation"));
      expect(workflow()).toBeNull();
      expect(card(second.title)).toBeDefined();
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it.each([
  ["QUEUED", 2],
  ["GENERATING", 2],
  ["FAILED", 2],
  ["CHANGES_REQUESTED", 5],
] as const)(
  "opens %s at the saved step %s, without showing another master's progress",
  async (status, step) => {
    const { root, card, click, workflow, host } = setup([
      pkg(first, status),
      pkg(second, "DRAFT"),
      pkg(approved, "APPROVED"),
    ]);
    try {
      await act(async () =>
        root.render(
          <ContentLibrary
            locale="en"
            displayName={null}
            stage="TEST"
            capabilities={["content.create", "content.review", "content.publish"]}
            initialView="studio"
          />,
        ),
      );
      expect(workflow()).toBeNull();
      await click(card(first.title));
      expect(workflow()?.textContent).toContain(`Step ${step} of 6`);
      expect(host.querySelectorAll('section[aria-label="Content workflow"]')).toHaveLength(1);
      expect(host.textContent).not.toContain(second.title);
    } finally {
      await act(async () => root.unmount());
    }
  },
);
