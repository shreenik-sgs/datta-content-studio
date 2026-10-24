import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  ONLINE_VIDEO_FORMAT,
  ONLINE_VIDEO_METADATA,
  downloadOnlineVideo,
  onlineDownloadFailure,
} from "./online-video-download";

it("distinguishes server bot verification from source privacy or rights", () => {
  expect(
    onlineDownloadFailure(
      "ERROR: Sign in to confirm you’re not a bot. Use --cookies for authentication",
    ),
  ).toBe("ONLINE_PROVIDER_VERIFICATION_REQUIRED");
  expect(onlineDownloadFailure("ERROR: Sign in to confirm you're not a bot")).toBe(
    "ONLINE_PROVIDER_VERIFICATION_REQUIRED",
  );
  expect(onlineDownloadFailure("HTTP Error 429: Too Many Requests")).toBe(
    "ONLINE_PROVIDER_RATE_LIMITED",
  );
  for (const message of [
    "Private video. Sign in",
    "This video is members-only",
    "Sign in to confirm your age",
  ])
    expect(onlineDownloadFailure(message)).toBe("ONLINE_SOURCE_RESTRICTED");
  expect(onlineDownloadFailure("File is larger than max-filesize")).toBe("ONLINE_SOURCE_TOO_LARGE");
  expect(onlineDownloadFailure("Connection timed out")).toBe("ONLINE_SOURCE_UNAVAILABLE");
  expect(
    onlineDownloadFailure(
      "ERROR: [youtube:tab] PLQpnyP5jaBpk: YouTube said: The playlist does not exist.",
    ),
  ).toBe("ONLINE_PLAYLIST_NOT_FOUND");
  expect(onlineDownloadFailure("ERROR: This playlist is private. Sign in")).toBe(
    "ONLINE_SOURCE_RESTRICTED",
  );
  expect(onlineDownloadFailure("Requested format is not available. Use --list-formats")).toBe(
    "ONLINE_SOURCE_FORMAT_UNSUPPORTED",
  );
});

it("reports an oversized format skipped on stdout before it becomes a missing-file error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "studio-size-skip-"));
  try {
    const binary = join(dir, "synthetic-downloader");
    await writeFile(
      binary,
      `#!${process.execPath}\nprocess.stdout.write('[download] File is larger than max-filesize (3000 > 1000). Aborting.\\n');\n`,
    );
    await chmod(binary, 0o700);
    await expect(
      downloadOnlineVideo({
        source: {
          kind: "video",
          provider: "youtube",
          id: "QnJEAhhnbUA",
          url: "https://www.youtube.com/watch?v=QnJEAhhnbUA",
        },
        maxBytes: 1000,
        signal: new AbortController().signal,
        binary,
      }),
    ).rejects.toThrow("ONLINE_SOURCE_TOO_LARGE");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const downloader = process.env.STUDIO_YTDLP_PATH ?? "/opt/homebrew/bin/yt-dlp";
it.skipIf(!existsSync(downloader))(
  "selects DASH-only and mixed-protocol archives without enabling arbitrary media protocols",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "studio-format-"));
    try {
      for (const audioProtocol of ["http_dash_segments", "https"]) {
        const formats = [
          {
            format_id: "video",
            ext: "mp4",
            protocol: "http_dash_segments",
            width: 1280,
            height: 720,
            vcodec: "av01",
            acodec: "none",
            tbr: 800,
            url: "https://fixture.googlevideo.com/video",
            fragments: Array.from({ length: 5000 }, (_, i) => ({
              url: `https://fixture.googlevideo.com/fragment-${i}`,
            })),
          },
          {
            format_id: "audio",
            ext: "m4a",
            protocol: audioProtocol,
            vcodec: "none",
            acodec: "mp4a.40.2",
            abr: 128,
            url: "https://fixture.googlevideo.com/audio",
          },
          {
            format_id: "unsafe",
            ext: "mp4",
            protocol: "file",
            width: 1920,
            height: 1080,
            vcodec: "avc1",
            acodec: "mp4a",
            url: "file:///untrusted.mp4",
          },
        ];
        const path = join(dir, "fixture.json");
        await writeFile(
          path,
          JSON.stringify({
            id: "fixture",
            title: "DASH archive",
            duration: 60,
            is_live: false,
            live_status: "post_live",
            extractor: "youtube",
            formats,
          }),
        );
        const selected = execFileSync(
          downloader,
          [
            "--ignore-config",
            "--no-plugin-dirs",
            "--no-remote-components",
            "--load-info-json",
            path,
            "--skip-download",
            "--no-check-formats",
            "--format",
            ONLINE_VIDEO_FORMAT,
            "--print",
            "%(format_id)s",
            "--print",
            ONLINE_VIDEO_METADATA,
          ],
          { encoding: "utf8", timeout: 15000 },
        );
        const [format, metadata] = selected.trim().split("\n");
        expect(format).toBe("video+audio");
        expect(JSON.parse(metadata ?? "null")).toMatchObject({
          title: "DASH archive",
          is_live: false,
          live_status: "post_live",
        });
        expect(metadata?.length).toBeLessThan(256);
        expect(metadata).not.toContain("googlevideo");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  35000,
);

it.skipIf(!existsSync(downloader))(
  "writes compact metadata after the downloaded file has moved into place",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "studio-after-move-"));
    try {
      // A local fixture exercises yt-dlp's after_move stage without external traffic.
      // File URLs are enabled only in this test; the application selector/proxy rejects them.
      const source = join(dir, "fixture.mp4");
      await writeFile(source, Buffer.from("0000ftypisomfixture"));
      const path = join(dir, "source.json");
      await writeFile(
        path,
        JSON.stringify({
          id: "fixture",
          title: "A complete recording",
          extractor: "generic",
          is_live: false,
          live_status: "was_live",
          formats: [
            {
              format_id: "fixture",
              ext: "mp4",
              protocol: "file",
              vcodec: "avc1",
              acodec: "aac",
              url: new URL(`file://${source}`).href,
            },
          ],
        }),
      );
      const metadataPath = join(dir, "master.metadata.json");
      execFileSync(
        downloader,
        [
          "--ignore-config",
          "--no-plugin-dirs",
          "--no-remote-components",
          "--enable-file-urls",
          "--load-info-json",
          path,
          "--no-check-formats",
          "--no-simulate",
          "--format",
          "fixture",
          "--output",
          join(dir, "master.%(ext)s"),
          "--print-to-file",
          `after_move:${ONLINE_VIDEO_METADATA}`,
          metadataPath,
        ],
        { encoding: "utf8", timeout: 15000 },
      );
      const { readFile } = await import("node:fs/promises");
      expect(await readFile(join(dir, "master.mp4"))).toEqual(await readFile(source));
      expect(JSON.parse(await readFile(metadataPath, "utf8"))).toMatchObject({
        title: "A complete recording",
        is_live: false,
        live_status: "was_live",
      });
      expect(existsSync(join(dir, "master.info.json"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  20000,
);
