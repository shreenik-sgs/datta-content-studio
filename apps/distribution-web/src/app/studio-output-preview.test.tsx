// @vitest-environment jsdom
import { type ContentRights, STUDIO_CHANNELS } from "@satsang/distribution-domain";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicStudioOutput, PublicStudioPackage } from "../lib/studio-model";
import { GenerationFields, StudioOutputPreview, studioGenerationDefaults } from "./studio-panel";

const asset = {
  filename: "SGS_master-youtube-short-en.mp4",
  sha256: "a".repeat(64),
  byteSize: 1000,
  mimeType: "video/mp4",
};
const output: PublicStudioOutput = {
  id: "output-one",
  channel: "youtube",
  format: "short",
  language: "en",
  title: "Daily practice",
  body: "Serve with kindness.\n\nSGS Datta Sannidhi",
  rationale: "A complete teaching selected for this audience.",
  included: true,
  sourceSegmentIds: ["one"],
  startMs: 1500,
  endMs: 63500,
  aspect: "9:16",
  captions: [
    { language: "en", translated: true, asset: { ...asset, mimeType: "text/vtt" } },
    { language: "te", translated: false, asset: { ...asset, mimeType: "text/vtt" } },
  ],
  warnings: ["Check the translation before approval."],
  asset,
};
const value: PublicStudioPackage = {
  id: "package-one",
  isTest: true,
  revision: 4,
  status: "DRAFT",
  createdBy: "coordinator",
  contributorIds: ["coordinator"],
  source: {
    masterId: "master-one",
    versionId: "source-one",
    sha256: "a".repeat(64),
    revision: 2,
    title: "Episode 249",
    language: "te",
    category: "pravachanams",
    mimeType: "video/mp4",
  },
  request: { languages: ["en"], instructions: "", channels: ["youtube"], captions: true },
  outputs: [output],
  approval: null,
  provenance: null,
  feedback: [],
  failure: null,
  createdAt: "2026-10-09T07:00:00.000Z",
  updatedAt: "2026-10-10T10:00:00.000Z",
};

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => vi.unstubAllGlobals());

describe("selected output review preview", () => {
  it.each([false, true])(
    "avoids Safari's automatic extra caption layer only for embedded subtitles (%s)",
    async (embedded) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      try {
        await act(async () =>
          root.render(
            <StudioOutputPreview
              value={{ ...value, request: { ...value.request, captions: embedded } }}
              output={output}
              canDownload={false}
            />,
          ),
        );
        const video = host.querySelector("video") as HTMLVideoElement;
        const track = { mode: "showing" };
        Object.defineProperty(video, "textTracks", { value: [track] });
        await act(async () => video.dispatchEvent(new Event("loadedmetadata")));
        expect(track.mode).toBe(embedded ? "disabled" : "showing");
        // A viewer can still choose the accessible native CC track explicitly.
        track.mode = "showing";
        await act(async () => video.dispatchEvent(new Event("timeupdate")));
        expect(track.mode).toBe("showing");
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );

  it("keeps output languages selectable before translation readiness is available", () => {
    const html = renderToStaticMarkup(
      <GenerationFields
        request={studioGenerationDefaults()}
        translation={false}
        localDrafting={false}
      />,
    );
    expect(html).not.toContain("disabled");
    expect(html).toContain('value="te"');
    expect(html).toContain('value="en"');
    expect(html).toContain("You can select output languages now.");
  });

  it("defaults new packages to English with embedded subtitles enabled", () => {
    expect(studioGenerationDefaults()).toMatchObject({ languages: ["en"], captions: true });
  });

  it("turns on the English CC track when there are no embedded subtitles", () => {
    const html = renderToStaticMarkup(
      <StudioOutputPreview
        value={{ ...value, request: { ...value.request, captions: false } }}
        output={output}
        canDownload={false}
      />,
    );
    expect(html).toMatch(/<track[^>]*default=""[^>]*srcLang="en"/);
    expect(html).not.toMatch(/<track[^>]*default=""[^>]*srcLang="te"/);
  });

  it("separates the actual video from public copy and collapsed internal rationale", () => {
    const html = renderToStaticMarkup(
      <StudioOutputPreview value={value} output={output} canDownload={false} />,
    );
    const videoSection = html.slice(0, html.indexOf("</section>"));
    expect(videoSection).toContain("Video file");
    expect(videoSection).not.toContain(output.body);
    expect(videoSection).not.toContain(output.rationale);
    expect(html).toContain("YouTube Shorts description");
    expect(html).toContain("Published alongside the video.");
    expect(html).toContain('lang="en"');
    expect(html).toContain("Internal review notes · not posted</summary>");
    expect(html).not.toContain("<details open");
    expect(html).not.toContain("Download this short");
  });

  it("distinguishes retained Telugu audio, embedded English translation and optional extra CC", () => {
    const html = renderToStaticMarkup(
      <StudioOutputPreview value={value} output={output} canDownload={false} />,
    );
    expect(html).toContain("Original audio:</strong> తెలుగు");
    expect(html).toContain("Embedded subtitles:</strong> English (translation)");
    expect(html).toContain("remain visible when player CC is off");
    expect(html).toContain("Optional player CC tracks");
    expect(html).toContain("second caption layer");
    expect(html).toContain('label="తెలుగు (source) — optional CC"');
    expect(html).not.toMatch(/<track[^>]*default/);
  });

  it("does not claim captions exist when generation omitted them", () => {
    const html = renderToStaticMarkup(
      <StudioOutputPreview
        value={{ ...value, request: { ...value.request, captions: false } }}
        output={{ ...output, captions: [] }}
        canDownload={false}
      />,
    );
    expect(html).toContain("None in this generated file.");
    expect(html).not.toContain("Optional player CC tracks");
    expect(html).not.toContain("second caption layer");
  });

  it("labels a Facebook image and its accompanying public post separately", () => {
    const html = renderToStaticMarkup(
      <StudioOutputPreview
        value={value}
        output={{
          ...output,
          channel: "facebook",
          format: "post",
          asset: { ...asset, mimeType: "image/png", filename: "SGS_facebook-post-en.png" },
          captions: [],
        }}
        canDownload
      />,
    );
    expect(html).toContain("Image file");
    expect(html).toContain("Facebook post text");
    expect(html).not.toContain("Original audio");
    expect(html).not.toContain("Embedded subtitles");
    expect(html).toContain("Download this post");
  });

  it("labels article copy without inventing a media or audio preview", () => {
    const html = renderToStaticMarkup(
      <StudioOutputPreview
        value={value}
        output={{
          ...output,
          channel: "website",
          format: "blog",
          asset: { ...asset, mimeType: "text/markdown", filename: "SGS_blog-en.md" },
          captions: [],
        }}
        canDownload={false}
      />,
    );
    expect(html).toContain("Blog article");
    expect(html).toContain("Audience-facing article");
    expect(html).not.toContain("Image file");
    expect(html).not.toContain("Video file");
    expect(html).not.toContain("Original audio");
  });
});

describe("generation follows the master’s permitted channels", () => {
  const rights: ContentRights = {
    owner: "Ashrama",
    authorizationBasis: "Permission",
    territories: ["WORLDWIDE"],
    privacyClass: "PUBLIC",
    releaseAt: null,
    expiresAt: null,
    channels: [
      "youtube",
      "instagram",
      "facebook",
      "x",
      "reddit",
      "tiktok",
      "pinterest",
      "telegram",
      "whatsapp",
      "website",
    ],
  };
  it("requests the ten authorized channels, without silently adding excluded channels", () => {
    const request = studioGenerationDefaults({ rights });
    expect(request.channels).toEqual(rights.channels);
    expect(request.channels).not.toContain("threads");
    expect(request.channels).not.toContain("linkedin");
    expect(request.channels).not.toContain("bluesky");
  });
  it("does not turn manual export permission into social generation permission", () => {
    expect(
      studioGenerationDefaults({ rights: { ...rights, channels: ["manual_export"] } }).channels,
    ).toEqual([]);
  });
  it("offers all supported defaults only before rights have been saved", () => {
    expect(studioGenerationDefaults({ rights: null }).channels).toEqual(STUDIO_CHANNELS);
  });
});

it("shows AI success separately from pending human approval", () => {
  const aiReview = {
    status: "PASSED" as const,
    policyVersion: "content-integrity-v1" as const,
    provider: "gemini" as const,
    model: "synthetic",
    recordedAt: "2026-10-12T04:00:00Z",
    inputMode: "transcript_and_audio" as const,
    sourceSha256: "a".repeat(64),
    fileVersion: 1,
    humanFeedbackConsidered: true,
    checks: {
      channel: "youtube",
      language: "en",
      openingComplete: true,
      endingComplete: true,
      contextComplete: true,
      attributionCorrect: true,
      captionsFaithful: true,
      copySupported: true,
      reason: "The complete question and answer are included.",
    },
  };
  const html = renderToStaticMarkup(
    <StudioOutputPreview value={value} output={{ ...output, aiReview }} canDownload={false} />,
  );
  expect(html).toContain("Passed for this file version");
  expect(html).toContain("Pending Content Approver review");
  expect(html).toContain("does not authorize publishing");
  expect(html).toContain("Human correction comments considered");
  const legacy = renderToStaticMarkup(
    <StudioOutputPreview value={value} output={output} canDownload={false} />,
  );
  expect(legacy).toContain("No AI review recorded");
  expect(legacy).not.toContain("Passed for this file version");
});

it("offers a real app link separately from exported pixels while leaving it off legacy cards", async () => {
  const { studioClosingCardPlan } = await import("@satsang/distribution-domain");
  const presentationReview = {
    policy: "source-safe-portrait-v1" as const,
    sourceSha256: "a".repeat(64),
    renderedSha256: asset.sha256,
    fileVersion: 1,
    model: "fixture",
    reviewedAt: value.updatedAt,
    framing: "full-picture" as const,
    repairs: 0,
    source: {
      openingComplete: true,
      endingComplete: true,
      naturalStart: true,
      naturalEnd: true,
      reason: "Fixture",
      scenes: [],
    },
    checks: {
      illustrationsRelevant: true,
      textIntact: true,
      subjectIntact: true,
      captionsClear: true,
      naturalBoundaries: true,
      reason: "Fixture",
    },
    closingCard: studioClosingCardPlan(62000),
  };
  const html = renderToStaticMarkup(
    <StudioOutputPreview
      value={value}
      output={{ ...output, presentationReview }}
      canDownload={false}
    />,
  );
  expect(html).toContain('href="https://sgsdattasannidhi.org/"');
  const channel = renderToStaticMarkup(
    <StudioOutputPreview
      value={value}
      output={{
        ...output,
        thumbnail: { ...asset, mimeType: "image/png", filename: "thumbnail.png" },
        presentationReview: {
          ...presentationReview,
          closingCard: studioClosingCardPlan(62000, { destination: "youtube" }),
        },
      }}
      canDownload={false}
    />,
  );
  expect(channel).not.toContain('href="https://www.youtube.com/@sgsswamiji"');
  expect(channel).toContain("SriSwamiji");
  expect(channel).toContain("has not been configured yet");
  expect(channel).toContain(
    'poster="/distribution/api/studio/package-one/assets/output-one/thumbnail"',
  );
  expect(channel).not.toContain('href="https://sgsdattasannidhi.org/"');
  expect(channel).toContain("Closing-card channel:");
  const target = { label: "Gurubhavana ADPT", url: "https://www.youtube.com/@gurubhavanaadpt" };
  const custom = renderToStaticMarkup(
    <StudioOutputPreview
      value={value}
      output={{
        ...output,
        presentationReview: {
          ...presentationReview,
          closingCard: studioClosingCardPlan(62000, {
            youtubeClosing: target,
            sourceBranding: "bala-swamiji",
          }),
        },
      }}
      canDownload={false}
    />,
  );
  expect(custom).not.toContain(`href="${target.url}"`);
  expect(custom).toContain("Sri Datta Vijayananda Teertha Swamiji");
  expect(custom).toContain("has not been configured yet");
  const legacy = renderToStaticMarkup(
    <StudioOutputPreview
      value={value}
      output={{
        ...output,
        presentationReview: {
          ...presentationReview,
          closingCard: {
            ...studioClosingCardPlan(62000, { youtubeClosing: target }),
            policy: "clean-hold-closing-card-v2",
          },
        },
      }}
      canDownload={false}
    />,
  );
  expect(legacy).toContain(`href="${target.url}"`);
  expect(legacy).toContain(">Gurubhavana ADPT</a>");
  expect(custom).not.toContain('href="https://www.youtube.com/@sgsswamiji"');
  expect(custom).not.toContain('href="https://sgsdattasannidhi.org/"');
  expect(html).toContain("This player link is separate from the exported video.");
  expect(html).not.toContain('class="studio-card-download"'); // Hidden while opening/playing before the card.
  expect(
    renderToStaticMarkup(<StudioOutputPreview value={value} output={output} canDownload={false} />),
  ).not.toContain("App download:");
});
