import { readFile } from "node:fs/promises";
import {
  STUDIO_SUBTITLE_TOP,
  type StudioCardStyle,
  type StudioSourceBranding,
  type StudioYoutubeClosing,
  studioClosingDisplayName,
  studioSourceBranding,
  studioYoutubeClosing,
} from "@satsang/distribution-domain";
import sharp from "sharp";
const palettes = {
  plum: ["#241b26", "#100e17", "#c5a76c"],
  forest: ["#173c36", "#0b1719", "#cdbb8d"],
  dawn: ["#443123", "#18131d", "#dbb891"],
} as const;

/** A single real portrait and the reviewed topic bridge unsuitable introductory footage. */
export async function studioOpeningCard(
  logo: Uint8Array,
  title: string,
  style: StudioCardStyle = "plum",
): Promise<Buffer> {
  const [top, bottom, accent] = palettes[style];
  if (!title.trim() || title.length > 200) throw Error("STUDIO_OPENING_CARD_INVALID");
  const escaped = title.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] ?? c,
  );
  const portrait = await sharp(logo).resize(430, 430, { fit: "cover" }).png().toBuffer();
  const topic = await sharp({
    text: {
      text: `<span foreground="#fff8ec">${escaped}</span>`,
      font: "sans-serif 48",
      width: 820,
      // The source voice and its captions continue during this bridge. Bound
      // the complete title above the subtitle band, including long titles.
      height: STUDIO_SUBTITLE_TOP - 1100 - 36,
      align: "centre",
      rgba: true,
    },
  })
    .resize(820, STUDIO_SUBTITLE_TOP - 1100 - 36, { fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  const size = await sharp(topic).metadata();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920">
    <defs><linearGradient id="bg" x2="0" y2="1"><stop stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient><clipPath id="portrait"><circle cx="500" cy="640" r="215"/></clipPath></defs>
    <rect width="1080" height="1920" fill="url(#bg)"/>
    <circle cx="500" cy="640" r="224" fill="none" stroke="${accent}" stroke-width="2"/>
    <image href="data:image/png;base64,${portrait.toString("base64")}" x="285" y="425" width="430" height="430" clip-path="url(#portrait)"/>
    <g text-anchor="middle" font-family="sans-serif">
      <text x="500" y="950" font-size="36" fill="#d9bb84">@sgsswamiji</text>
      <path d="M350 1020H650" stroke="${accent}"/>
    </g>
  </svg>`;
  return sharp(Buffer.from(svg))
    .composite([
      {
        input: topic,
        left: Math.round(500 - (size.width ?? 0) / 2),
        top: 1100,
      },
    ])
    .png()
    .toBuffer();
}

/** The authentic app icon is supplied separately from the @sgsswamiji channel portrait. */
export async function studioClosingCard(
  appLogo: Uint8Array,
  _style: StudioCardStyle = "forest",
  destination: "app" | "youtube" = "app",
  youtubeClosing?: StudioYoutubeClosing,
  sourceBranding?: StudioSourceBranding,
): Promise<Buffer> {
  const [top, bottom, accent] = palettes.forest;
  const target = youtubeClosing ? studioYoutubeClosing(youtubeClosing) : undefined;
  studioSourceBranding(sourceBranding);
  if (target && destination !== "youtube") throw Error("STUDIO_CLOSING_CARD_INVALID");
  const escapeText = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] ?? c,
    );
  const photo = await readFile(new URL("../assets/sri-bala-swamiji-portrait.jpg", import.meta.url));
  const portrait = await sharp(photo).resize(500, 500, { fit: "contain" }).png().toBuffer();
  // Until a new destination channel supplies its own logo, its authentic speaker portrait is
  // its provisional mark. Never synthesize a guru likeness or silently use the Sannidhi app icon.
  const logo = await sharp(destination === "youtube" && appLogo.length ? appLogo : photo)
    .resize(92, 92, { fit: "contain", background: "#ffffff00" })
    .png()
    .toBuffer();
  const textBlock = async (
    text: string,
    font: number,
    width: number,
    height: number,
    color: string,
  ) => {
    const bytes = await sharp({
      text: {
        text: `<span foreground="${color}">${escapeText(text)}</span>`,
        font: `sans-serif ${font}`,
        width,
        height,
        align: "centre",
        rgba: true,
      },
    })
      .png()
      .toBuffer();
    const size = await sharp(bytes).metadata();
    return { bytes, width: size.width ?? width };
  };
  // Keep the two related actions short enough to read during the five-second closing card.
  const label = await textBlock(
    destination === "youtube" ? studioClosingDisplayName(sourceBranding) : "SGS Datta Sannidhi",
    54,
    790,
    168,
    "#fff8ec",
  );
  const watch =
    destination === "youtube"
      ? await textBlock("Watch full videos on this channel", 40, 820, 52, "#fff8ec")
      : undefined;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920">
    <defs><linearGradient id="green" x2="0" y2="1"><stop stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient><clipPath id="photo"><circle cx="500" cy="580" r="250"/></clipPath></defs>
    <rect width="1080" height="1920" fill="url(#green)"/>
    <circle cx="500" cy="580" r="262" fill="none" stroke="${accent}" stroke-width="2"/>
    <image href="data:image/png;base64,${portrait.toString("base64")}" x="250" y="330" width="500" height="500" clip-path="url(#photo)"/>
    ${sourceBranding === "bala-swamiji" ? "" : `<image href="data:image/png;base64,${logo.toString("base64")}" x="454" y="170" width="92" height="92"/>`}
    <rect x="260" y="1200" width="480" height="94" rx="47" fill="${accent}"/>
    <text x="500" y="1262" text-anchor="middle" font-family="sans-serif" font-size="44" font-weight="bold" fill="#173c36">${destination === "youtube" ? "Tap Subscribe" : "Discover the app"}</text>
  </svg>`;
  // The authentic portrait doubles as the provisional channel mark for this speaker.
  // Keep the caption band empty while the last two seconds of source speech continue.
  return sharp(Buffer.from(svg))
    .composite([
      { input: label.bytes, left: Math.round(500 - label.width / 2), top: 940 },
      ...(watch
        ? [{ input: watch.bytes, left: Math.round(500 - watch.width / 2), top: 1128 }]
        : []),
    ])
    .png()
    .toBuffer();
}
