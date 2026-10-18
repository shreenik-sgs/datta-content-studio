import { randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { link, lstat, mkdir, open, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { MAX_ONLINE_MASTER_BYTES, validateMasterUpload } from "@satsang/distribution-domain";
import { copyVerifiedMaster, inspectMasterFile } from "./master-files";
import {
  type DerivedPrivateAsset,
  type PrivateAssetStore,
  type StoredPrivateAsset,
  checksum,
  validateAsset,
  validateDerived,
  validateDerivedBytes,
  validateFilename,
  verifyBytes,
} from "./validation";

const verifiedMasters = new Map<string, string>();
const within = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
};
function repositoryRoot(start: string): string | null {
  let path = resolve(start);
  while (true) {
    if (existsSync(join(path, ".git"))) return path;
    const parent = dirname(path);
    if (parent === path) return null;
    path = parent;
  }
}
function validateRoot(root: string): void {
  const currentRepository = repositoryRoot(process.cwd());
  if (
    !isAbsolute(root) ||
    resolve(root) !== root ||
    root === parse(root).root ||
    root
      .split(sep)
      .some((part) =>
        ["public", "static", "node_modules", ".next", ".next-prod", ".next-distribution"].includes(
          part,
        ),
      ) ||
    (currentRepository !== null && within(currentRepository, root)) ||
    repositoryRoot(root) !== null
  )
    throw new Error("INVALID_PRIVATE_ROOT");
}
async function rejectSymlinks(path: string): Promise<void> {
  let cursor = parse(path).root;
  for (const part of path.slice(cursor.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error("SYMLINK_REFUSED");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
async function privateDirectory(path: string): Promise<void> {
  await rejectSymlinks(path);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await rejectSymlinks(path);
  const info = await lstat(path);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new Error("PRIVATE_ROOT_PERMISSIONS");
}

/** Private local storage. Input filenames and external URLs never become disk paths. */
export function createPrivateAssetStore(root: string): PrivateAssetStore {
  validateRoot(root);
  async function prepare() {
    validateRoot(root);
    await privateDirectory(root);
    await privateDirectory(join(root, "distribution"));
    await privateDirectory(join(root, "distribution", "masters"));
  }
  async function readVerified(asset: DerivedPrivateAsset, derived: boolean) {
    await prepare();
    const path = join(root, asset.storageKey);
    await rejectSymlinks(path);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size !== asset.byteSize || (info.mode & 0o077) !== 0) {
        throw new Error("ASSET_INTEGRITY_FAILED");
      }
      // The descriptor has already passed a media-specific size limit. Allocate exactly once.
      const bytes = Buffer.alloc(asset.byteSize);
      let offset = 0;
      while (offset < bytes.length) {
        const part = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!part.bytesRead) break;
        offset += part.bytesRead;
      }
      const tail = await file.read(Buffer.alloc(1), 0, 1, bytes.length);
      if (offset !== bytes.length || tail.bytesRead) throw new Error("ASSET_INTEGRITY_FAILED");
      verifyBytes(bytes, asset);
      if (derived) validateDerivedBytes(bytes, asset.mimeType);
      else
        validateMasterUpload(
          {
            byteSize: bytes.length,
            mimeType: asset.mimeType,
            signature: bytes.subarray(0, 32),
          },
          MAX_ONLINE_MASTER_BYTES,
        );
      return { bytes, info };
    } finally {
      await file.close();
    }
  }
  async function writeExclusive(asset: DerivedPrivateAsset, bytes: Buffer, derived: boolean) {
    await prepare();
    if (derived) {
      // Validate every parent, including master/source groups in the descriptive layout.
      let parent = root;
      for (const component of dirname(asset.storageKey).split("/")) {
        parent = join(parent, component);
        await privateDirectory(parent);
      }
    }
    const destination = join(root, asset.storageKey);
    const temporary = join(dirname(destination), `.pending-${randomUUID()}`);
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let linked = false;
    try {
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      await rejectSymlinks(dirname(destination));
      await link(temporary, destination);
      linked = true;
      await unlink(temporary);
    } catch (error) {
      await file.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      if (linked) await unlink(destination).catch(() => undefined);
      throw error;
    }
  }
  async function removeVerified(asset: DerivedPrivateAsset, derived: boolean) {
    const { info } = await readVerified(asset, derived);
    const path = join(root, asset.storageKey);
    await rejectSymlinks(path);
    const current = await lstat(path);
    if (
      current.dev !== info.dev ||
      current.ino !== info.ino ||
      current.size !== info.size ||
      current.mtimeMs !== info.mtimeMs
    ) {
      throw new Error("ASSET_INTEGRITY_FAILED");
    }
    await unlink(path);
  }
  async function streamMaster(asset: StoredPrivateAsset, destination?: string) {
    await prepare();
    const path = join(root, asset.storageKey);
    await rejectSymlinks(path);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size !== asset.byteSize || (info.mode & 0o077) !== 0)
        throw Error("ASSET_INTEGRITY_FAILED");
      await copyVerifiedMaster(file.createReadStream({ autoClose: false }), asset, destination);
      return info;
    } finally {
      await file.close();
    }
  }
  return {
    async writeFile(input) {
      validateFilename(input.originalName);
      const info = await inspectMasterFile(input.path, input.mimeType);
      const asset = {
        ...info,
        storageKey: `distribution/masters/${randomUUID()}`,
        mimeType: input.mimeType,
        originalName: input.originalName,
      };
      validateAsset(asset);
      await prepare();
      const destination = join(root, asset.storageKey);
      const temporary = join(root, "distribution", "masters", `.pending-${randomUUID()}`);
      const source = await open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await copyVerifiedMaster(source.createReadStream({ autoClose: false }), asset, temporary);
        await rejectSymlinks(dirname(destination));
        await link(temporary, destination);
      } finally {
        await source.close();
        await unlink(temporary).catch(() => undefined);
      }
      return asset;
    },
    async readRange(asset, start, end) {
      validateAsset(asset);
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        end >= asset.byteSize ||
        end - start >= 8 * 1024 * 1024
      )
        throw Error("INVALID_ASSET_RANGE");
      await prepare();
      const path = join(root, asset.storageKey);
      await rejectSymlinks(path);
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size !== asset.byteSize || (info.mode & 0o077) !== 0)
          throw Error("ASSET_INTEGRITY_FAILED");
        const stamp = `${asset.sha256}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
        if (verifiedMasters.get(path) !== stamp) {
          await copyVerifiedMaster(file.createReadStream({ autoClose: false }), asset);
          const after = await file.stat();
          if (
            after.mtimeMs !== info.mtimeMs ||
            after.ctimeMs !== info.ctimeMs ||
            after.size !== info.size
          )
            throw Error("ASSET_INTEGRITY_FAILED");
          if (verifiedMasters.size >= 1000) verifiedMasters.clear();
          verifiedMasters.set(path, stamp);
        }
        const bytes = Buffer.alloc(end - start + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const part = await file.read(bytes, offset, bytes.length - offset, start + offset);
          if (!part.bytesRead) throw Error("ASSET_INTEGRITY_FAILED");
          offset += part.bytesRead;
        }
        return bytes;
      } finally {
        await file.close();
      }
    },
    async materialize(asset, destination) {
      validateAsset(asset);
      await streamMaster(asset, destination);
    },
    async write(input): Promise<StoredPrivateAsset> {
      validateFilename(input.originalName);
      if (!(input.bytes instanceof Uint8Array)) throw new Error("INVALID_MEDIA");
      const mimeType = validateMasterUpload({
        byteSize: input.bytes.byteLength,
        mimeType: input.mimeType,
        signature: input.bytes.subarray(0, 32),
      });
      const bytes = Buffer.from(input.bytes);
      const asset = {
        storageKey: `distribution/masters/${randomUUID()}`,
        sha256: checksum(bytes),
        byteSize: bytes.length,
        mimeType,
        originalName: input.originalName,
      };
      await writeExclusive(asset, bytes, false);
      return asset;
    },
    async read(descriptor) {
      const asset = { ...descriptor };
      validateAsset(asset);
      return (await readVerified(asset, false)).bytes;
    },
    async readDerivedDescriptor(descriptor) {
      const asset = { ...descriptor };
      validateDerived(asset);
      return (await readVerified(asset, true)).bytes;
    },
    async writeDerivedDescriptor(descriptor, input) {
      const asset = { ...descriptor };
      validateDerived(asset);
      if (!(input instanceof Uint8Array) || input.byteLength !== asset.byteSize)
        throw new Error("ASSET_INTEGRITY_FAILED");
      const bytes = Buffer.from(input);
      verifyBytes(bytes, asset);
      validateDerivedBytes(bytes, asset.mimeType);
      await writeExclusive(asset, bytes, true);
    },
    /** Internal rollback only; caller must prove the metadata transaction did not commit. */
    async removeUnreferenced(descriptor) {
      const asset = { ...descriptor };
      validateAsset(asset);
      const info = await streamMaster(asset);
      const path = join(root, asset.storageKey);
      await rejectSymlinks(path);
      const current = await lstat(path);
      if (
        current.dev !== info.dev ||
        current.ino !== info.ino ||
        current.size !== info.size ||
        current.mtimeMs !== info.mtimeMs
      )
        throw Error("ASSET_INTEGRITY_FAILED");
      await unlink(path);
    },
    async removeDerivedUnreferenced(descriptor) {
      const asset = { ...descriptor };
      validateDerived(asset);
      await removeVerified(asset, true);
    },
  };
}
