import {
  STUDIO_CONTENT_REVIEW_CHECKS,
  type StudioContentReview,
} from "@satsang/distribution-domain";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StudioGenerationProgressView } from "./studio-generation-progress";
import { StudioQualitySelection } from "./studio-quality-selection";

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => vi.unstubAllGlobals());

it("explains a music-only source without presenting a service error or completed file", () => {
  const html = renderToStaticMarkup(
    <StudioGenerationProgressView
      value={{
        phase: "drafting",
        provider: "gemini",
        completed: 1,
        total: 1,
        errorCode: "STUDIO_NO_SUITABLE_CHANNELS",
        excludedChannels: [
          {
            channel: "youtube",
            reason: "This recording contains music without a complete teaching.",
          },
        ],
      }}
      waiting={false}
      formatTimestamp={(value) => value}
    />,
  );
  expect(html).toContain("No suitable excerpt found");
  expect(html).toContain("music without a complete teaching");
  expect(html).toContain("No file was created or approved");
  expect(html).toContain("Other recordings in this bundle continue normally");
  expect(html).not.toContain("<progress");
  expect(html).not.toContain('role="alert"');
  expect(html).not.toContain('class="notice error"');
});
it("identifies the interrupted stage and safe recovery for an unexpected exception", () => {
  const html = renderToStaticMarkup(
    <StudioGenerationProgressView
      value={{
        phase: "rendering",
        provider: "local",
        completed: 1,
        total: 2,
        errorCode: "GENERATION_FAILED",
      }}
      waiting={false}
      formatTimestamp={(value) => value}
    />,
  );
  expect(html).toContain("Stopped during: Creating branded files and subtitles");
  expect(html).toContain("Retry the unfinished recording");
  expect(html).not.toContain("This action is unavailable");
});

it("explains excluded proposals separately from finished files and human approval", () => {
  const html = renderToStaticMarkup(
    <StudioQualitySelection
      messages={[
        {
          messageId: "message-02",
          title: "The incomplete question",
          reasons: ["The answer was outside this clip."],
        },
      ]}
    />,
  );
  expect(html).toContain("<details");
  expect(html).not.toContain('open=""');
  expect(html).toContain("The answer was outside this clip.");
  expect(html).toContain("still need human approval before publication");
  expect(renderToStaticMarkup(<StudioQualitySelection />)).toBe("");
});

it("does not display passed review findings as problems during generation", () => {
  const passed = {
    channel: "youtube",
    language: "en",
    messageId: "message-01",
    reason: "This message passed.",
    ...Object.fromEntries(STUDIO_CONTENT_REVIEW_CHECKS.map((key) => [key, true])),
  } as StudioContentReview;
  const html = renderToStaticMarkup(
    <StudioGenerationProgressView
      value={{
        phase: "reviewing",
        provider: "gemini",
        completed: 0,
        total: 1,
        reviewIssues: [
          passed,
          {
            ...passed,
            messageId: "message-02",
            endingComplete: false,
            reason: "The ending is incomplete.",
          },
        ],
      }}
      waiting={false}
      formatTimestamp={(value) => value}
    />,
  );
  expect(html).toContain("The ending is incomplete.");
  expect(html).not.toContain("This message passed.");
});

it("keeps an unsuitable-source failure distinct in package labels and workflow guidance", async () => {
  const { studioStatusLabel } = await import("../lib/studio-model");
  const { studioWorkflow } = await import("@satsang/distribution-domain");
  const pkg = {
    status: "FAILED" as const,
    revision: 1,
    isTest: true,
    feedback: [],
    outputs: [],
    failure: "STUDIO_NO_SUITABLE_CHANNELS",
  };
  expect(studioStatusLabel(pkg)).toBe("No suitable excerpt found");
  expect(studioWorkflow({ package: pkg }).message).toContain("Review the source and guidance");
  expect(studioStatusLabel({ ...pkg, failure: "GENERATION_FAILED" })).toBe(
    "Generation needs attention",
  );
});
