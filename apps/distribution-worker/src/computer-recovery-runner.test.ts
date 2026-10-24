import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComputerRecoveryState } from "@satsang/distribution-contracts";
import { afterEach, expect, it, vi } from "vitest";
import { recoverPlaylistOnComputer } from "./computer-recovery-runner";

const bundle = "2eb8dfae-1493-4900-ab9c-a6e6d8813696";
const child = "151ddbe7-075d-4763-8fe7-0a0a00a0c79e";
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "studio-recovery-test-"));
  folders.push(directory);
  const media = join(directory, "fixture.mp4");
  await writeFile(media, "private media bytes");
  let attached = false;
  let uploadFailure = false;
  let lostResponse = false;
  let world = true;
  const calls: string[] = [];
  const progress: Partial<ComputerRecoveryState>[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    expect(options?.redirect).not.toBe("follow");
    expect(new URL(String(url)).origin).toBe("https://gbadpt.sgsdattasannidhi.org");
    if (path.endsWith("/login"))
      return new Response(null, {
        status: 303,
        headers: { "set-cookie": `dcs_session=${"a".repeat(64)}; Path=/distribution; HttpOnly` },
      });
    if (path.endsWith("/logout")) return new Response(null, { status: 303 });
    if (path.endsWith("/recovery-info"))
      return Response.json({
        identity: "gbadpt",
        isTest: world,
        root: { id: bundle, title: "Series", childIds: [child], curation: { saved: true } },
        children: [
          {
            id: child,
            source: {
              provider: "youtube",
              kind: "video",
              id: "pGyrJNw1AJM",
              url: "https://www.youtube.com/watch?v=pGyrJNw1AJM",
            },
            title: "Recording",
            masterId: attached ? "master" : null,
            status: attached ? "COMPLETE" : "QUEUED",
          },
        ],
      });
    if (path.endsWith("/original")) {
      const chunks: Buffer[] = [];
      for await (const chunk of options?.body as unknown as AsyncIterable<Buffer>)
        chunks.push(chunk);
      expect(Buffer.concat(chunks).toString()).toBe("private media bytes");
      if (uploadFailure) return Response.json({}, { status: 503 });
      attached = true;
      if (lostResponse) throw Error("connection reset after commit");
      return Response.json({ masterId: "master" }, { status: 201 });
    }
    throw Error("Unexpected request");
  }) as unknown as typeof fetch;
  const download = vi.fn(async (input: { save: (value: { path: string }) => Promise<unknown> }) => {
    await input.save({ path: media });
  });
  const authorize = vi.fn(async () => {});
  const run = () =>
    recoverPlaylistOnComputer({
      bundle,
      username: "Curator",
      password: "private-password",
      directory,
      signal: new AbortController().signal,
      authorize,
      progress: (state) => progress.push(state),
      fetcher,
      download: download as never,
    });
  return {
    run,
    download,
    calls,
    progress,
    directory,
    authorize,
    failUpload: (value: boolean) => {
      uploadFailure = value;
    },
    loseResponse: () => {
      lostResponse = true;
    },
    wrongWorld: () => {
      world = false;
    },
  };
}
it("downloads, uploads into the existing child and skips it on a repeat run", async () => {
  const f = await fixture();
  await f.run();
  await f.run();
  expect(f.download).toHaveBeenCalledOnce();
  expect(f.calls.filter((path) => path.endsWith("/original"))).toHaveLength(1);
  expect(f.calls.filter((path) => path.endsWith("/logout"))).toHaveLength(2);
  expect(f.progress.at(-1)?.completed).toBe(1);
  expect(f.calls.some((path) => /approve|publish|submit/.test(path))).toBe(false);
  const manifest = await readFile(join(f.directory, bundle, "pGyrJNw1AJM.mp4.json"), "utf8");
  expect(manifest).not.toContain("private-password");
  expect(manifest).not.toContain("dcs_session");
});
it("resumes from a verified download after upload failure, without downloading again", async () => {
  const f = await fixture();
  f.failUpload(true);
  await expect(f.run()).rejects.toThrow("RECOVERY_UPLOAD_FAILED");
  f.failUpload(false);
  await f.run();
  expect(f.download).toHaveBeenCalledOnce();
  expect((await readdir(join(f.directory, bundle))).some((name) => name.includes("partial"))).toBe(
    false,
  );
});
it("reconciles a lost upload response before retrying", async () => {
  const f = await fixture();
  f.loseResponse();
  await f.run();
  expect(f.calls.filter((path) => path.endsWith("/original"))).toHaveLength(1);
  expect(f.progress.at(-1)?.completed).toBe(1);
});
it("refuses corrupt checkpoints and never uploads altered media", async () => {
  const f = await fixture();
  f.failUpload(true);
  await expect(f.run()).rejects.toThrow();
  await writeFile(join(f.directory, bundle, "pGyrJNw1AJM.mp4"), "tampered");
  f.calls.length = 0;
  await expect(f.run()).rejects.toThrow("RECOVERY_CHECKPOINT_INVALID");
  expect(f.calls.some((path) => path.endsWith("/original"))).toBe(false);
});
it("refuses a destination world mismatch and rechecks local authority", async () => {
  const f = await fixture();
  f.wrongWorld();
  await expect(f.run()).rejects.toThrow("RECOVERY_DESTINATION_MISMATCH");
  expect(f.download).not.toHaveBeenCalled();
  f.authorize.mockRejectedValueOnce(Error("RECOVERY_FORBIDDEN"));
  await expect(f.run()).rejects.toThrow("RECOVERY_FORBIDDEN");
});
