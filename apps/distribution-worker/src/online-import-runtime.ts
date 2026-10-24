import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import runtime from "./online-import-runtime.json";

const execute = promisify(execFile);

export function validateOnlineImportRuntime(diagnostics: string) {
  const version = /yt-dlp version [^\s@]+@(\d{4}\.\d{1,2}\.\d{1,2})\b/.exec(diagnostics)?.[1];
  const nodeVersion = /JS runtimes:.*\bnode-(\d+)\.[\d.]+/.exec(diagnostics)?.[1];
  const ejsVersion = /\byt_dlp_ejs-([\d.]+)/.exec(diagnostics)?.[1];
  if (!version || !nodeVersion || !ejsVersion || !/exe versions:.*\bffmpeg\b/.test(diagnostics))
    throw Error("ONLINE_IMPORT_RUNTIME_INCOMPLETE");
  const comparable = (value: string) =>
    value
      .split(".")
      .map((part) => part.padStart(4, "0"))
      .join(".");
  if (comparable(version) < comparable(runtime.ytDlpVersion))
    throw Error("ONLINE_IMPORT_RUNTIME_OUTDATED");
  if (Number(nodeVersion) < runtime.minimumNodeMajor)
    throw Error("ONLINE_IMPORT_RUNTIME_INCOMPLETE");
  if (version === runtime.ytDlpVersion && ejsVersion !== runtime.ejsVersion)
    throw Error("ONLINE_IMPORT_RUNTIME_INCOMPLETE");
  return { version, nodeMajor: Number(nodeVersion), ejsVersion };
}

/** Offline preflight: no credentials, media requests, plugins or downloaded scripts.
 * A working --version alone does not establish that YouTube extraction can run. */
export async function checkOnlineImportRuntime(binary = "yt-dlp") {
  const directory = await mkdtemp(join(tmpdir(), "studio-import-runtime-"));
  try {
    const path = join(directory, "fixture.json");
    await writeFile(
      path,
      JSON.stringify({
        id: "studio-runtime-check",
        title: "Offline runtime check",
        extractor: "generic",
        duration: 1,
        formats: [
          {
            format_id: "fixture",
            ext: "mp4",
            protocol: "https",
            vcodec: "h264",
            acodec: "aac",
            url: "https://runtime-check.invalid/master.mp4",
          },
        ],
      }),
    );
    let result: { stdout: string; stderr: string };
    try {
      result = await execute(
        binary,
        [
          "--ignore-config",
          "--no-plugin-dirs",
          "--no-remote-components",
          "--js-runtimes",
          `node:${process.execPath}`,
          "--verbose",
          "--simulate",
          "--no-check-formats",
          "--load-info-json",
          path,
          "--print",
          "%(id)s",
        ],
        {
          timeout: 15000,
          maxBuffer: 128 * 1024,
          env: { PATH: process.env.PATH, HOME: directory, LANG: "C.UTF-8" },
        },
      );
    } catch {
      throw Error("ONLINE_IMPORT_RUNTIME_INCOMPLETE");
    }
    if (result.stdout.trim() !== "studio-runtime-check")
      throw Error("ONLINE_IMPORT_RUNTIME_INCOMPLETE");
    return validateOnlineImportRuntime(result.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
