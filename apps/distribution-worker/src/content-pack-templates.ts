/** Offline review artwork. Inputs and outputs are serializable; no I/O or core imports. */
type ContentPackProfile = {
  ashramaName: string;
  speakerName: string;
  /** A locally read PNG, JPEG or WebP encoded as a data URL. */
  logoDataUrl?: string;
};
export type ContentPackContext = {
  episodeTitle: string;
  headline: string;
  /** Editorial prose, never presented as a source quotation. */
  summary: string;
  /** Keep a story character's words distinct from the discourse speaker's words. */
  attribution?: string;
  sourceLabel?: string;
};
export type ContentPackInput = { profile: ContentPackProfile; context: ContentPackContext };
export const VERTICAL_VIDEO_SLOT = { x: 0, y: 570, width: 1080, height: 608 } as const;
export const STATIC_POST_DIMENSIONS = {
  "4:5": { width: 1080, height: 1350 },
  "1:1": { width: 1080, height: 1080 },
  "16:9": { width: 1600, height: 900 },
} as const;
export type StaticPostAspect = keyof typeof STATIC_POST_DIMENSIONS;

const COLOR = {
  cream: "#fffaf2",
  maroon: "#481b2b",
  kamala: "#a12b58",
  gold: "#ae8542",
  ink: "#291f22",
  muted: "#6a555b",
  line: "#e1d3bd",
};
const SANS = "Arial, Helvetica, sans-serif";
const SERIF = "Georgia, 'Times New Roman', serif";
const CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

export function escapeContentPackText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}
function imageDataUrl(value: string): string {
  // SVG is intentionally excluded: supplied artwork cannot introduce scripts or URLs.
  if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new Error("CONTENT_PACK_LOCAL_RASTER_REQUIRED");
  return value;
}
function lines(value: string, columns: number, maximum: number, field: string): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const output: string[] = [];
  let line = "";
  for (const word of words) {
    if ([...word].length > columns) throw new Error(`CONTENT_PACK_TEXT_DOES_NOT_FIT:${field}`);
    const next = line ? `${line} ${word}` : word;
    if ([...next].length > columns) {
      output.push(line);
      line = word;
    } else line = next;
  }
  if (line) output.push(line);
  if (output.length === 0 || output.length > maximum)
    throw new Error(`CONTENT_PACK_TEXT_DOES_NOT_FIT:${field}`);
  return output;
}
function text(
  value: string,
  x: number,
  y: number,
  size: number,
  options: { color?: string; family?: string; weight?: number; spacing?: number } = {},
): string {
  return `<text x="${x}" y="${y}" fill="${options.color ?? COLOR.ink}" font-size="${size}" font-family="${escapeContentPackText(options.family ?? SANS)}" font-weight="${options.weight ?? 400}" letter-spacing="${options.spacing ?? 0}">${escapeContentPackText(value)}</text>`;
}
function block(
  value: string,
  x: number,
  y: number,
  size: number,
  leading: number,
  columns: number,
  maximum: number,
  field: string,
  options: Parameters<typeof text>[4] = {},
): string {
  return lines(value, columns, maximum, field)
    .map((line, index) => text(line, x, y + index * leading, size, options))
    .join("");
}
function raster(value: string, x: number, y: number, width: number, height: number): string {
  return `<image x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" href="${imageDataUrl(value)}"/>`;
}
function header(profile: ContentPackProfile, width: number, compact = false): string {
  const top = compact ? 40 : 62;
  const size = compact ? 80 : 112;
  const nameX = profile.logoDataUrl ? 64 + size + 28 : 64;
  return `<rect width="${width}" height="12" fill="${COLOR.maroon}"/>
    ${profile.logoDataUrl ? raster(profile.logoDataUrl, 64, top, size, size) : ""}
    ${block(profile.ashramaName, nameX, top + 36, compact ? 23 : 27, 32, 48, 1, "ashramaName", { color: COLOR.maroon, family: SERIF })}
    ${block(profile.speakerName, nameX, top + 70, compact ? 17 : 20, 26, 64, 1, "speakerName", { color: COLOR.muted })}
    <path d="M64 ${top + size + 30}H${width - 64}" stroke="${COLOR.line}" stroke-width="2"/>`;
}
function footer(width: number, height: number): string {
  return `<path d="M64 ${height - 116}H${width - 64}" stroke="${COLOR.line}" stroke-width="2"/>
    <rect x="64" y="${height - 85}" width="204" height="36" rx="3" fill="${COLOR.maroon}"/>
    ${text("TEST PREVIEW", 80, height - 60, 20, { color: COLOR.cream, weight: 700, spacing: 1.6 })}
    ${text("Editorial review required", 292, height - 60, 19, { color: COLOR.muted })}`;
}
function html(title: string, width: number, height: number, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeContentPackText(CSP)}"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeContentPackText(title)} · Test preview</title><style>html,body{margin:0;padding:0;width:${width}px;height:${height}px;background:${COLOR.cream}}svg{display:block}</style></head><body><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeContentPackText(`${title}. Test preview; editorial review required.`)}"><rect width="${width}" height="${height}" fill="${COLOR.cream}"/>${body}</svg></body></html>`;
}

/** Overlay the unaltered source at VERTICAL_VIDEO_SLOT after rasterizing this backdrop. */
export function renderVerticalVideoBackdrop({ profile, context }: ContentPackInput): string {
  const slot = VERTICAL_VIDEO_SLOT;
  return html(
    context.headline,
    1080,
    1920,
    `${header(profile, 1080)}
    ${block(context.episodeTitle, 64, 251, 23, 29, 68, 1, "episodeTitle", { color: COLOR.kamala, weight: 700 })}
    ${block(context.headline, 64, 332, 56, 66, 30, 3, "headline", { color: COLOR.maroon, family: SERIF })}
    ${text("DISCOURSE EXCERPT", 64, 534, 17, { color: COLOR.muted, spacing: 3 })}
    <rect id="source-video-slot" x="${slot.x}" y="${slot.y}" width="${slot.width}" height="${slot.height}" fill="#181518"/>
    ${context.sourceLabel ? block(context.sourceLabel, 64, 1223, 20, 27, 78, 2, "sourceLabel", { color: COLOR.muted }) : ""}
    ${text("EDITORIAL SUMMARY", 64, 1334, 18, { color: COLOR.kamala, weight: 700, spacing: 2.5 })}
    ${block(context.summary, 64, 1391, 33, 45, 49, 4, "summary", { family: SERIF })}
    ${text("SOURCE ATTRIBUTION", 64, 1638, 17, { color: COLOR.kamala, weight: 700, spacing: 2 })}
    ${block(context.attribution ?? profile.speakerName, 64, 1680, 25, 35, 66, 2, "attribution", { color: COLOR.muted })}
    ${footer(1080, 1920)}`,
  );
}

export function renderStaticPost({
  profile,
  context,
  aspect,
  sourceFrameDataUrl,
}: ContentPackInput & { aspect: StaticPostAspect; sourceFrameDataUrl: string }): string {
  if (!Object.hasOwn(STATIC_POST_DIMENSIONS, aspect))
    throw new Error("CONTENT_PACK_UNSUPPORTED_ASPECT");
  const dimensions = STATIC_POST_DIMENSIONS[aspect];
  const { width, height } = dimensions;
  const source = imageDataUrl(sourceFrameDataUrl);
  if (aspect === "16:9") {
    return html(
      context.headline,
      width,
      height,
      `${header(profile, width, true)}
      ${block(context.episodeTitle, 64, 210, 21, 26, 80, 1, "episodeTitle", { color: COLOR.kamala, weight: 700 })}
      ${block(context.headline, 64, 283, 43, 53, 23, 3, "headline", { color: COLOR.maroon, family: SERIF })}
      <rect x="690" y="236" width="846" height="476" fill="#181518"/>
      ${raster(source, 690, 236, 846, 476)}
      ${text("EDITORIAL SUMMARY", 64, 483, 17, { color: COLOR.kamala, weight: 700, spacing: 2 })}
      ${block(context.summary, 64, 528, 26, 35, 36, 4, "summary", { family: SERIF })}
      ${block(context.attribution ?? profile.speakerName, 64, 715, 19, 27, 45, 2, "attribution", { color: COLOR.muted })}
      ${context.sourceLabel ? block(context.sourceLabel, 690, 747, 18, 24, 74, 1, "sourceLabel", { color: COLOR.muted }) : ""}
      ${footer(width, height)}`,
    );
  }
  const square = aspect === "1:1";
  const imageY = square ? 320 : 368;
  const imageHeight = square ? 394 : 540;
  const summaryLabelY = square ? 758 : 965;
  return html(
    context.headline,
    width,
    height,
    `${header(profile, width, true)}
    ${block(context.episodeTitle, 64, 200, 21, 27, 68, 1, "episodeTitle", { color: COLOR.kamala, weight: 700 })}
    ${block(context.headline, 64, 253, square ? 39 : 46, square ? 47 : 55, square ? 42 : 35, 2, "headline", { color: COLOR.maroon, family: SERIF })}
    <rect x="64" y="${imageY}" width="952" height="${imageHeight}" fill="#181518"/>
    ${raster(source, 64, imageY, 952, imageHeight)}
    ${text("EDITORIAL SUMMARY", 64, summaryLabelY, 17, { color: COLOR.kamala, weight: 700, spacing: 2 })}
    ${block(context.summary, 64, summaryLabelY + 44, square ? 25 : 29, square ? 32 : 39, square ? 67 : 56, 3, "summary", { family: SERIF })}
    ${block(context.attribution ?? profile.speakerName, 64, square ? 914 : 1148, 20, 27, 76, square ? 1 : 2, "attribution", { color: COLOR.muted })}
    ${context.sourceLabel ? block(context.sourceLabel, 64, square ? 944 : 1194, 17, 23, 96, 1, "sourceLabel", { color: COLOR.muted }) : ""}
    ${footer(width, height)}`,
  );
}

/** A readable local article draft. Sections remain editorial summaries, not invented quotes. */
export function renderBlogPreview({
  profile,
  context,
  sourceFrameDataUrl,
  sections,
}: ContentPackInput & {
  sourceFrameDataUrl: string;
  sections: { heading: string; paragraphs: string[] }[];
}): string {
  const e = escapeContentPackText;
  const logo = profile.logoDataUrl
    ? `<img class="logo" alt="Proposed Ashrama emblem" src="${imageDataUrl(profile.logoDataUrl)}">`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${e(CSP)}"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(context.headline)} · Test preview</title><style>
    *{box-sizing:border-box}body{margin:0;background:${COLOR.cream};color:${COLOR.ink};font-family:Georgia,serif;border-top:10px solid ${COLOR.maroon}}main{max-width:980px;margin:auto;padding:56px 40px 72px}header{display:flex;gap:24px;align-items:center;padding-bottom:28px;border-bottom:1px solid ${COLOR.line}}.logo{width:90px;height:90px;object-fit:contain}.brand{font-size:27px;color:${COLOR.maroon};margin:0}.speaker,.label,figcaption,footer{font-family:Arial,sans-serif;color:${COLOR.muted}}.speaker{font-size:16px}.label{font-size:14px;letter-spacing:1.6px;color:${COLOR.kamala};font-weight:bold;margin-top:36px}h1{font-size:48px;line-height:1.12;color:${COLOR.maroon};font-weight:normal}h2{font-size:28px;color:${COLOR.maroon};margin-top:36px}p{font-size:21px;line-height:1.65}figure{margin:30px 0}figure img{width:100%;max-height:560px;object-fit:contain;background:#181518}figcaption{font-size:14px;line-height:1.5;margin-top:10px}footer{border-top:1px solid ${COLOR.line};margin-top:48px;padding-top:24px;font-size:14px;display:flex;align-items:center;gap:12px 16px;flex-wrap:wrap}.badge{display:inline-block;background:${COLOR.maroon};color:${COLOR.cream};padding:10px 14px;letter-spacing:1.4px;margin-right:0}h1,h2,p,figcaption{overflow-wrap:anywhere}
    </style></head><body><main><header>${logo}<div><p class="brand">${e(profile.ashramaName)}</p><p class="speaker">${e(profile.speakerName)}</p></div></header><p class="label">${e(context.episodeTitle)}</p><h1>${e(context.headline)}</h1><figure><img alt="Frame from the source discourse; original framing retained" src="${imageDataUrl(sourceFrameDataUrl)}"><figcaption>${e(context.sourceLabel ?? context.episodeTitle)}</figcaption></figure><p class="label">EDITORIAL SUMMARY</p><p>${e(context.summary)}</p><p class="speaker">${e(context.attribution ?? profile.speakerName)}</p>${sections.map((section) => `<section><h2>${e(section.heading)}</h2>${section.paragraphs.map((paragraph) => `<p>${e(paragraph)}</p>`).join("")}</section>`).join("")}<footer><span class="badge">TEST PREVIEW</span><span>Editorial review required</span></footer></main></body></html>`;
}
