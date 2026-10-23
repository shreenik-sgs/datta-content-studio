// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceName } from "./workspace-name";
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
it("saves only the organizing name, retains the current name on failure, and can cancel", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ error: "WORKSPACE_NAME_CONFLICT" }, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ item: { id: "source", title: "New name" } }));
  vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const saved = vi.fn();
  try {
    await act(async () =>
      root.render(
        <WorkspaceName
          kind="import"
          id="source"
          title="Original name"
          name={null}
          onSaved={saved}
        />,
      ),
    );
    await act(async () => host.querySelector<HTMLButtonElement>("button")?.click());
    const input = host.querySelector<HTMLInputElement>("input");
    if (!input) throw Error("name field");
    input.value = "New name";
    await act(async () =>
      host
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(host.textContent).toContain("changed in another session");
    expect(saved).not.toHaveBeenCalled();
    expect(input.value).toBe("New name");
    await act(async () =>
      host
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(JSON.parse(fetcher.mock.calls[0]?.[1].body)).toEqual({
      action: "rename",
      id: "source",
      name: "New name",
      expectedName: null,
    });
    expect(saved).toHaveBeenCalledOnce();
    expect(host.querySelector("form")).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>("button")?.click());
    await act(async () =>
      Array.from(host.querySelectorAll("button"))
        .find((b) => b.textContent === "Cancel")
        ?.click(),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(host.querySelector("form")).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
