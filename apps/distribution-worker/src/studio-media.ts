import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_STUDIO_VIDEO_BYTES,
  STUDIO_FRAME,
  STUDIO_PICTURE,
  STUDIO_SUBTITLE_TOP,
  type StudioClosingCard,
  type StudioMediaEdits,
  type StudioOpeningCard,
  type StudioPortraitScene,
  type StudioPresentationLayout,
  type StudioSegment,
  type StudioSourceBranding,
  studioFullPictureRegion,
  studioSourceBranding,
  studioSpeechTarget,
  studioSubtitleSize,
  validateStudioAudioLevel,
  validateStudioClosingCard,
  validateStudioMediaEdits,
  validateStudioOpeningCard,
} from "@satsang/distribution-domain";
import sharp from "sharp";
import { measureStudioAudio, studioAudioNormalization, studioNoiseFilter } from "./studio-audio.js";
import { executeStudioSource } from "./studio-process.js";
import { studioRenderBudget } from "./studio-render-budget.js";

const escapeMarkup = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
const splitGraphemes = (value: string) =>
  Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value),
    (part) => part.segment,
  );
/** Break at words whenever possible, without splitting an Indic conjunct or losing whitespace. */
function wrapGraphemes(value: string, columns: number): string[] {
  const graphemes = splitGraphemes(value);
  const result: string[] = [];
  let start = 0;
  while (start < graphemes.length) {
    let end = Math.min(start + columns, graphemes.length);
    if (end < graphemes.length && !/^\s+$/u.test(graphemes[end] ?? "")) {
      for (let boundary = end; boundary > start; boundary--) {
        if (/^\s+$/u.test(graphemes[boundary - 1] ?? "")) {
          end = boundary;
          break;
        }
      }
    }
    result.push(graphemes.slice(start, end).join(""));
    start = end;
  }
  return result.length ? result : [""];
}
function wrap(value: string, columns: number, maximum: number): string[] {
  const wrapped = wrapGraphemes(value.trim(), columns);
  const result = wrapped.slice(0, maximum).map((line) => line.trim());
  if (wrapped.length > maximum) {
    const last = splitGraphemes(result[maximum - 1] ?? "");
    result[maximum - 1] = `${last.slice(0, -1).join("")}…`;
  }
  return result;
}
function lines(
  value: string,
  x: number,
  y: number,
  size: number,
  width: number,
  max: number,
  color = "#481b2b",
) {
  return wrap(value, width, max)
    .map(
      (line, i) =>
        `<text x="${x}" y="${y + i * size * 1.5}" font-family="sans-serif" font-size="${size}" fill="${color}">${escapeMarkup(line)}</text>`,
    )
    .join("");
}
const image = (bytes: Uint8Array) =>
  `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;

// Preserve proportions while framing the speaker prominently; captions remain outside the picture.
export const STUDIO_VIDEO_FRAME = STUDIO_PICTURE;
export const STUDIO_CAPTION_TOP = STUDIO_SUBTITLE_TOP;

/** Fixed Ashrama artwork. Source/AI strings never become markup. */
export async function studioArtwork(input: {
  sourceBranding?: StudioSourceBranding | undefined;
  logo: Uint8Array;
  title: string;
  body: string;
  format: "video" | "post";
  sourceFrame?: Uint8Array;
  language: string;
}): Promise<Buffer> {
  const brand = studioSourceBranding(input.sourceBranding);
  const width = 1080;
  const height = input.format === "video" ? 1920 : 1350;
  const body = input.body.replace(/\n\n(?:@sgsswamiji|SGS Datta Sannidhi)\s*$/u, "");
  const picture = input.sourceFrame;
  const quoteCard = input.format === "post" && !picture;
  if (input.format === "video") {
    // Title and channel identity belong to the separate thumbnail/closing card.
    // Keep the playing picture free of a persistent promotional header.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920">
      ${picture ? `<svg x="${STUDIO_VIDEO_FRAME.x}" y="${STUDIO_VIDEO_FRAME.y}" width="${STUDIO_VIDEO_FRAME.width}" height="${STUDIO_VIDEO_FRAME.height}" overflow="hidden"><image href="${image(picture)}" width="${STUDIO_VIDEO_FRAME.width}" height="${STUDIO_VIDEO_FRAME.height}" preserveAspectRatio="xMidYMid meet"/></svg>` : ""}
    </svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
  }
  const logo = await sharp(input.logo)
    .resize(120, 120, { fit: "contain", background: "#fffaf2" })
    .png()
    .toBuffer();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="1080" height="${height}" fill="#fffaf2"/><rect width="1080" height="14" fill="#481b2b"/>
    <image href="${image(logo)}" x="48" y="46" width="120" height="120"/>
    ${lines(brand.name, 196, 94, 27, 52, 2)}${lines(brand.signature, 196, 157, 23, 58, 1, "#a12b58")}
    <path d="M48 204H1032" stroke="#e1d3bd"/>
    ${lines(input.title, 48, 284, 43, 41, 3)}
    <rect x="0" y="520" width="1080" height="608" fill="${quoteCard ? "#f2e8da" : "#21171d"}"/>
    ${picture ? `<image href="${image(picture)}" x="0" y="520" width="1080" height="608" preserveAspectRatio="xMidYMid meet"/>` : quoteCard ? `${lines("SOURCE-BASED REFLECTION", 48, 588, 21, 70, 1, "#a12b58")}${lines(body, 48, 674, 36, 48, 8)}` : ""}
    <path d="M48 ${height - 75}H1032" stroke="#e1d3bd"/>${lines(brand.signature, 48, height - 35, 23, 70, 1, "#a12b58")}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
/** A separate title thumbnail, never an opening frame added to the video timeline. */
export async function studioVideoThumbnail(picture: Uint8Array, title: string): Promise<Buffer> {
  const background = await sharp(picture)
    .resize(1080, 1920, { fit: "cover" })
    .blur(30)
    .modulate({ brightness: 0.45 })
    .png()
    .toBuffer();
  const foreground = await sharp(picture).resize(1080, 1200, { fit: "inside" }).png().toBuffer();
  const size = await sharp(foreground).metadata();
  const topic = await sharp({
    text: {
      text: `<span foreground="#ffffff">${escapeMarkup(title)}</span>`,
      font: "sans-serif bold 64",
      width: 880,
      height: 390,
      align: "centre",
      rgba: true,
    },
  })
    .png()
    .toBuffer();
  const textSize = await sharp(topic).metadata();
  return sharp(background)
    .composite([
      {
        input: foreground,
        left: Math.round((1080 - (size.width ?? 0)) / 2),
        top: Math.round(100 + (1200 - (size.height ?? 0)) / 2),
      },
      { input: topic, left: Math.round((1080 - (textSize.width ?? 0)) / 2), top: 1380 },
    ])
    .png()
    .toBuffer();
}

function timestamp(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}
export function studioVtt(segments: StudioSegment[], startMs: number, endMs: number): string {
  if (
    !segments.length ||
    segments.some((s) => s.startMs < startMs || s.endMs > endMs || s.endMs <= s.startMs)
  )
    throw new Error("STUDIO_CAPTION_BOUNDARY_INVALID");
  return `WEBVTT\n\n${studioCaptionPages(segments)
    .map(
      (s, i) =>
        `${i + 1}\n${timestamp(s.startMs - startMs)} --> ${timestamp(s.endMs - startMs)}\n${s.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, " ")}\n`,
    )
    .join("\n")}`;
}
async function captionTimeline(
  directory: string,
  segments: StudioSegment[],
  startMs: number,
  endMs: number,
  placement: { scenes: StudioPortraitScene[]; fitCaptionTop: number; fontSize: number },
): Promise<string> {
  const timeline: { duration: number; text: string }[] = [];
  let cursor = startMs;
  for (const s of studioCaptionPages(segments)) {
    if (s.startMs > cursor) timeline.push({ duration: s.startMs - cursor, text: "" });
    timeline.push({ duration: s.endMs - s.startMs, text: s.text });
    cursor = s.endMs;
  }
  if (cursor < endMs) timeline.push({ duration: endMs - cursor, text: "" });
  if (!timeline.length) timeline.push({ duration: endMs - startMs, text: "" });
  const entries: string[] = [];
  let elapsed = 0;
  const positioned = timeline.flatMap((cue) => {
    const start = elapsed;
    elapsed += cue.duration;
    const cuts = [
      ...new Set([
        start,
        elapsed,
        ...placement.scenes
          .flatMap((scene) => [scene.startMs, scene.endMs])
          .filter((t) => t > start && t < elapsed),
      ]),
    ].sort((a, b) => a - b);
    return cuts.slice(0, -1).map((t, i) => ({
      text: cue.text,
      duration: (cuts[i + 1] ?? elapsed) - t,
      top: placement.scenes.some((scene) => t >= scene.startMs && t < scene.endMs)
        ? STUDIO_CAPTION_TOP
        : placement.fitCaptionTop,
    }));
  });
  for (const [i, cue] of positioned.entries()) {
    const name = `cc-${i}.png`;
    await writeFile(
      join(directory, name),
      await studioCaptionImage(cue.text, cue.top, placement.fontSize),
      {
        mode: 0o600,
      },
    );
    entries.push(`file '${name}'\nduration ${(cue.duration / 1000).toFixed(3)}`);
  }
  entries.push(`file 'cc-${positioned.length - 1}.png'`);
  const path = join(directory, "captions.txt");
  await writeFile(path, entries.join("\n"), { mode: 0o600 });
  return path;
}
const CAPTION_LINE_GRAPHEMES = 24;
const CAPTION_PAGE_LINES = 3;
/** Retain every grapheme; split ordinary words only if a word exceeds the whole line. */
export function studioCaptionLines(text: string): string[] {
  return wrapGraphemes(text, CAPTION_LINE_GRAPHEMES);
}
/** Large centered captions occupy a bottom band outside the source picture, never covering Swamiji. */
export async function studioCaptionImage(
  text: string,
  top = STUDIO_CAPTION_TOP,
  fontSize = 72,
): Promise<Buffer> {
  if (![56, 72, 80].includes(fontSize)) throw Error("INVALID_STUDIO_MEDIA_EDITS");
  if (!Number.isSafeInteger(top) || top < 210 || top > STUDIO_CAPTION_TOP)
    throw Error("STUDIO_CAPTION_BOUNDARY_INVALID");
  const wrapped = studioCaptionLines(text);
  if (wrapped.length > CAPTION_PAGE_LINES) throw new Error("STUDIO_CAPTION_PAGE_TOO_LONG");
  // Measure the shaped font, because grapheme count alone cannot predict the width of
  // Telugu conjuncts or fallback glyphs. Preserve the text if a line needs a smaller font.
  const widths = await Promise.all(
    wrapped
      .filter((line) => line.trim())
      .map(async (line) => {
        const measured = await sharp({
          text: { text: escapeMarkup(line.trim()), font: `sans-serif ${fontSize}`, rgba: true },
        }).metadata();
        return measured.width ?? 0;
      }),
  );
  const size = Math.min(fontSize, Math.floor((fontSize * 828) / Math.max(1, ...widths)));
  const lineHeight = Math.ceil(size * 1.35);
  const height = wrapped.length * lineHeight + 36;
  // A fixed 12px gap keeps every cue close to the picture, regardless of line count.
  const captionText = wrapped
    .map(
      (line, n) =>
        `<text x="506" y="${top + 18 + size + n * lineHeight}" text-anchor="middle" font-family="sans-serif" font-size="${size}" fill="#ffffff">${escapeMarkup(line.trim())}</text>`,
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920">${text.trim() ? `<rect x="64" y="${top}" width="884" height="${height}" rx="18" fill="#161116" fill-opacity="0.78"/>${captionText}` : ""}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
/** Page at complete lines, preserving the original text and exact outer cue boundaries. */
export function studioCaptionPages(segments: StudioSegment[]): StudioSegment[] {
  return segments.flatMap((segment) => {
    const wrapped = studioCaptionLines(segment.text);
    const count = Math.ceil(wrapped.length / CAPTION_PAGE_LINES);
    if (segment.endMs - segment.startMs < count) throw new Error("STUDIO_CAPTION_BOUNDARY_INVALID");
    const pageText = Array.from({ length: count }, (_, i) =>
      wrapped.slice(i * CAPTION_PAGE_LINES, (i + 1) * CAPTION_PAGE_LINES).join(""),
    );
    const weights = pageText.map((text) => Math.max(1, splitGraphemes(text).length));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let consumed = 0;
    let cursor = segment.startMs;
    return pageText.map((text, i) => {
      consumed += weights[i] ?? 0;
      // Reserve one millisecond for every remaining page even for unusually short cues.
      const endMs =
        i === count - 1
          ? segment.endMs
          : Math.min(
              segment.endMs - (count - i - 1),
              Math.max(
                cursor + 1,
                segment.startMs +
                  Math.floor(((segment.endMs - segment.startMs) * consumed) / total),
              ),
            );
      const page = { ...segment, id: `${segment.id}-p${i + 1}`, text, startMs: cursor, endMs };
      cursor = endMs;
      return page;
    });
  });
}
/** Immersive stills are prepared slightly larger than the frame so the slow camera move crops, never upscales. */
export const STUDIO_MOTION_STILL = { width: 1296, height: 2304 } as const;
/** Fit the complete image without adding generator badges or obscuring sacred details. */
export async function studioIllustrationFrame(
  bytes: Uint8Array,
  layout: StudioPresentationLayout = "classic",
): Promise<Buffer> {
  if (layout === "immersive")
    return sharp(bytes)
      .resize(STUDIO_MOTION_STILL.width, STUDIO_MOTION_STILL.height, { fit: "cover" })
      .png()
      .toBuffer();
  const background = await sharp(bytes)
    .resize(STUDIO_VIDEO_FRAME.width, STUDIO_VIDEO_FRAME.height, { fit: "cover" })
    .blur(25)
    .modulate({ brightness: 0.6 })
    .png()
    .toBuffer();
  const foreground = await sharp(bytes)
    .resize(STUDIO_VIDEO_FRAME.width, STUDIO_VIDEO_FRAME.height, { fit: "inside" })
    .png()
    .toBuffer();
  const metadata = await sharp(foreground).metadata();
  return sharp(background)
    .composite([
      {
        input: foreground,
        left: Math.floor((STUDIO_VIDEO_FRAME.width - (metadata.width ?? 0)) / 2),
        top: Math.floor((STUDIO_VIDEO_FRAME.height - (metadata.height ?? 0)) / 2),
      },
    ])
    .png()
    .toBuffer();
}

/** A slow, alternating camera move on each still, so narration imagery reads as footage. */
export function studioMotionFilter(index: number, durationMs: number) {
  const frames = Math.max(2, Math.round((durationMs / 1000) * 30));
  const zoom = index % 2 === 0 ? `1+0.08*on/${frames}` : `1.08-0.08*on/${frames}`;
  const drift =
    index % 4 < 2 ? "0.5" : index % 4 === 2 ? `0.45+0.1*on/${frames}` : `0.55-0.1*on/${frames}`;
  return `zoompan=z='${zoom}':x='(iw-iw/zoom)*(${drift})':y='(ih-ih/zoom)/2':d=${frames}:s=${STUDIO_FRAME.width}x${STUDIO_FRAME.height}:fps=30`;
}
export async function renderStudioVideo(input: {
  mediaEdits?: StudioMediaEdits;
  /** immersive fills the whole frame; classic keeps the framed picture with captions below. */
  layout?: StudioPresentationLayout;
  ffmpeg: string;
  directory: string;
  sourcePath: string;
  mimeType: string;
  signal?: AbortSignal;
  backdrop: Uint8Array;
  hasVideo: boolean;
  sourceWidth?: number;
  sourceHeight?: number;
  scenes?: StudioPortraitScene[];
  illustrations?: { bytes: Uint8Array; startMs: number; endMs: number }[];
  closingCard?: { bytes: Uint8Array; plan: StudioClosingCard };
  openingCard?: { bytes: Uint8Array; plan: StudioOpeningCard };
  hasAudio: boolean;
  startMs: number;
  endMs: number;
  captions: StudioSegment[];
}): Promise<string> {
  if (input.mediaEdits) validateStudioMediaEdits(input.mediaEdits);
  const backdrop = join(input.directory, "backdrop.png");
  const destination = join(input.directory, "video.mp4");
  await writeFile(backdrop, input.backdrop, { mode: 0o600 });
  const width = input.sourceWidth ?? 1920;
  const height = input.sourceHeight ?? 1080;
  const layout = input.layout ?? "classic";
  const scenes = input.mediaEdits?.framing === "full-picture" ? [] : (input.scenes ?? []);
  const illustrations = input.illustrations ?? [];
  const closing = input.closingCard;
  const opening = input.openingCard;
  const durationMs = input.endMs - input.startMs;
  const holdMs = closing?.plan.cleanHoldMs ?? 0;
  const openingPath = join(input.directory, "opening-card.png");
  if (opening) {
    validateStudioOpeningCard(opening.plan, input.endMs - input.startMs, scenes);
    if (illustrations.some((s) => s.startMs < opening.plan.endMs))
      throw Error("STUDIO_OPENING_CARD_INVALID");
    await writeFile(openingPath, opening.bytes, { mode: 0o600 });
  }
  const closingPath = join(input.directory, "closing-card.png");
  if (closing) {
    validateStudioClosingCard(closing.plan, input.endMs - input.startMs);
    await writeFile(closingPath, closing.bytes, { mode: 0o600 });
  }
  const illustrationFiles: string[] = [];
  for (const [i, shot] of illustrations.entries()) {
    if (
      !Number.isSafeInteger(shot.startMs) ||
      !Number.isSafeInteger(shot.endMs) ||
      shot.startMs < 0 ||
      shot.endMs <= shot.startMs ||
      shot.endMs > input.endMs - input.startMs
    )
      throw Error("STUDIO_ILLUSTRATION_INVALID");
    const path = join(input.directory, `illustration-${i}.png`);
    await writeFile(path, await studioIllustrationFrame(shot.bytes, layout), { mode: 0o600 });
    illustrationFiles.push(path);
  }
  const fitRegion = studioFullPictureRegion(width, height, layout);
  const fitCaptionTop = Math.min(STUDIO_CAPTION_TOP, fitRegion.y + fitRegion.height + 12);
  const timeline = await captionTimeline(
    input.directory,
    input.captions,
    input.startMs,
    input.endMs + holdMs,
    {
      scenes: [
        ...scenes,
        ...illustrations.map((s) => ({ ...s, bodyTop: 0, bodyBottom: 1 })),
        ...(closing ? [{ ...closing.plan, bodyTop: 0, bodyBottom: 1 }] : []),
        ...(opening ? [{ ...opening.plan, bodyTop: 0, bodyBottom: 1 }] : []),
      ],
      fitCaptionTop: input.hasVideo ? fitCaptionTop : STUDIO_CAPTION_TOP,
      fontSize: studioSubtitleSize(input.mediaEdits),
    },
  );
  const frame = layout === "immersive" ? STUDIO_FRAME : STUDIO_VIDEO_FRAME;
  const filter: string[] = [];
  if (input.hasVideo) {
    const branches = ["blur", "fit", ...scenes.map((_, i) => `shot${i}`)];
    filter.push(
      // tpad needs an explicit filter frame rate on FFmpeg 7; output -r alone does not
      // supply it, and clips ending at source EOF can otherwise lose the closing hold.
      // Extend to the requested timeline, not by a duration from the last decoded
      // source frame: seeking between source frames can leave that frame short.
      `[1:v:0]trim=duration=${durationMs / 1000},setpts=PTS-STARTPTS,fps=30,tpad=stop_mode=clone:stop=-1,trim=duration=${(durationMs + holdMs) / 1000},split=${branches.length}${branches.map((b) => `[${b}]`).join("")}`,
    );
    filter.push(
      "[blur]scale=1080:1920:force_original_aspect_ratio=increase:force_divisible_by=2,crop=1080:1920,boxblur=30:2,eq=brightness=-0.30,setsar=1[bg]",
    );
    filter.push(`[fit]scale=${fitRegion.width}:${fitRegion.height},setsar=1[whole]`);
    filter.push(`[bg][whole]overlay=${fitRegion.x}:${fitRegion.y}:shortest=1[stage0]`);
    for (const [i, scene] of scenes.entries()) {
      const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
      const top = scene.bodyTop === 0 ? 0 : even(height * scene.bodyTop);
      const bottom = scene.bodyBottom === 1 ? 0 : even(height * (1 - scene.bodyBottom));
      const topH = top ? even((frame.width * top) / width) : 0;
      const bottomH = bottom ? even((frame.width * bottom) / width) : 0;
      const bodyH = frame.height - topH - bottomH;
      const parts = [`body${i}`, ...(top ? [`top${i}`] : []), ...(bottom ? [`bottom${i}`] : [])];
      filter.push(`[shot${i}]split=${parts.length}${parts.map((p) => `[${p}]`).join("")}`);
      filter.push(
        // A screened portrait permits horizontal reframing only. Scaling to fill
        // both axes can silently crop the head on a tall source; preserve its
        // complete body height and pad narrow pictures instead.
        `[body${i}]crop=iw:${height - top - bottom}:0:${top},scale=-2:${bodyH},crop=w='min(iw,${frame.width})':h=${bodyH}:x='(iw-ow)*${input.mediaEdits?.portraitFocus ?? 0.5}':y=0,pad=${frame.width}:${frame.height}:(ow-iw)/2:${topH},setsar=1[portrait${i}]`,
      );
      let sceneLabel = `portrait${i}`;
      if (top) {
        filter.push(
          `[top${i}]crop=iw:${top}:0:0,scale=${frame.width}:${topH},setsar=1[topband${i}]`,
        );
        filter.push(`[${sceneLabel}][topband${i}]overlay=0:0:shortest=1[topped${i}]`);
        sceneLabel = `topped${i}`;
      }
      if (bottom) {
        filter.push(
          `[bottom${i}]crop=iw:${bottom}:0:${height - bottom},scale=${frame.width}:${bottomH},setsar=1[bottomband${i}]`,
        );
        filter.push(
          `[${sceneLabel}][bottomband${i}]overlay=0:${frame.height - bottomH}:shortest=1[banded${i}]`,
        );
        sceneLabel = `banded${i}`;
      }
      filter.push(
        `[stage${i}][${sceneLabel}]overlay=0:${frame.y}:shortest=1:enable='gte(t,${scene.startMs / 1000})*lt(t,${scene.endMs / 1000})'[stage${i + 1}]`,
      );
    }
    filter.push(`[stage${scenes.length}][0:v]overlay=0:0:shortest=1[base]`);
  } else filter.push("[0:v]null[base]");
  let finalBase = "base";
  for (const [i, shot] of illustrations.entries()) {
    if (layout === "immersive") {
      // A finite moving stream placed at its start time: the base picture passes
      // through before it begins and after it ends, so stills can follow each other.
      const length = (shot.endMs - shot.startMs) / 1000;
      filter.push(
        `[${3 + i}:v]${studioMotionFilter(i, shot.endMs - shot.startMs)},format=rgba,fade=t=in:st=0:d=0.3:alpha=1,fade=t=out:st=${Math.max(0, length - 0.3)}:d=0.3:alpha=1,setpts=PTS-STARTPTS+${shot.startMs / 1000}/TB[illustration${i}]`,
      );
      filter.push(
        `[${finalBase}][illustration${i}]overlay=0:0:eof_action=pass:repeatlast=0:enable='gte(t,${shot.startMs / 1000})*lt(t,${shot.endMs / 1000})'[illustrated${i}]`,
      );
    } else {
      filter.push(
        `[${3 + i}:v]format=rgba,fade=t=in:st=${shot.startMs / 1000}:d=0.25:alpha=1,fade=t=out:st=${shot.endMs / 1000 - 0.25}:d=0.25:alpha=1[illustration${i}]`,
      );
      filter.push(
        `[${finalBase}][illustration${i}]overlay=0:${frame.y}:shortest=1:enable='gte(t,${shot.startMs / 1000})*lt(t,${shot.endMs / 1000})'[illustrated${i}]`,
      );
    }
    finalBase = `illustrated${i}`;
  }
  if (closing) {
    filter.push(
      `[${3 + illustrations.length}:v]format=rgba,fade=t=in:st=${closing.plan.startMs / 1000}:d=${closing.plan.transitionMs / 1000}:alpha=1[closing]`,
    );
    filter.push(
      `[${finalBase}][closing]overlay=0:0:shortest=1:enable='gte(t,${closing.plan.startMs / 1000})'[closed]`,
    );
    finalBase = "closed";
  }
  if (opening) {
    filter.push(
      `[${3 + illustrations.length + (closing ? 1 : 0)}:v]format=rgba,fade=t=out:st=${opening.plan.transitionStartMs / 1000}:d=${opening.plan.transitionMs / 1000}:alpha=1[opening]`,
    );
    filter.push(
      `[${finalBase}][opening]overlay=0:0:shortest=1:enable='lt(t,${opening.plan.endMs / 1000})'[opened]`,
    );
    finalBase = "opened";
  }
  if (input.hasAudio) {
    const measured = await measureStudioAudio(input);
    filter.push(
      `[1:a:0]atrim=duration=${durationMs / 1000},asetpts=PTS-STARTPTS,${studioNoiseFilter(input.mediaEdits)}${studioAudioNormalization(measured, input.mediaEdits)}[voice]`,
    );
  }
  const source = `${filter.join(";")};`;
  const args = [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-n",
    "-protocol_whitelist",
    "file,pipe",
    "-loop",
    "1",
    "-framerate",
    "30",
    "-i",
    backdrop,
    "-ss",
    String(input.startMs / 1000),
    "-i",
    "__SOURCE__",
    "-protocol_whitelist",
    "file,pipe",
    "-f",
    "concat",
    "-safe",
    "1",
    "-i",
    timeline,
    ...illustrationFiles.flatMap((path) => [
      "-protocol_whitelist",
      "file,pipe",
      // The immersive camera move generates its own frames from one still.
      ...(layout === "immersive" ? [] : ["-loop", "1"]),
      "-framerate",
      "30",
      "-i",
      path,
    ]),
    ...(closing
      ? ["-protocol_whitelist", "file,pipe", "-loop", "1", "-framerate", "30", "-i", closingPath]
      : []),
    ...(opening
      ? ["-protocol_whitelist", "file,pipe", "-loop", "1", "-framerate", "30", "-i", openingPath]
      : []),
    "-filter_complex_threads",
    "1",
    "-filter_complex",
    // The PNG concat stream has its own time base. Its final transparent frame can
    // land after a speech boundary between PNG ticks; never carry that cue into
    // the clean hold, even for one encoded frame.
    `${source}[${finalBase}][2:v]overlay=0:0:shortest=1:enable='lt(t,${durationMs / 1000})',format=yuv420p[out]`,
    "-map",
    "[out]",
    ...(input.hasAudio ? ["-map", "[voice]"] : []),
    "-t",
    String((durationMs + holdMs) / 1000),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-threads",
    "2",
    "-r",
    "30",
    ...(input.hasAudio ? ["-c:a", "aac", "-b:a", "128k"] : []),
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-movflags",
    "+faststart",
    destination,
  ];
  await executeStudioSource({
    executable: input.ffmpeg,
    args: ["-progress", "pipe:5", "-stats_period", "5", ...args],
    sourcePath: input.sourcePath,
    mimeType: input.mimeType,
    directory: input.directory,
    ...studioRenderBudget(durationMs + holdMs),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if ((await stat(destination)).size > MAX_STUDIO_VIDEO_BYTES)
    throw new Error("RENDER_OUTPUT_TOO_LARGE");
  if (input.hasAudio) {
    const measured = await measureStudioAudio({
      ...input,
      ...(input.mediaEdits ? { mediaEdits: { ...input.mediaEdits, reduceNoise: false } } : {}),
      sourcePath: destination,
      mimeType: "video/mp4",
      startMs: 0,
      endMs: durationMs,
    });
    validateStudioAudioLevel(
      measured.integratedLufs,
      measured.truePeakDbtp,
      studioSpeechTarget(input.mediaEdits),
    );
  }
  return destination;
}
