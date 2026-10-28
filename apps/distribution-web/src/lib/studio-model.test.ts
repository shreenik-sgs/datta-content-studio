import { expect, it } from "vitest";
import { studioMessage, studioPublicationMessage } from "./studio-model";

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

it("names a posting failure code instead of the generic refresh text, and appends the channel's reason", () => {
  expect(studioMessage("STUDIO_MEDIA_ACCESS_EXPIRED")).toContain("24 hours");
  expect(
    studioPublicationMessage({ error: "STUDIO_MEDIA_ACCESS_EXPIRED", errorDetail: null }),
  ).toContain("Post again");
  const unknown = studioPublicationMessage({ error: "SOME_NEW_WORKER_CODE", errorDetail: null });
  expect(unknown).toContain("SOME_NEW_WORKER_CODE");
  expect(unknown).not.toContain("Refresh the package and check its source and service readiness");
  expect(
    studioPublicationMessage({
      error: "BUFFER_PUBLISH_FAILED",
      errorDetail: "The user has exceeded the number of videos they may upload.",
    }),
  ).toContain(
    "The channel reported: \u201cThe user has exceeded the number of videos they may upload.\u201d",
  );
  expect(studioPublicationMessage({ error: null, errorDetail: null })).toBe("");
});
