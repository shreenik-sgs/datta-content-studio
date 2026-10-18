import { describe, expect, it } from "vitest";
import type { StudioOutput } from "./intelligent-content";
import { assertStudioCorrectionIsolation, studioCorrectionTargets } from "./studio-corrections";
const output = (id: string): StudioOutput => ({
  id,
  channel: "website",
  language: "en",
  format: "blog",
  title: "Synthetic",
  body: "Synthetic\n\n@sgsswamiji",
  included: true,
  rationale: "Test",
  sourceSegmentIds: ["one"],
  startMs: null,
  endMs: null,
  aspect: "prose",
  asset: {
    storageKey: "test",
    filename: "test.md",
    sha256: "test",
    byteSize: 1,
    mimeType: "text/markdown",
  },
  captions: [],
  warnings: [],
});
describe("file-scoped corrections", () => {
  it("never treats a missing or invalid selection as permission to rebuild existing files", () => {
    const pkg = { outputs: [output("one"), output("two")] };
    expect(() => studioCorrectionTargets(pkg)).toThrow("STUDIO_SELECT_OUTPUTS");
    expect(() => studioCorrectionTargets(pkg, ["unknown"])).toThrow("STUDIO_SELECT_OUTPUTS");
    expect(() => studioCorrectionTargets(pkg, ["one", "one"])).toThrow("STUDIO_SELECT_OUTPUTS");
    expect(() => studioCorrectionTargets({ outputs: [] }, ["unknown"])).toThrow(
      "STUDIO_SELECT_OUTPUTS",
    );
    expect(studioCorrectionTargets(pkg, ["one"])).toEqual(["one"]);
    expect(studioCorrectionTargets({ outputs: [] })).toEqual([]);
  });
  it("preserves every unselected file, including captions and review metadata", () => {
    const before = [output("one"), output("two")];
    const after = structuredClone(before);
    after[0] = { ...output("one"), title: "Corrected" };
    expect(() => assertStudioCorrectionIsolation(before, after, ["one"])).not.toThrow();
    after[1] = { ...output("two"), warnings: ["Unrelated change"] };
    expect(() => assertStudioCorrectionIsolation(before, after, ["one"])).toThrow(
      "STUDIO_UNRELATED_OUTPUT_CHANGED",
    );
    expect(() => assertStudioCorrectionIsolation(before, [output("one")], ["one"])).toThrow(
      "STUDIO_UNRELATED_OUTPUT_CHANGED",
    );
    expect(() =>
      assertStudioCorrectionIsolation(
        before,
        [{ ...output("one"), language: "te" }, output("two")],
        ["one"],
      ),
    ).toThrow("STUDIO_UNRELATED_OUTPUT_CHANGED");
  });
});
