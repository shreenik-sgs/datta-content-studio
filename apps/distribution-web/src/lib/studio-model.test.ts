import { expect, it } from "vitest";
import { studioMessage } from "./studio-model";

it("distinguishes encoder capacity from stalled encoding and provider failures", () => {
  expect(studioMessage("RENDER_TIMEOUT")).toContain("rendering capacity");
  expect(studioMessage("RENDER_TIMEOUT")).toContain("saved work");
  expect(studioMessage("RENDER_STALLED")).toContain("stopped making progress");
  expect(studioMessage("RENDER_STALLED")).not.toBe(studioMessage("GENERATION_FAILED"));
});

it("explains transcription capacity recovery without hiding it behind a generic failure", () => {
  const message = studioMessage("STUDIO_TRANSCRIPTION_CONTEXT_LIMIT");
  expect(message).toContain("speech service");
  expect(message).toContain("completed sections are saved");
  expect(message).toContain("smaller sections");
  expect(message).not.toBe(studioMessage("GENERATION_FAILED"));
});

it("explains the owner's spending-cap action without suggesting another automatic retry", () => {
  const message = studioMessage("STUDIO_PROVIDER_SPEND_CAP_REACHED");
  expect(message).toContain("Google AI Studio → Spend → Monthly spend cap");
  expect(message).toContain("Automatic retries have stopped");
  expect(message).toContain("saved work is retained");
  expect(message).toContain("Adding credits alone does not raise this cap");
});
