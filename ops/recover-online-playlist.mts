// Run on an operator's computer when the provider accepts normal local downloads.
// This uses the Hub downloader and authenticated original-upload API. It never
// exports Google cookies, changes provider verification, or approves/publishes.
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { checkOnlineImportRuntime } from "../apps/distribution-worker/src/online-import-runtime.js";
import { downloadOnlineVideo } from "../apps/distribution-worker/src/online-video-download.js";
import {
  MAX_ONLINE_MASTER_BYTES,
  type OnlineImport,
  onlineVideoSource,
} from "../packages/distribution-domain/src/index.js";

const origin = process.env.STUDIO_RECOVERY_ORIGIN ?? "";
const bundle = process.argv[2] ?? "";
const username = process.env.STUDIO_RECOVERY_USERNAME;
const password = process.env.STUDIO_RECOVERY_PASSWORD;
const directory = process.env.STUDIO_RECOVERY_DIRECTORY;
if (
  !["https://gbadpt.sgsdattasannidhi.org", "http://localhost:3070"].includes(origin) ||
  !/^[0-9a-f-]{36}$/.test(bundle) ||
  !username ||
  !password ||
  !directory
)
  throw Error("RECOVERY_CONFIGURATION_REQUIRED");
await checkOnlineImportRuntime(process.env.STUDIO_YTDLP_PATH);
const folder = resolve(directory, bundle);
await mkdir(folder, { recursive: true, mode: 0o700 });
const lockPath = join(folder, "recovery.lock");
const lock = await open(lockPath, "wx", 0o600);
await lock.writeFile(String(process.pid));
await lock.close();
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
let cookie: string | undefined;
const headers = () => ({ Origin: origin, Cookie: cookie ?? "" });
async function members() {
  const response = await fetch(`${origin}/distribution/api/content/import?rootId=${bundle}`, {
    headers: headers(),
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw Error(`RECOVERY_LIST_HTTP_${response.status}`);
  const data = (await response.json()) as { items: OnlineImport[] };
  const root = data.items.find((item) => item.id === bundle);
  if (!root?.childIds?.length || !root.curation) throw Error("RECOVERY_SAVED_PLAYLIST_REQUIRED");
  const children = root.childIds.map((id) => data.items.find((item) => item.id === id));
  if (children.some((item) => !item)) throw Error("RECOVERY_MEMBERS_INCOMPLETE");
  return { root, children: children as OnlineImport[] };
}
async function checksum(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
const progress = (value: object) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), ...value }));
try {
  const login = await fetch(`${origin}/distribution/api/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { Origin: origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: username, password }),
    signal: AbortSignal.timeout(30000),
  });
  if (login.status !== 303) throw Error("RECOVERY_LOGIN_FAILED");
  cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw Error("RECOVERY_LOGIN_FAILED");
  const initial = await members();
  progress({
    event: "playlist",
    recordings: initial.children.length,
    pending: initial.children.filter((item) => !item.masterId).length,
  });
  for (const item of initial.children) {
    controller.signal.throwIfAborted();
    const current = (await members()).children.find((entry) => entry.id === item.id);
    if (!current) throw Error("RECOVERY_MEMBER_CHANGED");
    if (current.masterId) {
      progress({ event: "already_attached", id: item.id });
      continue;
    }
    const source = onlineVideoSource(current.source.url);
    if (source.kind !== "video" || source.provider !== "youtube")
      throw Error("RECOVERY_SOURCE_INVALID");
    const path = join(folder, `${source.id}.mp4`);
    const manifestPath = `${path}.json`;
    let manifest: { source: string; sha256: string; bytes: number } | undefined;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw Error("RECOVERY_CHECKPOINT_INVALID");
    }
    if (manifest) {
      if (
        manifest.source !== source.url ||
        manifest.bytes !== (await stat(path)).size ||
        manifest.sha256 !== (await checksum(path))
      )
        throw Error("RECOVERY_CHECKPOINT_INVALID");
    } else {
      progress({ event: "downloading", id: item.id, sourceId: source.id });
      await downloadOnlineVideo({
        source,
        maxBytes: MAX_ONLINE_MASTER_BYTES,
        signal: controller.signal,
        binary: process.env.STUDIO_YTDLP_PATH,
        save: async (video) => {
          // A completed manifest is the commit marker. Incomplete copies are retained
          // under their own attempt name, never mistaken for verified downloads.
          const attempt = `${path}.${process.pid}.partial`;
          await copyFile(video.path, attempt, constants.COPYFILE_EXCL);
          manifest = {
            source: source.url,
            bytes: (await stat(attempt)).size,
            sha256: await checksum(attempt),
          };
          await rename(attempt, path);
          await writeFile(`${manifestPath}.${process.pid}.partial`, JSON.stringify(manifest), {
            mode: 0o600,
            flag: "wx",
          });
          await rename(`${manifestPath}.${process.pid}.partial`, manifestPath);
        },
      });
    }
    if (!manifest) throw Error("RECOVERY_CHECKPOINT_INVALID");
    if ((await members()).children.find((entry) => entry.id === item.id)?.masterId) continue;
    progress({ event: "uploading", id: item.id, bytes: manifest.bytes });
    const body = createReadStream(path);
    try {
      const response = await fetch(
        `${origin}/distribution/api/content/import/${item.id}/original?bundle=${bundle}`,
        {
          method: "POST",
          redirect: "error",
          headers: {
            ...headers(),
            "content-type": "video/mp4",
            "content-length": String(manifest.bytes),
            "x-original-filename": encodeURIComponent(`youtube-${source.id}-master.mp4`),
          },
          body,
          duplex: "half",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2 * 60 * 60 * 1000)]),
        } as RequestInit & { duplex: "half" },
      );
      if (!response.ok) throw Error(`RECOVERY_UPLOAD_HTTP_${response.status}`);
      await response.body?.cancel();
    } catch (error) {
      // A lost response is reconciled against the server before any retry.
      if (!(await members()).children.find((entry) => entry.id === item.id)?.masterId) throw error;
    } finally {
      body.destroy();
    }
    const saved = (await members()).children.find((entry) => entry.id === item.id);
    if (saved?.status !== "COMPLETE" || !saved.masterId)
      throw Error("RECOVERY_UPLOAD_NOT_VERIFIED");
    progress({ event: "attached", id: item.id, masterId: saved.masterId });
  }
  const final = await members();
  const completed = final.children.filter(
    (item) => item.status === "COMPLETE" && item.masterId,
  ).length;
  progress({ event: "finished", recordings: final.children.length, completed });
  if (completed !== final.children.length) process.exitCode = 2;
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  progress({
    event: "paused",
    code: /^(RECOVERY|ONLINE|IMPORT)_[A-Z_0-9]+$/.test(message) ? message : "RECOVERY_INTERRUPTED",
  });
  process.exitCode = 1;
} finally {
  if (cookie)
    await fetch(`${origin}/distribution/api/auth/logout`, {
      method: "POST",
      redirect: "manual",
      headers: headers(),
      signal: AbortSignal.timeout(10000),
    }).catch(() => undefined);
  await rm(lockPath, { force: true });
}
