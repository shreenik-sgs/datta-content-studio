import { type StudioSourceBranding, studioSourceBranding } from "./studio-source-branding";
import { STUDIO_SOURCE_SCENE_MARGIN_MS } from "./studio-timing";

export const STUDIO_CLOSING_CARD_POLICY = "green-plain-text-closing-card-v7" as const;
export const STUDIO_MORE_TEACHINGS_URL = "https://sgsdattasannidhi.org/";
export const STUDIO_YOUTUBE_CHANNEL_URL = "https://www.youtube.com/@sgsswamiji";
/** A package-specific subscription destination; never changes the source attribution. */
export type StudioYoutubeClosing = { label: string; url: string };
export const STUDIO_BALA_YOUTUBE_CLOSING: StudioYoutubeClosing = {
  label: "Sri Datta Vijayananda Teertha Swamiji",
  url: "https://www.youtube.com/@gurubhavanaadpt",
};
export function studioYoutubeClosing(value: StudioYoutubeClosing): StudioYoutubeClosing {
  if (
    !value ||
    typeof value.label !== "string" ||
    typeof value.url !== "string" ||
    !value.label.trim() ||
    value.label.length > 80 ||
    value.url.length > 2048 ||
    /[\r\n\t]/u.test(value.label) ||
    /[<>]/u.test(value.label) ||
    [...(value.label + value.url)].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    /\s/u.test(value.url)
  )
    throw Error("INVALID_STUDIO_YOUTUBE_CLOSING");
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw Error("INVALID_STUDIO_YOUTUBE_CLOSING");
  }
  if (
    url.protocol !== "https:" ||
    !["youtube.com", "www.youtube.com"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !/^\/(?:@[A-Za-z0-9_-][A-Za-z0-9._-]{1,98}[A-Za-z0-9_-]|channel\/UC[A-Za-z0-9_-]{22})\/?$/u.test(
      url.pathname,
    )
  )
    throw Error("INVALID_STUDIO_YOUTUBE_CLOSING");
  return {
    label: value.label.trim(),
    url: `https://www.youtube.com${url.pathname.replace(/\/$/u, "")}`,
  };
}
export const STUDIO_OPENING_CARD_POLICY = "steady-opening-original-voice-v1" as const;
export type StudioOpeningCard = {
  policy: typeof STUDIO_OPENING_CARD_POLICY;
  startMs: 0;
  transitionStartMs: number;
  endMs: number;
  transitionMs: 400;
};
/** Bridge unsuitable introductory pictures to the first screened portrait, never skip speech. */
export function studioOpeningCardPlan(
  durationMs: number,
  scenes: { startMs: number; endMs: number }[],
): StudioOpeningCard | undefined {
  const first = scenes[0];
  const closing = studioClosingCardPlan(durationMs);
  if (!first || first.startMs === 0) return undefined;
  if (
    !Number.isSafeInteger(first.startMs) ||
    first.startMs < 0 ||
    // Screening permits a ten-second source introduction. Its safety margin is
    // added before this function receives the scene; it is not a longer intro.
    first.startMs > 10000 + STUDIO_SOURCE_SCENE_MARGIN_MS ||
    first.startMs + 400 >= first.endMs ||
    first.startMs + 400 >= closing.startMs
  )
    throw Error("STUDIO_OPENING_CARD_INVALID");
  return {
    policy: STUDIO_OPENING_CARD_POLICY,
    startMs: 0,
    transitionStartMs: first.startMs,
    endMs: first.startMs + 400,
    transitionMs: 400,
  };
}
export function validateStudioOpeningCard(
  value: StudioOpeningCard,
  durationMs: number,
  scenes: { startMs: number; endMs: number }[],
): void {
  const expected = studioOpeningCardPlan(durationMs, scenes);
  if (
    !expected ||
    Object.entries(expected).some(([k, v]) => value[k as keyof StudioOpeningCard] !== v)
  )
    throw Error("STUDIO_OPENING_CARD_INVALID");
}
export const STUDIO_CLOSING_HOLD_MS = 3000;
export const STUDIO_CARD_STYLES = ["plum", "forest", "dawn"] as const;
export type StudioCardStyle = (typeof STUDIO_CARD_STYLES)[number];
/** Stable per teaching, shared by channel siblings and preserved on retries. */
export function studioCardStyle(identity: string): StudioCardStyle {
  let hash = 2166136261;
  for (const char of identity) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return STUDIO_CARD_STYLES[hash % STUDIO_CARD_STYLES.length] ?? "plum";
}
export function studioAppDownloadUrl(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /\s/u.test(value) ||
    [...value].some((c) => c.charCodeAt(0) < 32)
  )
    throw Error("STUDIO_APP_DOWNLOAD_URL_INVALID");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw Error("STUDIO_APP_DOWNLOAD_URL_INVALID");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    !parsed.hostname.includes(".")
  )
    throw Error("STUDIO_APP_DOWNLOAD_URL_INVALID");
  return parsed.href;
}
export type StudioAppLinks = { web: string; ios?: string; android?: string };
export function studioAppLinks(value?: Partial<StudioAppLinks>): StudioAppLinks {
  const web = studioAppDownloadUrl(value?.web) ?? STUDIO_MORE_TEACHINGS_URL;
  const ios = studioAppDownloadUrl(value?.ios);
  const android = studioAppDownloadUrl(value?.android);
  return { web, ...(ios ? { ios } : {}), ...(android ? { android } : {}) };
}
export function studioAppDestination(
  links: StudioAppLinks,
  platform: "ios" | "android" | "web",
): string {
  const valid = studioAppLinks(links);
  return platform === "ios"
    ? (valid.ios ?? valid.web)
    : platform === "android"
      ? (valid.android ?? valid.web)
      : valid.web;
}
export type StudioClosingCard = {
  policy:
    | typeof STUDIO_CLOSING_CARD_POLICY
    | "green-channel-watch-subscribe-closing-card-v6"
    | "green-watch-subscribe-closing-card-v5"
    | "green-subscribe-closing-card-v4"
    | "green-subscribe-closing-card-v3"
    | "clean-hold-closing-card-v2"
    | "continuous-voice-closing-card-v1";
  startMs: number;
  endMs: number;
  transitionMs: number;
  /** Legacy renders ended with the source. New renders add a silent, caption-free hold. */
  speechEndMs?: number;
  cleanHoldMs?: number;
  style?: StudioCardStyle;
  moreUrl?: string;
  appLinks?: StudioAppLinks;
  destination?: "app" | "youtube";
  channelUrl?: string;
  youtubeClosing?: StudioYoutubeClosing;
  sourceBranding?: StudioSourceBranding;
};
export function studioClosingDisplayName(sourceBranding?: StudioSourceBranding): string {
  return sourceBranding === "bala-swamiji" ? "Sri Datta Vijayananda Teertha Swamiji" : "SriSwamiji";
}
/** A legacy source destination must not masquerade as either newly planned channel. */
export function studioClosingChannel(value: StudioClosingCard): { name: string; url?: string } {
  if (
    value.policy !== STUDIO_CLOSING_CARD_POLICY &&
    value.policy !== "green-channel-watch-subscribe-closing-card-v6" &&
    value.policy !== "green-watch-subscribe-closing-card-v5" &&
    value.policy !== "green-subscribe-closing-card-v4" &&
    value.policy !== "green-subscribe-closing-card-v3"
  )
    return {
      name: value.youtubeClosing?.label ?? "@SGSSwamiji",
      ...(value.channelUrl ? { url: value.channelUrl } : {}),
    };
  const oldName = value.sourceBranding === "bala-swamiji" ? "SriBalaSwamiji" : "SriSwamiji";
  const name =
    value.policy === "green-subscribe-closing-card-v3"
      ? oldName
      : studioClosingDisplayName(value.sourceBranding);
  const target = value.youtubeClosing;
  return {
    name,
    ...(target?.label === name && target.url === value.channelUrl ? { url: target.url } : {}),
  };
}
export function unconfiguredStudioClosingChannels(
  outputs: { included: boolean; presentationReview?: { closingCard?: StudioClosingCard } | null }[],
): string[] {
  return [
    ...new Set(
      outputs.flatMap((output) => {
        const card = output.presentationReview?.closingCard;
        if (!output.included || card?.destination !== "youtube") return [];
        const channel = studioClosingChannel(card);
        return channel.url ? [] : [channel.name];
      }),
    ),
  ];
}
export function studioClosingCardPlan(
  durationMs: number,
  options: {
    style?: StudioCardStyle;
    appLinks?: StudioAppLinks;
    destination?: "app" | "youtube";
    youtubeClosing?: StudioYoutubeClosing;
    sourceBranding?: StudioSourceBranding;
  } = {},
): StudioClosingCard {
  if (!Number.isSafeInteger(durationMs) || durationMs < 1000)
    throw Error("STUDIO_CLOSING_CARD_INVALID");
  studioSourceBranding(options.sourceBranding);
  const style = "forest";
  if (options.style !== undefined && !STUDIO_CARD_STYLES.includes(options.style))
    throw Error("STUDIO_CLOSING_CARD_INVALID");
  const appLinks = studioAppLinks(options.appLinks);
  const youtubeClosing = options.youtubeClosing
    ? studioYoutubeClosing(options.youtubeClosing)
    : undefined;
  if (youtubeClosing && options.destination === "app") throw Error("STUDIO_CLOSING_CARD_INVALID");
  if (options.destination !== undefined && !["app", "youtube"].includes(options.destination))
    throw Error("STUDIO_CLOSING_CARD_INVALID");
  return {
    policy: STUDIO_CLOSING_CARD_POLICY,
    startMs: Math.max(0, durationMs - 2000),
    speechEndMs: durationMs,
    endMs: durationMs + STUDIO_CLOSING_HOLD_MS,
    cleanHoldMs: STUDIO_CLOSING_HOLD_MS,
    transitionMs: 400,
    style,
    ...(options.sourceBranding ? { sourceBranding: options.sourceBranding } : {}),
    ...(options.destination === "youtube" || youtubeClosing
      ? {
          destination: "youtube" as const,
          channelUrl: youtubeClosing?.url ?? STUDIO_YOUTUBE_CHANNEL_URL,
          ...(youtubeClosing ? { youtubeClosing } : {}),
        }
      : { ...(options.destination ? { destination: options.destination } : {}), appLinks }),
  };
}
export function validateStudioClosingCard(value: StudioClosingCard, durationMs: number): void {
  if (value.policy === "continuous-voice-closing-card-v1") {
    if (
      value.startMs !== Math.max(Math.floor(durationMs / 2), durationMs - 6500) ||
      value.endMs !== durationMs ||
      value.transitionMs !== 400 ||
      value.moreUrl !== STUDIO_MORE_TEACHINGS_URL ||
      value.cleanHoldMs !== undefined ||
      value.speechEndMs !== undefined ||
      value.appLinks !== undefined ||
      value.destination !== undefined ||
      value.channelUrl !== undefined ||
      value.youtubeClosing !== undefined ||
      value.sourceBranding !== undefined
    )
      throw Error("STUDIO_CLOSING_CARD_INVALID");
    return;
  }
  const expected = studioClosingCardPlan(durationMs, {
    ...(value.style ? { style: value.style } : {}),
    ...(value.appLinks ? { appLinks: value.appLinks } : {}),
    ...(value.destination ? { destination: value.destination } : {}),
    ...(value.youtubeClosing ? { youtubeClosing: value.youtubeClosing } : {}),
    ...(value.sourceBranding ? { sourceBranding: value.sourceBranding } : {}),
  });
  if (
    value.policy === "green-subscribe-closing-card-v3" ||
    value.policy === "green-subscribe-closing-card-v4" ||
    value.policy === "green-channel-watch-subscribe-closing-card-v6" ||
    value.policy === "green-watch-subscribe-closing-card-v5"
  )
    expected.policy = value.policy;
  // Historical approved renders keep their exact evidence; only new renders use the green policy.
  if (value.policy === "clean-hold-closing-card-v2") {
    expected.policy = value.policy;
    expected.startMs = Math.max(Math.floor(durationMs / 2), durationMs - 6500);
    expected.style = value.style ?? "plum";
  }
  if (
    value.moreUrl !== undefined ||
    (value.destination === "youtube"
      ? value.appLinks !== undefined
      : value.channelUrl !== undefined || value.youtubeClosing !== undefined) ||
    Object.entries(expected).some(([key, v]) =>
      key === "appLinks"
        ? !value.appLinks ||
          (["web", "ios", "android"] as const).some(
            (k) => value.appLinks?.[k] !== expected.appLinks?.[k],
          )
        : key === "youtubeClosing"
          ? value.youtubeClosing?.label !== expected.youtubeClosing?.label ||
            value.youtubeClosing?.url !== expected.youtubeClosing?.url
          : value[key as keyof StudioClosingCard] !== v,
    )
  )
    throw Error("STUDIO_CLOSING_CARD_INVALID");
}
/** Source boundaries retain provenance; this is the planned published duration. */
export function studioRenderedDurationMs(output: {
  startMs: number | null;
  endMs: number | null;
  presentationReview?: { closingCard?: StudioClosingCard } | null;
}): number {
  const source = (output.endMs ?? 0) - (output.startMs ?? 0);
  return output.presentationReview?.closingCard?.endMs ?? source;
}
