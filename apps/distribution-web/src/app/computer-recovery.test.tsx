// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ComputerRecovery } from "./computer-recovery";
const bundle = "2eb8dfae-1493-4900-ab9c-a6e6d8813696";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
async function setup() {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<ComputerRecovery initialBundle={bundle} />));
  const button = (label: string) => {
    const found = [...host.querySelectorAll("button")].find((node) => node.textContent === label);
    if (!found) throw Error(`Missing ${label}`);
    return found;
  };
  const fill = async (selector: string, value: string) => {
    const field = host.querySelector(selector) as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  return { host, root, button, fill };
}
it("starts with explicit staging credentials, clears the password and only polls while active", async () => {
  vi.useFakeTimers();
  let state = { status: "IDLE", recordings: 0, completed: 0 };
  const commands: { action: string; password?: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, options) => {
      const command = JSON.parse(options.body);
      commands.push(command);
      if (command.action === "start") state = { status: "RUNNING", recordings: 7, completed: 2 };
      if (command.action === "stop") state = { ...state, status: "PAUSED" };
      return Response.json(state);
    }),
  );
  const f = await setup();
  try {
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(commands).toHaveLength(1);
    await f.fill('input[autocomplete="username"]', "Curator");
    await f.fill('input[type="password"]', "secret");
    await act(async () =>
      f
        .button("Start recovery")
        .closest("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(commands[1]).toEqual({ action: "start", username: "Curator", password: "secret" });
    expect(f.host.textContent).toContain("2 of 7");
    expect(f.host.textContent).not.toContain("secret");
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(commands.at(-1)?.action).toBe("status");
    await act(async () => f.button("Stop recovery").click());
    expect(f.host.textContent).toContain("completed recordings will be skipped");
    expect((f.host.querySelector('input[type="password"]') as HTMLInputElement).value).toBe("");
    const count = commands.length;
    await act(async () => vi.advanceTimersByTimeAsync(12000));
    expect(commands).toHaveLength(count);
  } finally {
    await act(async () => f.root.unmount());
  }
});
it("shows actionable sign-in failure without losing the playlist or leaking server details", async () => {
  let count = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        count++
          ? { error: "RECOVERY_LOGIN_FAILED" }
          : { status: "IDLE", recordings: 0, completed: 0 },
        { status: count === 1 ? 200 : 409 },
      ),
    ),
  );
  const f = await setup();
  try {
    await f.fill('input[autocomplete="username"]', "Curator");
    await f.fill('input[type="password"]', "bad");
    await act(async () =>
      f
        .button("Start recovery")
        .closest("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(f.host.textContent).toContain("not your Google password");
    expect(f.host.querySelector('a[target="_blank"]')?.getAttribute("href")).toContain(bundle);
  } finally {
    await act(async () => f.root.unmount());
  }
});
