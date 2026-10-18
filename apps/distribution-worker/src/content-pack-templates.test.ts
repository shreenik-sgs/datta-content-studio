/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  type ContentPackInput,
  STATIC_POST_DIMENSIONS,
  VERTICAL_VIDEO_SLOT,
  renderBlogPreview,
  renderStaticPost,
  renderVerticalVideoBackdrop,
} from "./content-pack-templates";

const pixel =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5coAAAAASUVORK5CYII=";
const input: ContentPackInput = {
  profile: {
    ashramaName: "Avadhoota Datta Peetham",
    speakerName: "Sri Ganapathy Sachchidananda Swamiji",
    logoDataUrl: pixel,
  },
  context: {
    episodeTitle: "Episode 249 · Sabha Parva",
    headline: "A story and its wider context",
    summary: "A source-grounded editorial summary, prepared for review.",
    attribution: "Discourse narration; story characters retain their own attribution.",
    sourceLabel: "Source discourse · 00:42–01:24",
  },
};
const doc = (html: string) => new DOMParser().parseFromString(html, "text/html");

describe("offline branded content-pack templates", () => {
  it("keeps the video overlay region exact and marks the artwork as unapproved", () => {
    const document = doc(renderVerticalVideoBackdrop(input));
    const slot = document.getElementById("source-video-slot");
    for (const [attribute, value] of Object.entries(VERTICAL_VIDEO_SLOT))
      expect(slot?.getAttribute(attribute)).toBe(String(value));
    expect(document.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 1080 1920");
    expect(document.body.textContent).toContain("TEST PREVIEW");
    expect(document.body.textContent).toContain("EDITORIAL SUMMARY");
    expect(document.body.textContent).toContain("story characters retain their own");
  });

  it.each(Object.keys(STATIC_POST_DIMENSIONS) as (keyof typeof STATIC_POST_DIMENSIONS)[])(
    "contains the complete source image and bounded artwork for %s",
    (aspect) => {
      const document = doc(renderStaticPost({ ...input, aspect, sourceFrameDataUrl: pixel }));
      const size = STATIC_POST_DIMENSIONS[aspect];
      expect(document.querySelector("svg")?.getAttribute("viewBox")).toBe(
        `0 0 ${size.width} ${size.height}`,
      );
      expect(document.querySelectorAll("image")).toHaveLength(2);
      for (const image of document.querySelectorAll("image")) {
        expect(image.getAttribute("preserveAspectRatio")).toBe("xMidYMid meet");
        expect(
          Number(image.getAttribute("x")) + Number(image.getAttribute("width")),
        ).toBeLessThanOrEqual(size.width);
        expect(
          Number(image.getAttribute("y")) + Number(image.getAttribute("height")),
        ).toBeLessThanOrEqual(size.height);
      }
      for (const text of document.querySelectorAll("text"))
        expect(Number(text.getAttribute("y"))).toBeLessThan(size.height);
    },
  );

  it("renders hostile markup as literal text in SVG, HTML headings and attributes", () => {
    const hostile = '</text><script>alert("x")</script>&';
    const value: ContentPackInput = {
      profile: { ashramaName: hostile, speakerName: hostile },
      context: { episodeTitle: hostile, headline: hostile, summary: hostile, attribution: hostile },
    };
    // Space the hostile content so it fits normal headline wrapping without deleting characters.
    value.context.headline = "<script> \"x\" & 'y' </script>";
    const documents = [
      doc(renderVerticalVideoBackdrop(value)),
      doc(renderStaticPost({ ...value, aspect: "4:5", sourceFrameDataUrl: pixel })),
      doc(
        renderBlogPreview({
          ...value,
          sourceFrameDataUrl: pixel,
          sections: [{ heading: hostile, paragraphs: [hostile] }],
        }),
      ),
    ];
    for (const document of documents) {
      expect(document.querySelector("script,iframe,object,embed,link")).toBeNull();
      expect(document.querySelector("[onerror],[onload],[onclick]")).toBeNull();
      expect(document.body.textContent).toContain(hostile);
      expect(document.title).toContain(value.context.headline);
      expect(
        document
          .querySelector('meta[http-equiv="Content-Security-Policy"]')
          ?.getAttribute("content"),
      ).toContain("default-src 'none'");
    }
  });

  it.each([
    "https://example.test/logo.png",
    "file:///private/secret.png",
    "javascript:alert(1)",
    "data:image/svg+xml;base64,PHN2Zy8+",
    'data:image/png;base64,AAAA" onload="alert(1)',
  ])("refuses a nonlocal or active image source: %s", (source) => {
    expect(() =>
      renderVerticalVideoBackdrop({ ...input, profile: { ...input.profile, logoDataUrl: source } }),
    ).toThrow("CONTENT_PACK_LOCAL_RASTER_REQUIRED");
    expect(() => renderStaticPost({ ...input, aspect: "1:1", sourceFrameDataUrl: source })).toThrow(
      "CONTENT_PACK_LOCAL_RASTER_REQUIRED",
    );
    expect(() => renderBlogPreview({ ...input, sourceFrameDataUrl: source, sections: [] })).toThrow(
      "CONTENT_PACK_LOCAL_RASTER_REQUIRED",
    );
  });

  it("fails explicitly instead of clipping or silently changing overlong editorial text", () => {
    expect(() =>
      renderVerticalVideoBackdrop({
        ...input,
        context: { ...input.context, summary: "The full context matters. ".repeat(30) },
      }),
    ).toThrow("CONTENT_PACK_TEXT_DOES_NOT_FIT:summary");
    expect(() =>
      renderStaticPost({
        ...input,
        aspect: "16:9",
        sourceFrameDataUrl: pixel,
        context: { ...input.context, headline: "Unbreakable".repeat(20) },
      }),
    ).toThrow("CONTENT_PACK_TEXT_DOES_NOT_FIT:headline");
  });

  it("refuses unsupported or inherited aspect keys from serialized input", () => {
    for (const aspect of ["9:16", "__proto__", "constructor"]) {
      const serialized = JSON.parse(
        JSON.stringify({ ...input, aspect, sourceFrameDataUrl: pixel }),
      );
      expect(() => renderStaticPost(serialized)).toThrow("CONTENT_PACK_UNSUPPORTED_ASPECT");
    }
  });

  it("produces the same self-contained markup after a JSON round trip", () => {
    expect(renderVerticalVideoBackdrop(JSON.parse(JSON.stringify(input)))).toBe(
      renderVerticalVideoBackdrop(input),
    );
    const document = doc(
      renderBlogPreview({
        ...input,
        sourceFrameDataUrl: pixel,
        sections: [
          { heading: "Context", paragraphs: ["This is editorial prose, not a quotation."] },
        ],
      }),
    );
    expect(
      [...document.querySelectorAll("img")].every((image) => image.src.startsWith("data:image/")),
    ).toBe(true);
    expect(document.querySelector("a,script,iframe,link,form")).toBeNull();
  });
});
