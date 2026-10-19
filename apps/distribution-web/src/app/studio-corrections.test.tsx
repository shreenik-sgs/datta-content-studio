// @vitest-environment jsdom
import { STUDIO_MEDIA_DEFAULTS } from "@satsang/distribution-domain";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PublicStudioPackage } from "../lib/studio-model";
import { ManualFile } from "./studio-corrections";

const segments = [
  { id: "one", startMs: 1000, endMs: 5000, text: "Practice kindness." },
  { id: "two", startMs: 5000, endMs: 9000, text: "Serve with care." },
];
const value: PublicStudioPackage = {
  id: "package",
  isTest: true,
  revision: 4,
  status: "DRAFT",
  createdBy: "curator",
  contributorIds: ["curator"],
  source: {
    masterId: "master",
    versionId: "version",
    sha256: "a".repeat(64),
    revision: 2,
    title: "Teaching",
    language: "en",
    category: "other",
    mimeType: "video/mp4",
  },
  request: { languages: ["en"], channels: ["youtube"], instructions: "", captions: true },
  outputs: [
    {
      id: "one",
      channel: "youtube",
      format: "short",
      language: "en",
      title: "Practice kindness",
      body: "Serve with care.\n\n@sgsswamiji",
      rationale: "Complete thought",
      included: true,
      sourceSegmentIds: ["one", "two"],
      startMs: 1000,
      endMs: 9000,
      aspect: "9:16",
      asset: null,
      captions: [],
      captionCues: segments,
      warnings: [],
    },
  ],
  provenance: {
    transcript: {
      language: "en",
      durationMs: 9000,
      segments,
      provenance: "MACHINE_TRANSCRIPT",
      sourceTranscriptId: null,
    },
    promptVersion: "test",
    brandName: "@sgsswamiji",
    brandLogoSha256: "a".repeat(64),
    provider: "local",
    model: "local",
    generatedAt: "2026-10-19T00:00:00.000Z",
    skippedChannels: [],
  },
  approval: null,
  feedback: [],
  failure: null,
  createdAt: "2026-10-19T00:00:00.000Z",
  updatedAt: "2026-10-19T00:00:00.000Z",
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const button = (text: string) =>
  Array.from(host.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(text),
  ) as HTMLButtonElement;
const submit = () =>
  act(async () => {
    host
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

it.each([true, false])(
  "saves only the selected file with one atomic action (render=%s)",
  async (available) => {
    const onAction = vi.fn().mockResolvedValue({ package: value });
    await act(async () =>
      root.render(
        <ManualFile
          value={value}
          outputId="one"
          busy={false}
          available={available}
          onAction={onAction}
        />,
      ),
    );
    expect(host.querySelector("video")?.getAttribute("src")).toContain(
      "/master/media?versionId=version",
    );
    await submit();
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith(
      "revise",
      expect.objectContaining({
        render: available,
        expectedRevision: 4,
        outputs: [
          expect.objectContaining({
            id: "one",
            mediaEdits: STUDIO_MEDIA_DEFAULTS,
            sourceSegmentIds: ["one", "two"],
          }),
        ],
      }),
    );
  },
);

it("keeps the form and explains an unconfirmed save instead of launching regeneration", async () => {
  const onAction = vi.fn().mockRejectedValue(new Error("offline"));
  await act(async () =>
    root.render(
      <ManualFile value={value} outputId="one" busy={false} available onAction={onAction} />,
    ),
  );
  await submit();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("edits remain here");
  expect((host.querySelector('[name="title"]') as HTMLInputElement).value).toBe(
    "Practice kindness",
  );
  expect(onAction).toHaveBeenCalledTimes(1);
});

it("handles playback failure and snaps a playhead selection to source passages", async () => {
  const onAction = vi.fn().mockResolvedValue({ package: value });
  await act(async () =>
    root.render(
      <ManualFile value={value} outputId="one" busy={false} available onAction={onAction} />,
    ),
  );
  const video = host.querySelector('[aria-label="Original video"]') as HTMLVideoElement;
  await act(async () => {
    video.dispatchEvent(new Event("loadedmetadata"));
    video.currentTime = 6;
    video.dispatchEvent(new Event("timeupdate"));
  });
  await act(async () => button("Start at this passage").click());
  await submit();
  expect(onAction.mock.calls[0]?.[1].outputs[0].sourceSegmentIds).toEqual(["two"]);
  await act(async () => video.dispatchEvent(new Event("error")));
  expect(host.textContent).toContain("original recording could not load");
  expect(button("Preview selected passage").disabled).toBe(true);
  expect(button("Retry playback")).toBeTruthy();
});

it("explains an invalid end selection and retains the valid range", async () => {
  const onAction = vi.fn();
  await act(async () =>
    root.render(
      <ManualFile value={value} outputId="one" busy={false} available onAction={onAction} />,
    ),
  );
  const first = host.querySelector('[aria-label="First source passage"]') as HTMLSelectElement;
  const last = host.querySelector('[aria-label="Last source passage"]') as HTMLSelectElement;
  await act(async () => {
    first.value = "two";
    first.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    last.value = "one";
    last.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(host.textContent).toContain("last passage must follow the first");
  expect(last.value).toBe("two");
});

it("trims exactly two seconds on the Short timeline and clips editable captions without mutating source evidence", async () => {
  const onAction = vi.fn().mockResolvedValue({ package: value });
  await act(async () =>
    root.render(
      <ManualFile value={value} outputId="one" busy={false} available onAction={onAction} />,
    ),
  );
  const video = host.querySelector('[aria-label="Curated video trim preview"]') as HTMLVideoElement;
  await act(async () => {
    video.dispatchEvent(new Event("loadedmetadata"));
    video.currentTime = 3;
    video.dispatchEvent(new Event("timeupdate"));
  });
  await act(async () => button("Set start here").click());
  expect((host.querySelector('[aria-label="Start (seconds)"]') as HTMLInputElement).value).toBe(
    "2",
  );
  await act(async () => button("Preview trim").click());
  expect(video.currentTime).toBe(3);
  expect(onAction).not.toHaveBeenCalled();
  await submit();
  expect(onAction.mock.calls[0]?.[1].outputs).toEqual([
    expect.objectContaining({
      id: "one",
      sourceTrim: { startMs: 3000, endMs: 9000 },
      captionCues: [{ ...segments[0], startMs: 3000 }, segments[1]],
    }),
  ]);
  expect(value.provenance?.transcript.segments[0]?.startMs).toBe(1000);
});
it("blocks reversed trim ranges with a specific explanation", async () => {
  const onAction = vi.fn();
  await act(async () =>
    root.render(
      <ManualFile value={value} outputId="one" busy={false} available onAction={onAction} />,
    ),
  );
  const video = host.querySelector('[aria-label="Curated video trim preview"]') as HTMLVideoElement;
  await act(async () => {
    video.dispatchEvent(new Event("loadedmetadata"));
    video.currentTime = 1;
    video.dispatchEvent(new Event("timeupdate"));
  });
  await act(async () => button("Set end here").click());
  expect(host.textContent).toContain("keeping at least one second");
  expect(button("Save & rebuild").disabled).toBe(true);
  await submit();
  expect(onAction).not.toHaveBeenCalled();
});
