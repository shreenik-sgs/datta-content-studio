import {
  type KeyObject,
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import { constants, existsSync } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import {
  type SignedTrackedLinkRecord,
  signedTrackedLinkRecordSchema,
  trackedLinkRecordSchema,
  trackedLinkTokenSchema,
} from "@satsang/distribution-contracts";
import type { TrackedLinkRecord } from "@satsang/distribution-domain";
const MAX_BYTES = 32768;
function canonical(value: unknown): string {
  const ordered = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(ordered)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, child]) => [key, ordered(child)]),
          )
        : value;
  return JSON.stringify(ordered(value));
}
function binding(record: TrackedLinkRecord): string {
  const {
    sequence: _sequence,
    checkedAt: _checked,
    status: _status,
    destinationAvailable: _available,
    fallbackReason: _reason,
    ...immutable
  } = record;
  return canonical(immutable);
}
function validateRoot(root: string): void {
  if (
    !isAbsolute(root) ||
    resolve(root) !== root ||
    root === parse(root).root ||
    root
      .split(sep)
      .some((part) => ["public", "static", "node_modules", ".next", ".git"].includes(part))
  )
    throw new Error("PRIVATE_LINK_CACHE_REQUIRED");
  let cursor = root;
  while (cursor !== dirname(cursor)) {
    if (existsSync(join(cursor, ".git"))) throw new Error("PRIVATE_LINK_CACHE_REQUIRED");
    cursor = dirname(cursor);
  }
}
async function noSymlinks(path: string): Promise<void> {
  let cursor = parse(path).root;
  for (const component of path.slice(cursor.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error("LINK_CACHE_SYMLINK");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
async function directory(path: string, create: boolean): Promise<void> {
  await noSymlinks(path);
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0)
    throw new Error("PRIVATE_LINK_CACHE_REQUIRED");
}
async function bytes(path: string): Promise<Buffer> {
  await noSymlinks(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES || (stat.mode & 0o077) !== 0)
      throw new Error("INVALID_LINK_CACHE_FILE");
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (offset !== stat.size) throw new Error("INVALID_LINK_CACHE_FILE");
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}
async function optionalBytes(path: string): Promise<Buffer | null> {
  try {
    return await bytes(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function publicKey(pem: string): KeyObject {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("ED25519_KEY_REQUIRED");
  return key;
}
function keyMap(values: Record<string, string>): Map<string, KeyObject> {
  const entries = Object.entries(values);
  if (entries.length < 1 || entries.length > 8) throw new Error("INVALID_LINK_KEYS");
  return new Map(
    entries.map(([id, pem]) => {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error("INVALID_LINK_KEY_ID");
      return [id, publicKey(pem)];
    }),
  );
}
function decode(buffer: Buffer, keys: Map<string, KeyObject>, token: string): TrackedLinkRecord {
  const envelope = signedTrackedLinkRecordSchema.parse(JSON.parse(buffer.toString("utf8")));
  const key = keys.get(envelope.keyId);
  if (
    !key ||
    envelope.payload.token !== token ||
    !verify(
      null,
      Buffer.from(canonical(envelope.payload)),
      key,
      Buffer.from(envelope.signature, "base64url"),
    )
  )
    throw new Error("INVALID_LINK_SIGNATURE");
  return envelope.payload;
}
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const filename = (sequence: number) => `${String(sequence).padStart(16, "0")}.json`;
async function sequenceFiles(folder: string): Promise<string[]> {
  const entries = await readdir(folder);
  if (entries.length > 4096) throw new Error("LINK_CACHE_ENTRY_LIMIT");
  return entries
    .filter((file) => /^\d{16}\.json$/.test(file))
    .sort()
    .reverse();
}
/** Immutable atomic files make late writes harmless; no in-process concurrency fence is trusted. */
async function writeOnce(path: string, value: Buffer): Promise<void> {
  const temporary = join(dirname(path), `.pending-${randomUUID()}`);
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(value);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!(await bytes(path)).equals(value)) throw new Error("LINK_SEQUENCE_CONFLICT");
  } finally {
    await unlink(temporary);
  }
}
export function createSignedLinkCachePublisher(options: {
  root: string;
  privateKeyPem: string;
  keyId: string;
  publicKeys?: Record<string, string>;
}) {
  const { root, keyId } = options;
  validateRoot(root);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(keyId)) throw new Error("INVALID_LINK_KEY_ID");
  const privateKey = createPrivateKey(options.privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("ED25519_KEY_REQUIRED");
  const keys = keyMap({
    ...options.publicKeys,
    [keyId]: createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString(),
  });
  return {
    async publish(input: TrackedLinkRecord): Promise<void> {
      const record = trackedLinkRecordSchema.parse(input);
      await directory(root, true);
      const folder = join(root, hashToken(record.token));
      await directory(folder, true);
      const envelope: SignedTrackedLinkRecord = {
        keyId,
        payload: record,
        signature: sign(null, Buffer.from(canonical(record)), privateKey).toString("base64url"),
      };
      const encoded = Buffer.from(canonical(envelope));
      if (encoded.length > MAX_BYTES) throw new Error("LINK_CACHE_BYTE_LIMIT");
      const bindingPath = join(folder, "binding.json");
      let original = await optionalBytes(bindingPath);
      if (!original) {
        try {
          await writeOnce(bindingPath, encoded);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "LINK_SEQUENCE_CONFLICT") throw error;
        }
        original = await bytes(bindingPath);
      }
      if (binding(decode(original, keys, record.token)) !== binding(record))
        throw new Error("LINK_BINDING_CHANGED");
      const terminal = await optionalBytes(join(folder, "terminal.json"));
      if (terminal) {
        const terminalRecord = decode(terminal, keys, record.token);
        if (binding(terminalRecord) !== binding(record)) throw new Error("LINK_BINDING_CHANGED");
        if (record.status === "ACTIVE") throw new Error("LINK_TERMINAL");
        return;
      }
      if (record.status !== "ACTIVE") {
        // First terminal record wins forever; later ACTIVE deliveries cannot reopen it.
        try {
          await writeOnce(join(folder, "terminal.json"), encoded);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "LINK_SEQUENCE_CONFLICT") throw error;
        }
      }
      await writeOnce(join(folder, filename(record.sequence)), encoded);
      // Keep the newest two immutable status files. Binding and terminal are never removed.
      for (const name of (await sequenceFiles(folder)).slice(2)) {
        try {
          await unlink(join(folder, name));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    },
  };
}
export function createSignedLinkCacheReader(options: {
  root: string;
  publicKeys: Record<string, string>;
}) {
  const { root } = options;
  validateRoot(root);
  const keys = keyMap({ ...options.publicKeys });
  return {
    async read(token: string): Promise<TrackedLinkRecord | null> {
      if (!trackedLinkTokenSchema.safeParse(token).success) return null;
      try {
        await directory(root, false);
        const folder = join(root, hashToken(token));
        await directory(folder, false);
        const original = decode(await bytes(join(folder, "binding.json")), keys, token);
        const checked = (value: Buffer) => {
          const record = decode(value, keys, token);
          if (binding(record) !== binding(original)) throw new Error("LINK_BINDING_CHANGED");
          return record;
        };
        const terminal = await optionalBytes(join(folder, "terminal.json"));
        if (terminal) {
          const record = checked(terminal);
          if (record.status === "ACTIVE") return null;
          return record;
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          const latest = (await sequenceFiles(folder))[0];
          if (!latest) return null;
          const value = await optionalBytes(join(folder, latest));
          if (!value) continue;
          const record = checked(value);
          if (filename(record.sequence) !== latest) return null;
          const stopped = await optionalBytes(join(folder, "terminal.json"));
          if (stopped) {
            const value = checked(stopped);
            return value.status !== "ACTIVE" ? value : null;
          }
          return record;
        }
        return null;
      } catch {
        return null;
      }
    },
  };
}
