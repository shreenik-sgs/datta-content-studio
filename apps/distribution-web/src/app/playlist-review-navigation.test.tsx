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

for (const completed of [false, true]) {
  it.each([
    ["content.create"],
    ["content.review", "content.publish"],
    ["content.create", "content.review", "content.publish"],
  ] as const)(
    `keeps playlist order and excludes earlier curations for roles %j (completed library: ${completed})`,
    async (...roles) => {
      vi.stubGlobal("React", React);
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const base = { ...value, status: completed ? ("APPROVED" as const) : ("DRAFT" as const) };
      const first = { ...base, id: "first" };
      const second = { ...base, id: "second", source: { ...value.source, masterId: "master-two" } };
      const old = { ...value, id: "unrelated-earlier-curation" };
      const readiness = {
        generation: { available: true, translation: true },
        publishing: { available: false },
        channels: [],
      };
      const requests = vi.fn(async (url: string, options?: RequestInit) => {
        expect(options?.method ?? "GET").toBe("GET");
        if (url.includes("?")) return Response.json({ packages: [second, old, first], readiness });
        if (url.endsWith("/history")) return Response.json({ history: [] });
        return Response.json({
          package: url.endsWith("/second") ? second : first,
          readiness,
          publications: [],
          blockers: [],
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
              capabilities={roles}
              {...(completed ? { scope: "complete" as const } : {})}
              bundle={{
                title: "Playlist",
                masterIds: ["master-one", "master-two"],
                packageIds: [first.id, second.id],
              }}
              initialPackageId={first.id}
            />,
          ),
        );
        const select = host.querySelector<HTMLSelectElement>(
          'select[aria-label="Recording in bundle"]',
        );
        expect([...(select?.options ?? [])].map((option) => option.value)).toEqual([
          first.id,
          second.id,
        ]);
        expect(host.textContent).toContain("Recording 1 of 2");
        expect(host.querySelector('option[value="unrelated-earlier-curation"]')).toBeNull();
        const next = [...host.querySelectorAll("button")].find((button) =>
          button.textContent?.includes("Next recording"),
        );
        await act(async () => next?.click());
        expect(host.textContent).toContain("Recording 2 of 2");
        expect(select?.value).toBe(second.id);
        expect(next?.disabled).toBe(true);
        expect(host.querySelectorAll('[aria-label="Content workflow"]')).toHaveLength(
          completed ? 0 : 1,
        );
        expect(
          requests.mock.calls.some(([url]) => url.endsWith("/unrelated-earlier-curation")),
        ).toBe(false);
      } finally {
        await act(async () => root.unmount());
      }
    },
  );
}
