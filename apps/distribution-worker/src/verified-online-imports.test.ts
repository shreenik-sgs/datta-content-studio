import { afterEach, expect, it, vi } from "vitest";
import { runOnlineImportLoop } from "./online-import-worker";
import { runVerifiedOnlineImports } from "./verified-online-imports";

vi.mock("./online-import-worker", () => ({ runOnlineImportLoop: vi.fn() }));
afterEach(() => vi.useRealTimers());

function fixture() {
  const abort = new AbortController();
  let lost = () => {};
  const client = {
    on: vi.fn((_event: string, callback: () => void) => {
      lost = callback;
    }),
    query: vi.fn().mockResolvedValue({ rows: [{ locked: true }] }),
    removeListener: vi.fn(),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn().mockResolvedValue(client) };
  const input = {
    repository: {} as never,
    store: {} as never,
    isTest: true,
    env: {},
    signal: abort.signal,
  };
  return { pool, client, input, abort, loseConnection: () => lost() };
}

it("stops after a failed runtime preflight instead of restarting verification indefinitely", async () => {
  const f = fixture();
  vi.mocked(runOnlineImportLoop).mockReset().mockResolvedValue(undefined);
  await runVerifiedOnlineImports(f.pool as never, f.input);
  expect(runOnlineImportLoop).toHaveBeenCalledTimes(1);
  expect(f.client.release).toHaveBeenCalledTimes(1);
});

it("still reacquires the leader lease after a lost database connection", async () => {
  vi.useFakeTimers();
  const f = fixture();
  vi.mocked(runOnlineImportLoop)
    .mockReset()
    .mockImplementationOnce(async () => f.loseConnection())
    .mockImplementationOnce(async () => f.abort.abort());
  const done = runVerifiedOnlineImports(f.pool as never, f.input);
  await vi.runAllTimersAsync();
  await done;
  expect(runOnlineImportLoop).toHaveBeenCalledTimes(2);
  expect(f.client.release).toHaveBeenCalledTimes(2);
});
