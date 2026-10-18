import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { socialLinkReceiptSchema } from "@satsang/distribution-contracts";
import type { SocialLinkReceipt } from "@satsang/distribution-domain";
const MAX_BYTES = 4096;
const RETENTION_MS = 7 * 86400000;
/** A local durable delivery queue into the existing core event pipeline, not another analytics store. */
export function createSocialEventOutbox(input: {
  root: string;
  coreOrigin: string;
  key: string;
  fetcher?: typeof fetch;
  now?: () => number;
}) {
  const origin = new URL(input.coreOrigin);
  if (
    origin.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) ||
    origin.port !== "3020" ||
    origin.pathname !== "/" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    throw new Error("LOCAL_CORE_REQUIRED");
  if (input.key.length < 32 || input.key.length > 200 || /\s/.test(input.key))
    throw new Error("DESTINATION_KEY_REQUIRED");
  if (
    !isAbsolute(input.root) ||
    resolve(input.root) !== input.root ||
    input.root === parse(input.root).root ||
    input.root
      .split("/")
      .some((part) => ["public", "static", ".git", "node_modules"].includes(part))
  )
    throw new Error("PRIVATE_EVENT_OUTBOX_REQUIRED");
  const now = input.now ?? Date.now;
  const fetcher = input.fetcher ?? fetch;
  async function directory() {
    let cursor = input.root;
    while (cursor !== dirname(cursor)) {
      if (existsSync(join(cursor, ".git"))) throw new Error("PRIVATE_EVENT_OUTBOX_REQUIRED");
      try {
        if ((await lstat(cursor)).isSymbolicLink())
          throw new Error("PRIVATE_EVENT_OUTBOX_REQUIRED");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      cursor = dirname(cursor);
    }
    await mkdir(input.root, { recursive: true, mode: 0o700 });
    const info = await lstat(input.root);
    if (!info.isDirectory() || (info.mode & 0o077) !== 0)
      throw new Error("PRIVATE_EVENT_OUTBOX_REQUIRED");
  }
  async function read(path: string) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size < 1 || info.size > MAX_BYTES || (info.mode & 0o077) !== 0)
        throw new Error("INVALID_EVENT_RECEIPT");
      return socialLinkReceiptSchema.parse(JSON.parse(await file.readFile("utf8")));
    } finally {
      await file.close();
    }
  }
  async function remove(path: string) {
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return {
    async enqueue(value: SocialLinkReceipt): Promise<void> {
      const receipt = socialLinkReceiptSchema.parse(value);
      const bytes = Buffer.from(JSON.stringify(receipt));
      if (bytes.length > MAX_BYTES || Math.abs(now() - Date.parse(receipt.occurredAt)) > 300000)
        throw new Error("INVALID_EVENT_RECEIPT");
      await directory();
      if ((await readdir(input.root)).length >= 10000) throw new Error("EVENT_OUTBOX_FULL");
      const path = join(input.root, `${receipt.id}.json`);
      const temporary = join(input.root, `.${receipt.id}-${randomUUID()}.pending`);
      const file = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (JSON.stringify(await read(path)) !== JSON.stringify(receipt))
          throw new Error("IDEMPOTENCY_CONFLICT");
      } finally {
        await remove(temporary);
      }
    },
    async drainOnce(): Promise<{ delivered: number; pending: number }> {
      await directory();
      const names = (await readdir(input.root))
        .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
        .sort();
      let delivered = 0;
      for (const name of names.slice(0, 25)) {
        const path = join(input.root, name);
        try {
          const receipt = await read(path);
          if (now() - Date.parse(receipt.occurredAt) > RETENTION_MS) {
            await remove(path);
            continue;
          }
          const response = await fetcher(`${origin.origin}/api/v1/content/events/internal`, {
            method: "POST",
            redirect: "error",
            headers: { "content-type": "application/json", authorization: `Bearer ${input.key}` },
            body: JSON.stringify(receipt),
            signal: AbortSignal.timeout(2000),
          });
          await response.body?.cancel();
          if (!response.ok) break;
          await remove(path);
          delivered++;
        } catch {
          break;
        }
      }
      return {
        delivered,
        pending: (await readdir(input.root)).filter((name) => name.endsWith(".json")).length,
      };
    },
  };
}
