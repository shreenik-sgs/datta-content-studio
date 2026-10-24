import { expect, it, vi } from "vitest";
import { checkOnlineImportRuntime, validateOnlineImportRuntime } from "./online-import-runtime";
import runtime from "./online-import-runtime.json";

const diagnostics = `[debug] yt-dlp version stable@${runtime.ytDlpVersion} from yt-dlp/yt-dlp [abc] (pip)
[debug] exe versions: ffmpeg 7.1, ffprobe 7.1
[debug] Optional libraries: requests-2.32, yt_dlp_ejs-${runtime.ejsVersion}
[debug] JS runtimes: node-22.14.0`;

it("validates the installed downloader and its extraction dependencies", () => {
  expect(validateOnlineImportRuntime(diagnostics)).toEqual({
    version: runtime.ytDlpVersion,
    nodeMajor: 22,
    ejsVersion: runtime.ejsVersion,
  });
});

it("rejects an obsolete downloader even when --version works", () => {
  expect(() =>
    validateOnlineImportRuntime(diagnostics.replace(runtime.ytDlpVersion, "2026.8.19")),
  ).toThrow("ONLINE_IMPORT_RUNTIME_OUTDATED");
});

it.each([
  diagnostics.replace(/yt_dlp_ejs-[\d.]+/, ""),
  diagnostics.replace(/yt_dlp_ejs-[\d.]+/, "yt_dlp_ejs-0.0.1"),
  diagnostics.replace("node-22.14.0", "node-20.0.0"),
  diagnostics.replace("node-22.14.0", "none"),
  diagnostics.replace("ffmpeg 7.1, ", ""),
  "2026.10.21",
])("rejects incomplete extraction dependencies", (value) => {
  expect(() => validateOnlineImportRuntime(value)).toThrow("ONLINE_IMPORT_RUNTIME_INCOMPLETE");
});

it("fails closed without exposing executable paths or stderr", async () => {
  await expect(checkOnlineImportRuntime("/nonexistent/private-credentials/yt-dlp")).rejects.toThrow(
    /^ONLINE_IMPORT_RUNTIME_INCOMPLETE$/,
  );
});

it("does not claim jobs or advertise readiness when preflight fails", async () => {
  const { runOnlineImportLoop } = await import("./online-import-worker");
  const repository = { heartbeat: vi.fn(), claim: vi.fn() };
  const onError = vi.fn();
  await runOnlineImportLoop({
    repository: repository as never,
    store: {} as never,
    isTest: true,
    env: { STUDIO_YTDLP_PATH: "/nonexistent/yt-dlp" },
    signal: new AbortController().signal,
    onError,
  });
  expect(repository.heartbeat).not.toHaveBeenCalled();
  expect(repository.claim).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledWith("ONLINE_IMPORT_RUNTIME_INCOMPLETE");
});
