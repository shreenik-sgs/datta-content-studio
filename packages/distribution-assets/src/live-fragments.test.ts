import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createLiveFragmentStore } from "./live-fragments";
const directories: string[] = [];
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "live-fragments-test-"));
  directories.push(root);
  return { root, store: createLiveFragmentStore({ backend: "local", root }) };
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const key = "distribution/live/11111111-1111-4111-8111-111111111111/42.ts";
const bytes = Buffer.concat([Buffer.from([0x47]), Buffer.alloc(187, 1)]);
it("publishes complete immutable fragments, tolerates repeat capture and removes consumed bytes", async () => {
  const { root, store } = await setup();
  const values = await Promise.all(Array.from({ length: 4 }, () => store.write(key, bytes)));
  expect(new Set(values.map((v) => v.sha256)).size).toBe(1);
  expect(
    await store.read(
      values[0] ??
        (() => {
          throw Error("missing fixture");
        })(),
    ),
  ).toEqual(bytes);
  expect(await readFile(join(root, key))).toEqual(bytes);
  expect(
    await readdir(join(root, "distribution/live/11111111-1111-4111-8111-111111111111")),
  ).toEqual(["42.ts"]);
  await expect(store.write(key, Buffer.concat([bytes, bytes]))).rejects.toThrow(
    "LIVE_FRAGMENT_CHANGED",
  );
  await store.remove(
    values[0] ??
      (() => {
        throw Error("missing fixture");
      })(),
  );
  await store.remove(
    values[0] ??
      (() => {
        throw Error("missing fixture");
      })(),
  );
});
it("detects damaged bytes rather than ingesting a truncated recording", async () => {
  const { root, store } = await setup();
  const asset = await store.write(key, bytes);
  await writeFile(join(root, key), Buffer.from([0x47]));
  await expect(store.read(asset)).rejects.toThrow("LIVE_FRAGMENT_CHANGED");
});
it("rejects traversal, wrong formats and linked directory escapes", async () => {
  const { root, store } = await setup();
  await expect(store.write("../capture.ts", bytes)).rejects.toThrow("INVALID_LIVE_FRAGMENT");
  await expect(store.write(key, Buffer.from("not transport stream"))).rejects.toThrow();
  const outside = await mkdtemp(join(tmpdir(), "live-outside-"));
  directories.push(outside);
  await symlink(outside, join(root, "distribution"));
  await expect(store.write(key, bytes)).rejects.toThrow("INVALID_ASSET_ROOT");
  expect(await readdir(outside)).toEqual([]);
});
