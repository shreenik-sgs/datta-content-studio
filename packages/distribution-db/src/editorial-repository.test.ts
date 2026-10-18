import { describe, expect, it } from "vitest";
import { validateGlossaryInput } from "./editorial-repository";

describe("DS-DIST-R2-GLOSSARY persistence boundary", () => {
  it("DS-DIST-R2-GLOSSARY refuses blank or excessive terms and unsupported languages", () => {
    expect(() =>
      validateGlossaryInput({ term: "Ganapathi", preferred: "Ganapati", language: "sa" }),
    ).not.toThrow();
    expect(() =>
      validateGlossaryInput({ term: " ", preferred: "Ganapati", language: "sa" }),
    ).toThrow("INVALID_GLOSSARY_ENTRY");
    expect(() =>
      validateGlossaryInput({ term: "a".repeat(201), preferred: "Ganapati", language: "sa" }),
    ).toThrow("INVALID_GLOSSARY_ENTRY");
    expect(() =>
      validateGlossaryInput({ term: "Ganapathi", preferred: "Ganapati", language: "invalid" }),
    ).toThrow("INVALID_GLOSSARY_ENTRY");
  });
});
