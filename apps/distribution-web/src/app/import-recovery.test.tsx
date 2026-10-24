// @vitest-environment jsdom
import type { ImportVerificationState } from "@satsang/distribution-contracts";
import type { OnlineImport } from "@satsang/distribution-domain";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ImportRecovery } from "./import-recovery";

const item = {
  id: "bundle",
  source: { provider: "youtube", kind: "bundle" },
  error: "ONLINE_PROVIDER_VERIFICATION_REQUIRED",
} as OnlineImport;
const opened: ImportVerificationState = {
  sessionId: "session",
  status: "OPEN",
  origin: "https://accounts.google.com",
  image: "data:image/jpeg;base64,AA==",
  expiresAt: "2026-10-18T12:00:00Z",
};
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
async function setup() {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onSaved = vi.fn(async () => undefined);
  await act(async () => root.render(<ImportRecovery item={item} items={[]} onSaved={onSaved} />));
  const button = (text: string) => {
    const found = [...host.querySelectorAll("button")].find((node) => node.textContent === text);
    if (!found) throw Error(`Missing button: ${text}`);
    return found;
  };
  return { host, root, onSaved, button };
}

it("preserves unfinished Google sign-in and explains the unsupported device prompt", async () => {
  vi.useFakeTimers();
  let state = opened;
  const fetcher = vi.fn(async () => Response.json(state));
  vi.stubGlobal("fetch", fetcher);
  const { host, root, button, onSaved } = await setup();
  try {
    await act(async () => button("Verify YouTube access").click());
    expect(host.textContent).toContain("Connecting to your device");
    expect(host.textContent).toContain("Try another way");
    expect(button("Finish Google sign-in to check access").disabled).toBe(true);
    await act(async () => button("Finish Google sign-in to check access").click());
    expect(fetcher).toHaveBeenCalledTimes(1);
    state = { ...opened, origin: "https://www.youtube.com" };
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(button("Check access and resume playlist").disabled).toBe(false);
    const checks = () =>
      fetcher.mock.calls.filter(
        (call) =>
          JSON.parse((call as unknown as [string, RequestInit])[1].body as string).action ===
          "check",
      );
    expect(checks()).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(checks()).toHaveLength(1);
    // Navigating back to YouTube is not proof of download access.
    expect(onSaved).not.toHaveBeenCalled();
    state = { ...state, status: "CHECKING" };
    await act(async () => button("Check access and resume playlist").click());
    expect(host.textContent).toContain("Downloading one recording to confirm access");
    expect(onSaved).not.toHaveBeenCalled();
    state = { ...state, status: "VERIFIED" };
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(onSaved).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
});

it("does not automatically dismiss or solve a YouTube challenge", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () =>
    Response.json({ ...opened, origin: "https://www.youtube.com" }),
  );
  vi.stubGlobal("fetch", fetcher);
  const { root, button, onSaved } = await setup();
  try {
    await act(async () => button("Verify YouTube access").click());
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    const actions = fetcher.mock.calls.map(
      (call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string).action,
    );
    expect(actions).toEqual(["start", "status", "status"]);
    expect(onSaved).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});

it("times out a stalled startup, re-enables retry and clears the error on recovery", async () => {
  vi.useFakeTimers();
  let stall = true;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, options: RequestInit) =>
      stall
        ? new Promise((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(Error("aborted")), {
              once: true,
            });
          })
        : Promise.resolve(Response.json(opened)),
    ),
  );
  const { host, root, button } = await setup();
  try {
    await act(async () => button("Verify YouTube access").click());
    expect(button("Opening verification…").disabled).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(75000));
    expect(host.textContent).toContain("verification connection timed out");
    expect(button("Verify YouTube access").disabled).toBe(false);
    stall = false;
    await act(async () => button("Verify YouTube access").click());
    expect(host.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it("clears a transient connection error after a successful poll", async () => {
  vi.useFakeTimers();
  let fail = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (fail) throw Error("offline");
      return Response.json(opened);
    }),
  );
  const { host, root, button } = await setup();
  try {
    await act(async () => button("Verify YouTube access").click());
    fail = true;
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(host.textContent).toContain("connection was interrupted");
    fail = false;
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(host.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});

it("serializes snapshots with close and aborts pending requests on unmount", async () => {
  vi.useFakeTimers();
  let resolveStatus: ((response: Response) => void) | undefined;
  let statusSignal: AbortSignal | null | undefined;
  const commands: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, options: RequestInit) => {
      const command = JSON.parse(options.body as string).action;
      commands.push(command);
      if (command === "status") {
        statusSignal = options.signal;
        return new Promise<Response>((resolve, reject) => {
          resolveStatus = resolve;
          options.signal?.addEventListener("abort", () => reject(Error("aborted")), { once: true });
        });
      }
      return Response.json(command === "cancel" ? { ...opened, status: "CLOSED" } : opened);
    }),
  );
  const { host, root, button } = await setup();
  try {
    await act(async () => button("Verify YouTube access").click());
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    await act(async () => button("Close verification").click());
    expect(commands).toEqual(["start", "status"]);
    await act(async () => resolveStatus?.(Response.json(opened)));
    expect(commands).toEqual(["start", "status", "cancel"]);
    expect(host.textContent).not.toContain("Finish Google sign-in here");
    await act(async () => button("Verify YouTube access").click());
    await act(async () => vi.advanceTimersByTimeAsync(2000));
  } finally {
    await act(async () => root.unmount());
  }
  expect(statusSignal?.aborted).toBe(true);
});
