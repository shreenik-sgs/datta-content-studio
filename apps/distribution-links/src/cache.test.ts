import { generateKeyPairSync } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSignedLinkCachePublisher, createSignedLinkCacheReader } from "./cache";
import { trackedFixture } from "./test-fixtures";
const key = generateKeyPairSync("ed25519");
const privateKeyPem = key.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKeyPem = key.publicKey.export({ type: "spki", format: "pem" }).toString();
let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  root = await mkdtemp(join(realpathSync(tmpdir()), "distribution-links-"));
  return {
    publisher: createSignedLinkCachePublisher({ root, keyId: "local-v1", privateKeyPem }),
    reader: createSignedLinkCacheReader({ root, publicKeys: { "local-v1": publicKeyPem } }),
  };
}
describe("DS-DIST-R4 signed independent cache", () => {
  it("DS-DIST-R4-CACHE validates signed records across reader restart without DB or Hub", async () => {
    const { publisher, reader } = await fixture();
    await publisher.publish(trackedFixture);
    expect(await reader.read(trackedFixture.token)).toEqual(trackedFixture);
    expect(
      await createSignedLinkCacheReader({ root, publicKeys: { "local-v1": publicKeyPem } }).read(
        trackedFixture.token,
      ),
    ).toEqual(trackedFixture);
    const wrong = generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
    expect(
      await createSignedLinkCacheReader({ root, publicKeys: { "local-v1": wrong } }).read(
        trackedFixture.token,
      ),
    ).toBeNull();
    await expect(
      publisher.publish({
        ...trackedFixture,
        cta: {
          ...trackedFixture.cta,
          approval: {
            decision: "APPROVED",
            revision: 2,
            reviewedAt: trackedFixture.checkedAt,
            reviewerId: "person@example.test",
          },
        },
      }),
    ).rejects.toThrow();
    expect(await reader.read("../outside")).toBeNull();
    expect(await reader.read("B".repeat(43))).toBeNull();
  });
  it("DS-DIST-R4-CACHE refuses altered body, wrong keys, links and public cache permissions", async () => {
    const { publisher, reader } = await fixture();
    await publisher.publish(trackedFixture);
    const [folder] = await readdir(root);
    if (!folder) throw new Error("TEST_FOLDER_MISSING");
    const files = await readdir(join(root, folder));
    const name = files.find((file) => /^\d/.test(file));
    if (!name) throw new Error("TEST_SNAPSHOT_MISSING");
    const path = join(root, folder, name);
    const original = await readFile(path, "utf8");
    const changed = JSON.parse(original);
    changed.payload.cta.destination.path = "/practice/other";
    await writeFile(path, JSON.stringify(changed));
    expect(await reader.read(trackedFixture.token)).toBeNull();
    await rm(path);
    await symlink(join(root, folder, "binding.json"), path);
    expect(await reader.read(trackedFixture.token)).toBeNull();
    await rm(path);
    await writeFile(path, original, { mode: 0o600 });
    await chmod(root, 0o755);
    expect(await reader.read(trackedFixture.token)).toBeNull();
  });
  it("DS-DIST-R4-STOP terminal tombstone defeats concurrent late ACTIVE and cannot change the promise", async () => {
    const { publisher, reader } = await fixture();
    await publisher.publish(trackedFixture);
    const stopped = { ...trackedFixture, sequence: 3, status: "STOPPED" as const };
    await Promise.allSettled([
      publisher.publish({ ...trackedFixture, sequence: 4 }),
      publisher.publish(stopped),
      publisher.publish({ ...trackedFixture, sequence: 2 }),
    ]);
    expect((await reader.read(trackedFixture.token))?.status).toBe("STOPPED");
    await expect(publisher.publish({ ...trackedFixture, sequence: 5 })).rejects.toThrow(
      "LINK_TERMINAL",
    );
    await expect(
      publisher.publish({ ...stopped, sequence: 6, title: "Changed promise" }),
    ).rejects.toThrow("LINK_BINDING_CHANGED");
  });
  it("DS-DIST-R4-CACHE handles duplicate delivery and keeps the largest sequence despite out-of-order writes", async () => {
    const { publisher, reader } = await fixture();
    await publisher.publish(trackedFixture);
    await publisher.publish(trackedFixture);
    await Promise.all([
      publisher.publish({ ...trackedFixture, sequence: 4 }),
      publisher.publish({ ...trackedFixture, sequence: 2 }),
      publisher.publish({ ...trackedFixture, sequence: 3 }),
    ]);
    expect((await reader.read(trackedFixture.token))?.sequence).toBe(4);
    await expect(
      publisher.publish({ ...trackedFixture, sequence: 4, destinationAvailable: false }),
    ).rejects.toThrow("LINK_SEQUENCE_CONFLICT");
    await expect(
      publisher.publish({ ...trackedFixture, isTest: false } as never),
    ).rejects.toThrow();
  });
});
