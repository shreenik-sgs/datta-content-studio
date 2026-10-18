import { createHash } from "node:crypto";
import type { ExportManifest } from "@satsang/distribution-contracts";
import {
  type MasterMimeType,
  buildDerivedAssetNames,
  buildMasterAssetNames,
} from "@satsang/distribution-domain";
import { describe, expect, it } from "vitest";
import { derivativeArchive, exportArchive, exportMasterArchiveStream } from "./export";

const now = "2026-09-29T12:00:00.000Z";
const naming = {
  masterId: "11111111-1111-4111-8111-111111111111",
  sourceVersionId: "22222222-2222-4222-8222-222222222222",
  derivationId: "33333333-3333-4333-8333-333333333333",
  destination: "instagram",
  language: "te",
  aspect: "9:16",
} as const;
function manifestFor(bytes: Buffer, mimeType: MasterMimeType): ExportManifest {
  const masterId = "11111111-1111-4111-8111-111111111111";
  const versionId = "22222222-2222-4222-8222-222222222222";
  return {
    schemaVersion: 1,
    exportedAt: now,
    exportedBy: "operator",
    channel: "manual_export",
    territory: "WORLDWIDE",
    content: {
      id: masterId,
      title: "Sacred flute",
      language: "te",
      category: "sacred_flute",
      isTest: true,
      revision: 3,
      state: "APPROVED",
      currentVersion: {
        id: versionId,
        masterId,
        number: 1,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteSize: bytes.length,
        mimeType,
        originalName: "తెలుగు master.exe",
        createdAt: now,
        createdBy: "creator",
      },
      rights: {
        owner: "SGS",
        territories: ["WORLDWIDE"],
        channels: ["manual_export"],
        authorizationBasis: "Rights holder permission",
        privacyClass: "PUBLIC",
        releaseAt: null,
        expiresAt: null,
      },
      approval: { versionId, approvedRevision: 3, reviewerId: "reviewer", approvedAt: now },
      createdAt: now,
      updatedAt: now,
    },
  };
}
function readTar(archive: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  expect(archive.length % 512).toBe(0);
  let offset = 0;
  while (offset < archive.length - 1024) {
    const header = archive.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("ascii").replace(/\0.*$/s, "");
    const size = Number.parseInt(header.subarray(124, 136).toString("ascii"), 8);
    const checksum = Number.parseInt(header.subarray(148, 156).toString("ascii"), 8);
    expect(Number.isSafeInteger(size)).toBe(true);
    expect(size).toBeGreaterThanOrEqual(0);
    expect(header.subarray(257, 265).toString("ascii")).toBe("ustar\x0000");
    expect(header.subarray(156, 157).toString()).toBe("0");
    expect(header.subarray(157, 257)).toEqual(Buffer.alloc(100));
    expect(header.subarray(345, 500)).toEqual(Buffer.alloc(155));
    expect(files.has(name)).toBe(false);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(32, 148, 156);
    expect(checksum).toBe(checksumHeader.reduce((total, byte) => total + byte, 0));
    const end = offset + 512 + size;
    expect(end).toBeLessThanOrEqual(archive.length - 1024);
    files.set(name, archive.subarray(offset + 512, end));
    const paddedEnd = Math.ceil(end / 512) * 512;
    expect(archive.subarray(end, paddedEnd)).toEqual(Buffer.alloc(paddedEnd - end));
    offset = paddedEnd;
  }
  expect(archive.length - offset).toBe(1024);
  expect(archive.subarray(offset)).toEqual(Buffer.alloc(1024));
  return files;
}

describe("DS-DIST-R1 manual package", () => {
  it.each([
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["image/webp", "webp"],
    ["audio/mpeg", "mp3"],
    ["audio/wav", "wav"],
    ["audio/mp4", "m4a"],
    ["video/mp4", "mp4"],
    ["application/pdf", "pdf"],
  ] as const)(
    "DS-DIST-R1-EXPORT names %s by MIME and preserves valid tar bytes",
    (mime, extension) => {
      // Cross a tar block boundary and include null bytes: substring matching is insufficient.
      const bytes = Buffer.from(Array.from({ length: 1027 }, (_, index) => index % 256));
      const manifest = manifestFor(bytes, mime);
      const names = buildMasterAssetNames({ masterId: manifest.content.id, versionNumber: 1 });
      const mediaName = `${names.stem}.${extension}`;
      const files = readTar(exportArchive(bytes, manifest));
      expect([...files.keys()]).toEqual([mediaName, names.manifest]);
      expect(files.get(mediaName)).toEqual(bytes);
      expect(JSON.parse(files.get(names.manifest)?.toString("utf8") ?? "")).toEqual(manifest);
      expect(
        createHash("sha256")
          .update(files.get(mediaName) ?? "")
          .digest("hex"),
      ).toBe(manifest.content.currentVersion.sha256);
    },
  );
});

describe("DS-DIST-R3 reviewed derivative archive", () => {
  it("preserves exact bytes with related master, destination and format in every tar name", () => {
    const video = Buffer.from(Array.from({ length: 1301 }, (_, index) => index % 255));
    const captions = Buffer.from("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nExact reviewed text\n");
    const manifest = Buffer.from('{"schemaVersion":1,"reviewed":true}');
    const names = buildDerivedAssetNames(naming);
    const files = readTar(derivativeArchive({ naming, video, captions, manifest }));
    expect([...files.keys()]).toEqual([names.video, names.captions, names.manifest]);
    expect(files.get(names.video)).toEqual(video);
    expect(files.get(names.captions)).toEqual(captions);
    expect(files.get(names.manifest)).toEqual(manifest);
    for (const name of files.keys()) {
      expect(name).toContain(naming.masterId);
      expect(name).toContain("instagram");
      expect(name.length).toBeLessThanOrEqual(100);
    }
    expect([
      ...readTar(derivativeArchive({ naming, video, captions: null, manifest })).keys(),
    ]).toEqual([names.video, names.manifest]);
  });
  it("refuses empty and oversized entries rather than creating malformed packages", () => {
    expect(() =>
      derivativeArchive({
        naming,
        video: Buffer.alloc(0),
        captions: null,
        manifest: Buffer.from("{}"),
      }),
    ).toThrow("INVALID_DERIVED_ASSET");
    expect(() =>
      derivativeArchive({
        naming,
        video: Buffer.from("video"),
        captions: Buffer.alloc(1024 * 1024 + 1),
        manifest: Buffer.from("{}"),
      }),
    ).toThrow("INVALID_DERIVED_ASSET");
    expect(() =>
      derivativeArchive({
        naming,
        video: Buffer.from("video"),
        captions: null,
        manifest: Buffer.alloc(2 * 1024 * 1024 + 1),
      }),
    ).toThrow("INVALID_DERIVED_ASSET");
  });
  it("refuses path and header injection instead of accepting caller filenames", () => {
    const bytes = { video: Buffer.from("video"), captions: null, manifest: Buffer.from("{}") };
    expect(() =>
      derivativeArchive({ ...bytes, naming: { ...naming, masterId: "../outside" } }),
    ).toThrow();
    expect(() =>
      derivativeArchive({ ...bytes, naming: { ...naming, language: "en\r\nunsafe" } }),
    ).toThrow();
  });
});

it("streams the same valid master archive in bounded pieces", async () => {
  const bytes = Buffer.alloc(9 * 1024 * 1024, 7);
  const manifest = manifestFor(bytes, "video/mp4");
  const sizes: number[] = [];
  const stream = exportMasterArchiveStream(async (start, end) => {
    sizes.push(end - start + 1);
    return bytes.subarray(start, end + 1);
  }, manifest);
  const archive = Buffer.from(await new Response(stream).arrayBuffer());
  expect(archive.equals(exportArchive(bytes, manifest))).toBe(true);
  expect(sizes).toEqual([8 * 1024 * 1024, 1024 * 1024]);
  expect(readTar(archive).size).toBe(2);
});
