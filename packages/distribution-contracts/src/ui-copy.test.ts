import { describe, expect, it } from "vitest";
import {
  DISTRIBUTION_LANGUAGE_NAMES,
  DISTRIBUTION_UI_COPY,
  DISTRIBUTION_UI_LOCALES,
  type DistributionTextKey,
  distributionErrorText,
  distributionText,
} from "./ui-copy";

describe("DS-DIST-R1 localized operator catalogue", () => {
  const keys = Object.keys(DISTRIBUTION_UI_COPY.en).sort() as DistributionTextKey[];
  it.each(DISTRIBUTION_UI_LOCALES)("has every current operator key in %s", (locale) => {
    const copy = DISTRIBUTION_UI_COPY[locale];
    expect(Object.keys(copy).sort()).toEqual(keys);
    for (const key of keys) {
      expect(copy[key].trim().length, `${locale}.${key}`).toBeGreaterThan(0);
      expect(copy[key]).not.toMatch(/undefined|TODO|TODO_TRANSLATE|<script/i);
      expect(distributionText(locale, key)).toBe(copy[key]);
    }
    if (locale !== "en") expect(copy.content).not.toBe(DISTRIBUTION_UI_COPY.en.content);
  });
  it("has exactly seven interface languages and preserves Sanskrit for content", () => {
    expect([...DISTRIBUTION_UI_LOCALES].sort()).toEqual(["en", "gu", "hi", "kn", "ml", "ta", "te"]);
    expect(Object.keys(DISTRIBUTION_LANGUAGE_NAMES).sort()).toEqual([
      "en",
      "gu",
      "hi",
      "kn",
      "ml",
      "sa",
      "ta",
      "te",
    ]);
    expect(DISTRIBUTION_LANGUAGE_NAMES.sa).toBe("संस्कृतम्");
    expect(distributionText("unknown", "content")).toBe(DISTRIBUTION_UI_COPY.en.content);
    expect(distributionText(undefined, "content")).toBe(DISTRIBUTION_UI_COPY.en.content);
  });
  it("uses localized safe errors and never exposes an unknown error payload", () => {
    for (const locale of DISTRIBUTION_UI_LOCALES) {
      expect(distributionErrorText(locale, "REVISION_CONFLICT")).toBe(
        DISTRIBUTION_UI_COPY[locale].conflict,
      );
      expect(distributionErrorText(locale, "postgres://secret@example.invalid/private")).toBe(
        DISTRIBUTION_UI_COPY[locale].error,
      );
      expect(distributionErrorText(locale, "constructor")).toBe(DISTRIBUTION_UI_COPY[locale].error);
    }
  });
});
