// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { StudioPanel } from "./studio-panel";
import { value } from "./studio-workflow-fixture";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
it("explains the Curator handoff to an Approver without offering draft approval or submission", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Element.prototype.scrollIntoView = vi.fn();
  const requests = vi.fn(async (url: string, options?: RequestInit) => {
    expect(options?.method ?? "GET").toBe("GET");
    if (url.endsWith("/history")) return Response.json({ history: [] });
    if (url.includes("/series")) return Response.json({ bundles: [] });
    const readiness = { generation: { available: true, translation: true }, channels: [] };
    if (url.includes("?")) return Response.json({ packages: [value], readiness });
    return Response.json({
      package: value,
      publications: [],
      readiness,
      blockers: ["NOT_APPROVED"],
    });
  });
  vi.stubGlobal("fetch", requests);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <StudioPanel
          initialPackageId={value.id}
          capabilities={["content.review", "content.publish"]}
        />,
      ),
    );
    expect(host.textContent).toContain("Awaiting Curator submission");
    expect(host.querySelector('[aria-label="Curator handoff"]')?.textContent).toContain(
      "Submit selected files for review",
    );
    expect(host.textContent).toContain("it does not upload videos to YouTube");
    const labels = [...host.querySelectorAll("button")].map((button) => button.textContent?.trim());
    expect(labels).not.toContain("Approve selected files");
    expect(labels).not.toContain("Approve master permissions");
    expect(labels).not.toContain("Submit selected files for review");
    expect(labels).not.toContain("Run test publication");
    expect(labels).not.toContain("Next: check and submit →");
    expect(host.querySelectorAll("form")).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
  }
});

it("shows exactly one stage of actions for a combined operator and preserves the selected package", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const scroll = vi.fn();
  Element.prototype.scrollIntoView = scroll;
  let pkg = structuredClone(value);
  let sourceApproved = false;
  const readiness = {
    generation: { available: true, translation: true },
    publishing: { available: false },
    channels: [],
  };
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      requests.push(url);
      if (url.endsWith("/history")) return Response.json({ history: [] });
      if (url.endsWith("/detail"))
        return Response.json({
          content: {
            id: "11111111-1111-4111-8111-111111111111",
            title: "Original QA master",
            language: "en",
            category: "other",
            isTest: true,
            revision: 3,
            state: sourceApproved ? "APPROVED" : "RIGHTS_CLEARED",
            currentVersion: {
              id: "22222222-2222-4222-8222-222222222222",
              masterId: "11111111-1111-4111-8111-111111111111",
              number: 1,
              sha256: "a".repeat(64),
              byteSize: 100,
              mimeType: "video/mp4",
              originalName: "qa.mp4",
              createdAt: value.createdAt,
              createdBy: "combined",
            },
            rights: {
              owner: "SGS",
              territories: ["WORLDWIDE"],
              channels: ["youtube"],
              authorizationBasis: "Original QA",
              privacyClass: "PUBLIC",
              releaseAt: null,
              expiresAt: null,
            },
            approval: sourceApproved
              ? {
                  versionId: "22222222-2222-4222-8222-222222222222",
                  reviewerId: "combined",
                  approvedRevision: 3,
                  approvedAt: value.createdAt,
                }
              : null,
            createdAt: value.createdAt,
            updatedAt: value.updatedAt,
          },
        });
      if (url.endsWith("/approve")) {
        sourceApproved = true;
        return (globalThis.fetch as typeof fetch)(url.replace(/approve$/, "detail"));
      }
      if (options?.method === "POST") {
        if (url.endsWith("/submit"))
          pkg = { ...pkg, status: "IN_REVIEW", revision: pkg.revision + 1 };
        if (url.endsWith("/review")) {
          if (!JSON.parse(String(options.body)).confirmTeachingIntegrity)
            return Response.json(
              { error: "TEACHING_INTEGRITY_CONFIRMATION_REQUIRED" },
              { status: 400 },
            );
          pkg = { ...pkg, status: "APPROVED", revision: pkg.revision + 1 };
        }
        return Response.json({ package: pkg });
      }
      if (url.includes("?")) return Response.json({ packages: [pkg], readiness });
      return Response.json({
        package: pkg,
        readiness,
        publications: [],
        blockers: sourceApproved ? [] : ["NOT_APPROVED"],
      });
    }),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const button = (name: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);
  try {
    await act(async () =>
      root.render(
        <StudioPanel
          initialPackageId={value.id}
          capabilities={["content.create", "content.review", "content.publish"]}
        />,
      ),
    );
    expect(button("Submit selected files for review")).toBeDefined();
    expect(button("Approve selected files")).toBeUndefined();
    expect(button("Run test publication")).toBeUndefined();
    await act(async () =>
      host.querySelector<HTMLInputElement>('input[name="submitOutput"]')?.click(),
    );
    await act(async () => button("Submit selected files for review")?.click());
    expect(host.textContent).toContain("Step 4 of 6");
    expect(host.querySelectorAll('section[aria-label="Content workflow"]')).toHaveLength(1);
    expect(button("Submit selected files for review")).toBeUndefined();
    expect(button("Approve selected files")).toBeDefined();
    expect(button("Approve selected files")?.disabled).toBe(true);
    await act(async () =>
      host.querySelector<HTMLInputElement>('input[name="reviewOutput"]')?.click(),
    );
    await act(async () => button("Approve master permissions")?.click());
    expect(button("Approve selected files")?.disabled).toBe(false);
    expect(button("Run test publication")).toBeUndefined();
    expect(host.querySelector('textarea[name="instructions"]')).toBeNull();
    await act(async () => button("Approve selected files")?.click());
    expect(document.activeElement?.getAttribute("role")).toBe("alert");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "confirm the review checkbox",
    );
    expect(button("Run test publication")).toBeUndefined();
    await act(async () => {
      host.querySelector<HTMLInputElement>('input[name="confirmTeachingIntegrity"]')?.click();
      button("Approve selected files")?.click();
    });
    expect(host.textContent).toContain("Step 6 of 6");
    expect(host.textContent).toContain("Approved and locked");
    expect(button("Approve selected files")).toBeUndefined();
    expect(button("Submit selected files for review")).toBeUndefined();
    expect(button("Run test publication")).toBeDefined();
    expect(document.activeElement?.id).toBe(`package-publishing-${value.id}`);
    expect(scroll).toHaveBeenCalled();
    expect(host.textContent).toContain("Test workspace — no videos will be posted");
    expect(requests.some((r) => r.endsWith("/publish"))).toBe(false);
    expect(requests.filter((r) => r.endsWith("/submit"))).toHaveLength(1);
    expect(requests.filter((r) => r.endsWith("/review"))).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
  }
});

it.each([true, false])(
  "allows language choices while missing rights block generation (service ready: %s)",
  async (available) => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const fetcher = vi.fn(async () =>
      Response.json({
        packages: [],
        readiness: {
          generation: { available, translation: available },
          publishing: { available: false },
          channels: [],
        },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          <StudioPanel
            capabilities={["content.create"]}
            content={{
              id: "master",
              title: "QA source",
              language: "te",
              category: "other",
              isTest: true,
              revision: 1,
              state: "DRAFT",
              currentVersion: {
                id: "version",
                masterId: "master",
                number: 1,
                sha256: "a".repeat(64),
                byteSize: 100,
                mimeType: "video/mp4",
                originalName: "qa.mp4",
                createdAt: value.createdAt,
                createdBy: "curator",
              },
              rights: null,
              approval: null,
              createdAt: value.createdAt,
              updatedAt: value.updatedAt,
            }}
          />,
        ),
      );
      const telugu = host.querySelector<HTMLInputElement>('input[name="language"][value="te"]');
      const english = host.querySelector<HTMLInputElement>('input[name="language"][value="en"]');
      expect(english?.checked).toBe(true);
      expect(telugu?.matches(":disabled")).toBe(false);
      await act(async () => telugu?.click());
      expect(telugu?.checked).toBe(true);
      expect(host.querySelector('textarea[name="instructions"]')?.matches(":disabled")).toBe(false);
      const form = telugu?.closest("form");
      expect(form?.querySelector('button[type="submit"]')?.matches(":disabled")).toBe(true);
      const calls = fetcher.mock.calls.length;
      await act(async () =>
        form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      expect(fetcher).toHaveBeenCalledTimes(calls);
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it("clears a transient progress failure after recovery without showing it as a failed action", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let fail = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (fail) throw Error("private diagnostic");
      return Response.json({
        packages: [],
        readiness: {
          generation: { available: true, translation: true },
          publishing: { available: false },
          channels: [],
        },
      });
    }),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<StudioPanel capabilities={["content.create"]} />));
    expect(host.textContent).toContain("Reconnecting automatically");
    expect(host.textContent).not.toContain("private diagnostic");
    fail = false;
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(host.textContent).not.toContain("Reconnecting automatically");
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});

it("refreshes queued series into visible section progress and warns on a stale connection", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let phase = "queued";
  const packages = Array.from({ length: 7 }, (_, index) => ({
    ...value,
    id: `job-${index}`,
    outputs: [],
    status: "QUEUED" as const,
    source: { ...value.source, masterId: `master-${index}`, title: `Recording ${index + 1}` },
  }));
  const fetcher = vi.fn(async (_url: string, options?: RequestInit) => {
    expect(options?.method ?? "GET").toBe("GET");
    if (phase === "failed") throw Error("private provider diagnostic");
    return Response.json({
      packages: packages.map((pkg, index) =>
        index === 0 && phase === "running"
          ? {
              ...pkg,
              status: "GENERATING",
              generationProgress: {
                phase: "reviewing",
                provider: "gemini",
                completed: 0,
                total: 1,
                discoverySection: 27,
                discoverySections: 29,
              },
            }
          : pkg,
      ),
      publications: [],
      readiness: {
        generation: { available: true, translation: true },
        publishing: { available: false },
        channels: [],
      },
    });
  });
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <StudioPanel
          capabilities={["content.create"]}
          bundle={{
            title: "Bhagavat Katha",
            playlistId: "series",
            totalRecordings: 7,
            masterIds: packages.map((pkg) => pkg.source.masterId),
          }}
        />,
      ),
    );
    expect(host.textContent).toContain("0 processing · 7 queued");
    phase = "running";
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    const progress = host.querySelector('[aria-label="Series generation progress"]');
    expect(progress?.closest("details")).toBeNull();
    expect(progress?.textContent).toContain("1 processing · 6 queued");
    expect(progress?.textContent).toContain("Recording 1");
    expect(progress?.textContent).toContain("Reviewing section 27 of 29");
    expect(progress?.textContent).not.toContain("0 of 1 steps");
    expect(progress?.querySelector("progress")?.value).toBe(26);
    expect(host.textContent).toContain("Last checked:");
    phase = "failed";
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(host.textContent).toContain("Displayed statuses may be out of date");
    expect(host.textContent).not.toContain("private provider diagnostic");
    expect(host.textContent).toContain("1 processing · 6 queued");
    phase = "running";
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "Refresh progress")
        ?.click(),
    );
    expect(host.textContent).not.toContain("Displayed statuses may be out of date");
    expect(host.textContent).toContain("1 processing · 6 queued");
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});
