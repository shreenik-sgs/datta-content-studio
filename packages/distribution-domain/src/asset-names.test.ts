import { describe, expect, it } from "vitest";
import { ASSET_DESTINATIONS, buildDerivedAssetNames, parseDerivedAssetKey } from "./asset-names";
const base = {
  masterId: "11111111-1111-4111-8111-111111111111",
  sourceVersionId: "22222222-2222-4222-8222-222222222222",
  derivationId: "33333333-3333-4333-8333-333333333333",
  destination: "instagram" as const,
  language: "te",
  aspect: "9:16" as const,
};
describe("master-linked intended-platform asset nomenclature", () => {
  it("keeps exact master/version/derivation lineage and one channel-specific basename family", () => {
    const names = buildDerivedAssetNames(base);
    expect(names.directory).toBe(
      `distribution/derived/${base.masterId}/${base.sourceVersionId}/${base.derivationId}`,
    );
    expect(names.video).toBe(`SGS_m${base.masterId}_instagram_video_te_9x16_d333333333333.mp4`);
    expect(names.captions).toBe(`${names.stem}_captions.vtt`);
    expect(names.manifest).toBe(`${names.stem}_manifest.json`);
    expect(names.archive).toBe(`${names.stem}.tar`);
    for (const kind of ["video", "captions", "manifest"] as const) {
      expect(parseDerivedAssetKey(`${names.directory}/${names[kind]}`)).toEqual({
        directory: names.directory,
        filename: names[kind],
        kind,
        naming: { ...base, format: "video" },
      });
    }
  });
  it("supports every existing platform while keeping TAR names within their exact ASCII field", () => {
    for (const destination of ASSET_DESTINATIONS) {
      const names = buildDerivedAssetNames({ ...base, destination });
      for (const name of [names.video, names.captions, names.manifest, names.archive]) {
        expect(name).toMatch(/^[A-Za-z0-9_.-]+$/);
        expect(Buffer.byteLength(name, "ascii")).toBeLessThanOrEqual(100);
        expect(name).toContain(destination.replaceAll("_", "-"));
      }
      expect(parseDerivedAssetKey(`${names.directory}/${names.video}`)?.naming?.destination).toBe(
        destination,
      );
    }
  });
  it("refuses malformed paths and names claiming a different master, version directory or derivation", () => {
    const names = buildDerivedAssetNames(base);
    for (const key of [
      `${names.directory}/${names.video}\n`,
      `${names.directory}/../${names.video}`,
      `${names.directory}/${names.video.replace(base.masterId, base.sourceVersionId)}`,
      `${names.directory}/${names.video.replace("d333333333333", "d444444444444")}`,
      `${names.directory}/${names.video.replace("instagram", "unknown")}`,
      `${names.directory}/${names.video.replace("te", "zz")}`,
      `${names.directory}/${names.video}/extra`,
    ])
      expect(parseDerivedAssetKey(key)).toBeNull();
    for (const patch of [
      { masterId: `${base.masterId}\n` },
      { sourceVersionId: "../../private" },
      { language: "te/../../" },
      { derivationId: "bad" },
    ])
      expect(() => buildDerivedAssetNames({ ...base, ...patch })).toThrow("INVALID_ASSET_NAMING");
  });
  it("reads exact legacy descriptors without guessing a destination or rewriting immutable history", () => {
    const directory = `distribution/renders/${base.derivationId}`;
    expect(parseDerivedAssetKey(`${directory}/preview.mp4`)).toEqual({
      directory,
      filename: "preview.mp4",
      kind: "video",
      naming: null,
    });
    expect(parseDerivedAssetKey(`${directory}/captions.vtt`)?.kind).toBe("captions");
    expect(parseDerivedAssetKey(`${directory}/manifest.json`)?.kind).toBe("manifest");
    expect(parseDerivedAssetKey(`${directory}/video.mp4`)).toBeNull();
  });
});
