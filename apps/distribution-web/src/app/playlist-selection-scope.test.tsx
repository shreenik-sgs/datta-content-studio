// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PlaylistFiles } from "./playlist-files";
import { value } from "./studio-workflow-fixture";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const output = value.outputs[0];
if (!output) throw Error("Expected a fixture output");
const recording = {
  ...value,
  outputs: [
    { ...output, id: "first", title: "First teaching" },
    { ...output, id: "second", title: "Second teaching", channel: "facebook" as const },
    { ...output, id: "excluded", title: "Excluded teaching", included: false },
  ],
};

function setup() {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const checkbox = (title: string) => {
    const element = host.querySelector<HTMLInputElement>(`input[aria-label="Select ${title}"]`);
    if (!element) throw Error(`Missing ${title} checkbox`);
    return element;
  };
  async function action(next: string) {
    const control = host.querySelector<HTMLSelectElement>('select[aria-label="File action"]');
    if (!control) throw Error("Missing action selector");
    await act(async () => {
      control.value = next;
      control.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }
  return { host, root, fetcher, checkbox, action };
}

it.each(["curator", "approver"] as const)(
  "selects only the chosen file for %s and makes no server requests",
  async (role) => {
    const { host, root, fetcher, checkbox } = setup();
    try {
      await act(async () =>
        root.render(
          <PlaylistFiles
            packages={[{ ...recording, status: role === "curator" ? "DRAFT" : "IN_REVIEW" }]}
            canCurate={role === "curator"}
            canReview={role === "approver"}
            onRefresh={vi.fn().mockResolvedValue(undefined)}
            onOpen={vi.fn()}
            onPreview={vi.fn()}
          />,
        ),
      );
      const options = [
        ...host.querySelectorAll<HTMLOptionElement>('select[aria-label="File action"] option'),
      ].map((option) => option.value);
      expect(options).toEqual([role === "curator" ? "submit" : "approve"]);
      await act(async () => checkbox("First teaching").click());
      expect(checkbox("First teaching").checked).toBe(true);
      expect(checkbox("Second teaching").checked).toBe(false);
      expect(checkbox("Excluded teaching").checked).toBe(false);
      expect(checkbox("Excluded teaching").disabled).toBe(true);
      expect(host.querySelectorAll('tr[data-selected="true"]')).toHaveLength(1);
      expect(host.textContent).toContain("1 file selected");
      await act(async () => checkbox("Second teaching").click());
      expect(checkbox("First teaching").checked).toBe(true);
      expect(checkbox("Second teaching").checked).toBe(true);
      await act(async () => checkbox("First teaching").click());
      expect(checkbox("Second teaching").checked).toBe(true);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it("preserves the same individual selection when switching approval, posting and retraction", async () => {
  const { host, root, fetcher, checkbox, action } = setup();
  try {
    await act(async () =>
      root.render(
        <PlaylistFiles
          packages={[{ ...recording, status: "APPROVED" }]}
          canReview
          canPublish
          onRefresh={vi.fn().mockResolvedValue(undefined)}
          onOpen={vi.fn()}
          onPreview={vi.fn()}
        />,
      ),
    );
    expect(host.querySelector<HTMLSelectElement>('select[aria-label="File action"]')?.value).toBe(
      "post",
    );
    await act(async () => checkbox("First teaching").click());
    expect(checkbox("Second teaching").checked).toBe(false);
    await action("approve");
    expect(checkbox("Second teaching").checked).toBe(false);
    expect(host.textContent).toContain("Other files from the same day stay unchanged");
    await action("post");
    expect(checkbox("First teaching").checked).toBe(true);
    expect(checkbox("Second teaching").checked).toBe(false);
    await action("retract");
    await act(async () => checkbox("Second teaching").click());
    await act(async () => checkbox("First teaching").click());
    expect(checkbox("First teaching").checked).toBe(false);
    expect(checkbox("Second teaching").checked).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});

it("excludes filtered-out siblings from select all and offers no action controls without a curation role", async () => {
  const { host, root, fetcher } = setup();
  const props = {
    packages: [recording],
    onRefresh: vi.fn().mockResolvedValue(undefined),
    onOpen: vi.fn(),
    onPreview: vi.fn(),
  };
  try {
    await act(async () => root.render(<PlaylistFiles {...props} canCurate />));
    const filter = host.querySelector<HTMLSelectElement>(
      'select[aria-label="Playlist file channel"]',
    );
    if (!filter) throw Error("Missing channel filter");
    await act(async () => {
      filter.value = "facebook";
      filter.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () =>
      host.querySelector<HTMLInputElement>('input[aria-label="Select all visible files"]')?.click(),
    );
    expect(host.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(host.textContent).toContain("1 file selected");
    expect(host.textContent).toContain("header checkbox selects all files shown by your filters");
    await act(async () => root.render(<PlaylistFiles {...props} />));
    expect(host.querySelector('[aria-label="File actions"]')).toBeNull();
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});
