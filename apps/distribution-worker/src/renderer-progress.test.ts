import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { studioRenderBudget } from "./studio-render-budget";

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocked.spawn }));
import { runIsolatedMediaProcess } from "./renderer";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
function start(
  options: { deadlineMs?: number; progressTimeoutMs?: number; signal?: AbortSignal } = {},
) {
  const process = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const progress = new PassThrough();
  const kill = vi.fn(() => {
    process.emit("close", null);
    return true;
  });
  Object.assign(process, {
    stdout,
    stderr,
    stdio: [null, stdout, stderr, null, null, progress],
    kill,
  });
  mocked.spawn.mockReturnValueOnce(process);
  const result = runIsolatedMediaProcess({
    executable: "/usr/bin/ffmpeg",
    args: ["-progress", "pipe:5"],
    cwd: "/tmp",
    deadline: Date.now() + (options.deadlineMs ?? 1000),
    progressTimeoutMs: options.progressTimeoutMs ?? 100,
    ...(options.signal ? { signal: options.signal } : {}),
  }).catch((error: Error) => error.message);
  return { process, progress, stdout, kill, result };
}
it("allows sustained slow encoding and keeps progress separate from process output", async () => {
  const child = start();
  child.stdout.write("result");
  for (let frame = 1; frame <= 8; frame++) {
    await vi.advanceTimersByTimeAsync(80);
    // FFmpeg records may arrive split across chunks.
    child.progress.write("fra");
    child.progress.write(`me=${frame}\nout_time_us=${frame * 1000}\nprogress=continue\n`);
  }
  child.process.emit("close", 0);
  expect(await child.result).toBe("result");
  expect(child.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2000);
  expect(child.kill).not.toHaveBeenCalled();
  expect(mocked.spawn.mock.calls[0]?.[2].stdio[5]).toBe("pipe");
});
it("stops a stalled encoder even if it repeats progress messages", async () => {
  const child = start();
  child.progress.write("frame=1\nout_time_us=100\n");
  await vi.advanceTimersByTimeAsync(60);
  child.progress.write("frame=1\nout_time_us=100\nprogress=continue\n");
  await vi.advanceTimersByTimeAsync(40);
  expect(await child.result).toBe("RENDER_STALLED");
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
});
it("bounds startup without any progress and rejects a flooding progress stream", async () => {
  const waiting = start();
  await vi.advanceTimersByTimeAsync(100);
  expect(await waiting.result).toBe("RENDER_STALLED");
  const flooding = start();
  flooding.progress.write("x".repeat(65537));
  expect(await flooding.result).toBe("RENDER_PROCESS_OUTPUT_LIMIT");
});
it("enforces the hard deadline even when frames keep advancing", async () => {
  const child = start({ deadlineMs: 250 });
  for (let frame = 1; frame <= 3; frame++) {
    await vi.advanceTimersByTimeAsync(80);
    child.progress.write(`frame=${frame}\n`);
  }
  await vi.advanceTimersByTimeAsync(10);
  expect(await child.result).toBe("RENDER_TIMEOUT");
});
it("cancels active encoding and removes its watchdogs", async () => {
  const stop = new AbortController();
  const child = start({ signal: stop.signal });
  stop.abort();
  expect(await child.result).toBe("RENDER_CANCELLED");
  await vi.advanceTimersByTimeAsync(2000);
  expect(child.kill).toHaveBeenCalledTimes(1);
});
it("allows long portrait encoding but retains a bounded overall runtime", () => {
  expect(studioRenderBudget(10000).timeoutMs).toBe(600000);
  expect(studioRenderBudget(120000).timeoutMs).toBe(3600000);
  expect(studioRenderBudget(600000).timeoutMs).toBe(18000000);
  expect(studioRenderBudget(1800000).timeoutMs).toBe(54000000);
  expect(studioRenderBudget(Number.MAX_SAFE_INTEGER).timeoutMs).toBe(54000000);
  expect(studioRenderBudget(120000).progressTimeoutMs).toBe(300000);
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])
    expect(() => studioRenderBudget(value)).toThrow("RENDER_DURATION_LIMIT");
});
it("lets an advancing complete-story render finish after an hour without removing the watchdog", async () => {
  const budget = studioRenderBudget(923000);
  const child = start({
    deadlineMs: budget.timeoutMs,
    progressTimeoutMs: budget.progressTimeoutMs,
  });
  for (let frame = 1; frame <= 16; frame++) {
    await vi.advanceTimersByTimeAsync(240000);
    child.progress.write(`frame=${frame}\n`);
  }
  expect(child.kill).not.toHaveBeenCalled();
  child.process.emit("close", 0);
  expect(await child.result).toBe("");

  const stalled = start({
    deadlineMs: budget.timeoutMs,
    progressTimeoutMs: budget.progressTimeoutMs,
  });
  stalled.progress.write("frame=1\n");
  await vi.advanceTimersByTimeAsync(300000);
  expect(await stalled.result).toBe("RENDER_STALLED");
});
