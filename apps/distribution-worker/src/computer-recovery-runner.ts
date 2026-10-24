import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ComputerRecoveryState } from "@satsang/distribution-contracts";
import {
  COMPUTER_RECOVERY_ORIGIN,
  MAX_ONLINE_MASTER_BYTES,
  type OnlineImport,
  onlineVideoSource,
} from "@satsang/distribution-domain";
import { downloadOnlineVideo } from "./online-video-download.js";

async function checksum(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Password and the dedicated staging session exist only in this running operation's memory.
 * Checkpoints contain media hashes, never credentials. All redirects are refused. */
export async function recoverPlaylistOnComputer(input: {
  bundle: string;
  username: string;
  password: string;
  directory: string;
  binary?: string | undefined;
  signal: AbortSignal;
  authorize: () => Promise<void>;
  progress: (state: Partial<ComputerRecoveryState>) => void;
  fetcher?: typeof fetch;
  download?: typeof downloadOnlineVideo;
}) {
  const fetcher = input.fetcher ?? fetch;
  const origin = COMPUTER_RECOVERY_ORIGIN;
  const folder = join(input.directory, input.bundle);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  let cookie: string | undefined;
  const headers = () => ({ Origin: origin, Cookie: cookie ?? "" });
  const signal = () => AbortSignal.any([input.signal, AbortSignal.timeout(30000)]);
  async function members() {
    input.signal.throwIfAborted();
    await input.authorize();
    const response = await fetcher(
      `${origin}/distribution/api/content/import/${input.bundle}/recovery-info`,
      {
        headers: headers(),
        redirect: "error",
        signal: signal(),
      },
    );
    if (response.status === 401) throw Error("RECOVERY_SESSION_EXPIRED");
    if (response.status === 403) throw Error("RECOVERY_FORBIDDEN");
    if (!response.ok) {
      const problem = (await response.json().catch(() => ({}))) as { error?: string };
      throw Error(
        problem.error === "RECOVERY_SAVED_PLAYLIST_REQUIRED"
          ? problem.error
          : "RECOVERY_INVALID_PLAYLIST",
      );
    }
    const data = (await response.json()) as {
      identity: string;
      isTest: boolean;
      root: OnlineImport;
      children: OnlineImport[];
    };
    if (data.identity !== "gbadpt" || data.isTest !== true)
      throw Error("RECOVERY_DESTINATION_MISMATCH");
    if (data.root?.id !== input.bundle || !data.root.childIds?.length || !data.root.curation)
      throw Error("RECOVERY_SAVED_PLAYLIST_REQUIRED");
    if (
      !Array.isArray(data.children) ||
      data.children.length !== data.root.childIds.length ||
      new Set(data.children.map((item) => item.id)).size !== data.children.length ||
      !data.children.every((item) => data.root.childIds?.includes(item.id))
    )
      throw Error("RECOVERY_INVALID_PLAYLIST");
    return data;
  }
  try {
    await input.authorize();
    const login = await fetcher(`${origin}/distribution/api/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { Origin: origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: input.username, password: input.password }),
      signal: signal(),
    });
    // Release our reference immediately; the password is never used after this request.
    input.password = "";
    const session = login.headers.get("set-cookie")?.match(/(?:^|,\s*)dcs_session=([a-f0-9]{64});/);
    if (login.status !== 303 || !session?.[1]) throw Error("RECOVERY_LOGIN_FAILED");
    cookie = `dcs_session=${session[1]}`;
    const initial = await members();
    const done = (items: OnlineImport[]) => items.filter((item) => !!item.masterId).length;
    input.progress({
      title: initial.root.title ?? "Playlist",
      recordings: initial.children.length,
      completed: done(initial.children),
    });
    for (const item of initial.children) {
      const current = (await members()).children.find((value) => value.id === item.id);
      if (!current) throw Error("RECOVERY_INVALID_PLAYLIST");
      if (current.masterId) continue;
      const source = onlineVideoSource(current.source.url);
      if (
        source.provider !== "youtube" ||
        source.kind !== "video" ||
        source.id !== current.source.id
      )
        throw Error("RECOVERY_INVALID_PLAYLIST");
      const path = join(folder, `${source.id}.mp4`);
      const manifestPath = `${path}.json`;
      let manifest: { source: string; sha256: string; bytes: number } | undefined;
      input.progress({ currentTitle: current.title ?? source.id, phase: "checking" });
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
        input.progress({ phase: "downloading" });
        await (input.download ?? downloadOnlineVideo)({
          source,
          maxBytes: MAX_ONLINE_MASTER_BYTES,
          binary: input.binary,
          signal: input.signal,
          save: async (video) => {
            const attempt = `${path}.${randomUUID()}.partial`;
            try {
              await copyFile(video.path, attempt);
              await chmod(attempt, 0o600);
              manifest = {
                source: source.url,
                bytes: (await stat(attempt)).size,
                sha256: await checksum(attempt),
              };
              await rename(attempt, path);
              await writeFile(`${attempt}.json`, JSON.stringify(manifest), {
                mode: 0o600,
                flag: "wx",
              });
              await rename(`${attempt}.json`, manifestPath);
            } finally {
              await rm(attempt, { force: true });
              await rm(`${attempt}.json`, { force: true });
            }
          },
        });
      }
      if (!manifest) throw Error("RECOVERY_CHECKPOINT_INVALID");
      const beforeUpload = await members();
      if (beforeUpload.children.find((value) => value.id === item.id)?.masterId) {
        input.progress({ completed: done(beforeUpload.children) });
        continue;
      }
      input.progress({ phase: "uploading" });
      const body = createReadStream(path);
      try {
        const response = await fetcher(
          `${origin}/distribution/api/content/import/${item.id}/original?bundle=${input.bundle}`,
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
            signal: AbortSignal.any([input.signal, AbortSignal.timeout(2 * 60 * 60 * 1000)]),
          } as unknown as RequestInit & { duplex: "half" },
        );
        if (response.status === 401) throw Error("RECOVERY_SESSION_EXPIRED");
        if (response.status === 403) throw Error("RECOVERY_FORBIDDEN");
        if (!response.ok) throw Error("RECOVERY_UPLOAD_FAILED");
        await response.body?.cancel();
      } catch (error) {
        // A lost upload response may already have committed. Reconcile before retrying.
        if (!(await members()).children.find((value) => value.id === item.id)?.masterId)
          throw error;
      } finally {
        body.destroy();
      }
      const saved = await members();
      const attached = saved.children.find((value) => value.id === item.id);
      if (attached?.status !== "COMPLETE" || !attached.masterId)
        throw Error("RECOVERY_UPLOAD_FAILED");
      input.progress({ completed: done(saved.children) });
    }
    const final = await members();
    if (done(final.children) !== final.children.length) throw Error("RECOVERY_INTERRUPTED");
    input.progress({ completed: final.children.length, currentTitle: undefined, phase: undefined });
  } finally {
    input.password = "";
    if (cookie)
      await fetcher(`${origin}/distribution/api/auth/logout`, {
        method: "POST",
        redirect: "manual",
        headers: headers(),
        signal: AbortSignal.timeout(10000),
      }).catch(() => undefined);
    cookie = undefined;
  }
}
