import { expect, it } from "vitest";
import { studioMessage } from "./studio-model";

it("explains transcription capacity recovery without hiding it behind a generic failure", () => {
  const message = studioMessage("STUDIO_TRANSCRIPTION_CONTEXT_LIMIT");
  expect(message).toContain("speech service");
  expect(message).toContain("completed sections are saved");
  expect(message).toContain("smaller sections");
  expect(message).not.toBe(studioMessage("GENERATION_FAILED"));
});
