import { expect, it } from "vitest";
import { REVIEWER_LANGUAGES, reviewerLanguageBlocker } from "./reviewer-languages";
it("names the missing source language and how an Admin can fix it", () => {
  expect(reviewerLanguageBlocker("te", ["en"])).toContain("Telugu");
  expect(reviewerLanguageBlocker("kn", ["te"])).toContain("Settings → Reviewer languages");
  expect(reviewerLanguageBlocker("ta", ["te", "kn", "ta"])).toBeNull();
  expect(Object.keys(REVIEWER_LANGUAGES)).toEqual(
    expect.arrayContaining(["en", "hi", "te", "kn", "ta"]),
  );
});
