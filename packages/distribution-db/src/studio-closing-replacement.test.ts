import { expect, it } from "vitest";
import { validateStudioClosingReplacement } from "./studio-closing-replacement";
import { closingFixture } from "./studio-closing-test-fixture";

it("accepts separate watch and subscription destinations while retaining original editorial evidence", () => {
  const { pkg, prior, next, target } = closingFixture();
  expect(() => validateStudioClosingReplacement(pkg, prior, next, target, true)).not.toThrow();
});
it.each(["title", "captionCues", "sourceSegmentIds", "startMs", "generatedAt"])(
  "rejects a hidden %s change during a preview card refresh",
  (field) => {
    const { pkg, prior, next, target } = closingFixture();
    const tampered = { ...next, [field]: field === "startMs" ? 1200 : "changed" };
    expect(() => validateStudioClosingReplacement(pkg, prior, tampered, target, true)).toThrow();
  },
);
it("rejects changed source identity or a card pointing at the wrong full-video channel", () => {
  const { pkg, prior, next, target } = closingFixture();
  expect(() =>
    validateStudioClosingReplacement(
      { ...pkg, source: { ...pkg.source, sha256: "f".repeat(64) } },
      prior,
      next,
      target,
    ),
  ).toThrow();
  expect(() =>
    validateStudioClosingReplacement(pkg, prior, next, {
      ...target,
      fullVideosUrl: "https://www.youtube.com/@wrong",
    }),
  ).toThrow();
});
