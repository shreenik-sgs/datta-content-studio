// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { PublicStudioPublication } from "../lib/studio-model";
import { StudioProgressSummary } from "./studio-progress-summary";
import { value } from "./studio-workflow-fixture";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
it("shows mixed stages truthfully and stage navigation only filters, never approves", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onStep = vi.fn();
  try {
    await act(async () =>
      root.render(
        <StudioProgressSummary
          packages={[
            value,
            { ...value, id: "second", status: "IN_REVIEW" },
            { ...value, id: "third", status: "APPROVED" },
          ]}
          onStep={onStep}
          selectedStep={null}
        />,
      ),
    );
    const steps = [...host.querySelectorAll("li")];
    expect(steps[2]?.textContent).toContain("1 file");
    expect(steps[3]?.textContent).toContain("1 file");
    expect(steps[5]?.textContent).toContain("1 file");
    expect(host.textContent).not.toContain("Published");
    expect(onStep).not.toHaveBeenCalled();
    await act(async () => steps[3]?.querySelector("button")?.click());
    expect(onStep).toHaveBeenCalledWith(4);
  } finally {
    await act(async () => root.unmount());
  }
});

it("keeps unfinished imports visible without claiming the series completed generation", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(<StudioProgressSummary packages={[value]} totalRecordings={3} />),
    );
    expect(host.querySelectorAll("li")[1]?.textContent).toContain("2 waiting");
    expect(host.querySelectorAll("li")[1]?.className).not.toContain("workflow-done");
  } finally {
    await act(async () => root.unmount());
  }
});

it.each([
  { isTest: false, status: "PUBLISHED" as const, label: "Posted" },
  { isTest: true, status: "SIMULATED" as const, label: "Test complete" },
])(
  "marks the final stage done for $label without treating test delivery as live",
  async ({ isTest, status, label }) => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const publication: PublicStudioPublication = {
      id: "publication",
      packageId: value.id,
      packageRevision: value.revision,
      outputId: value.outputs[0]?.id ?? "",
      channel: "youtube",
      isTest,
      status,
      selectedAccountId: "guru",
      attempt: 1,
      error: null,
      remoteId: isTest ? null : "video",
      remoteUrl: null,
      createdAt: "2026-10-23T01:00:00Z",
      updatedAt: "2026-10-23T01:01:00Z",
    };
    try {
      await act(async () =>
        root.render(
          <StudioProgressSummary
            packages={[{ ...value, isTest, status: "APPROVED" }]}
            publications={[publication]}
          />,
        ),
      );
      const finalStep = host.querySelectorAll("li")[5];
      expect(finalStep?.className).toBe("workflow-done");
      expect(finalStep?.querySelector(".workflow-state")?.textContent).toBe(label);
      expect(host.querySelector(".workflow-current")).toBeNull();
      if (isTest) expect(finalStep?.textContent).not.toContain("Posted");
    } finally {
      await act(async () => root.unmount());
    }
  },
);
