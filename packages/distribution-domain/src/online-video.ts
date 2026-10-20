import type { ContentRights } from "./content";
import type { StudioGenerationRequest } from "./intelligent-content";

export type PlaylistCuration = {
  pausedForCleanup?: boolean;
  rights: ContentRights;
  request: StudioGenerationRequest;
  requestedBy: string;
  confirmedAt: string;
  items: Record<
    string,
    {
      packageId?: string;
      existing?: boolean;
      error?: string;
      status?: string;
      outputCount?: number;
    }
  >;
};

/** Supported source links only. A source URL is provenance, never permission to publish. */
export type OnlineVideoSource = {
  provider: "youtube" | "facebook";
  kind: "video" | "playlist" | "bundle";
  id: string;
  url: string;
};

export const ONLINE_IMPORT_PLAYLIST_LIMIT = 100;

/** Bundles are internal collections, never synthetic provider playlist URLs. */
export function isOnlineBundle(source: OnlineVideoSource) {
  return source.kind === "playlist" || source.kind === "bundle";
}

export function onlineVideoBundle(raw: string): OnlineVideoSource[] {
  const lines = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length || lines.length > ONLINE_IMPORT_PLAYLIST_LIMIT)
    throw Error("ONLINE_BUNDLE_SIZE_INVALID");
  const sources = lines.map((line) => onlineVideoSource(line));
  if (sources.some((source) => source.kind !== "video" || source.provider !== sources[0]?.provider))
    throw Error("ONLINE_BUNDLE_PROVIDER_MISMATCH");
  return [...new Map(sources.map((source) => [source.url, source])).values()];
}

export type OnlineImportServiceIssue = {
  provider: OnlineVideoSource["provider"];
  code: "ONLINE_PROVIDER_VERIFICATION_REQUIRED" | "ONLINE_PROVIDER_RATE_LIMITED";
  retryAt: string | null;
  attempts: number;
};

export type OnlineImport = {
  id: string;
  source: OnlineVideoSource;
  title: string | null;
  status: "QUEUED" | "DOWNLOADING" | "COMPLETE" | "FAILED";
  masterId: string | null;
  parentId: string | null;
  childIds: string[] | null;
  curation?: PlaylistCuration | null;
  error: string | null;
  serviceIssue?: OnlineImportServiceIssue;
  createdAt: string;
  updatedAt: string;
};

export function onlineVideoSource(raw: string, includePlaylist = false): OnlineVideoSource {
  const invalid = () => new Error("UNSUPPORTED_VIDEO_LINK");
  if (typeof raw !== "string" || !raw.trim() || raw.length > 2048) throw invalid();
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw invalid();
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw invalid();
  const host = url.hostname.toLowerCase();
  if (["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(host)) {
    const playlist = url.searchParams.get("list");
    if (includePlaylist && playlist && /^[A-Za-z0-9_-]{10,100}$/.test(playlist))
      return {
        provider: "youtube",
        kind: "playlist",
        id: playlist,
        url: `https://www.youtube.com/playlist?list=${playlist}`,
      };
    const id =
      host === "youtu.be"
        ? url.pathname.slice(1)
        : url.pathname === "/watch"
          ? url.searchParams.get("v")
          : /^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw invalid();
    return { provider: "youtube", kind: "video", id, url: `https://www.youtube.com/watch?v=${id}` };
  }
  if (["facebook.com", "www.facebook.com", "m.facebook.com", "fb.watch"].includes(host)) {
    const share = /^\/share\/(?:v|r)\/([A-Za-z0-9_-]{3,100})\/?$/.exec(url.pathname);
    if (host !== "fb.watch" && share)
      return {
        provider: "facebook",
        kind: "video",
        id: `share-${share[1]}`,
        url: `https://www.facebook.com${url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`}`,
      };
    const id =
      host === "fb.watch"
        ? /^\/([A-Za-z0-9_-]{3,100})\/?$/.exec(url.pathname)?.[1]
        : url.pathname === "/watch/" || url.pathname === "/watch"
          ? url.searchParams.get("v")
          : /^\/(?:reel|[A-Za-z0-9_.]+\/videos)\/(\d{5,30})\/?$/.exec(url.pathname)?.[1];
    if (!id || (host !== "fb.watch" && !/^\d{5,30}$/.test(id))) throw invalid();
    return {
      provider: "facebook",
      kind: "video",
      id,
      url:
        host === "fb.watch" ? `https://fb.watch/${id}/` : `https://www.facebook.com/watch/?v=${id}`,
    };
  }
  throw invalid();
}

export const ONLINE_IMPORT_ERRORS: Record<string, string> = {
  ONLINE_BUNDLE_SIZE_INVALID: "Paste between 1 and 100 video links, one per line.",
  ONLINE_BUNDLE_PROVIDER_MISMATCH:
    "Use video links from the same provider in one series. Import a playlist using its single playlist link.",
  ONLINE_BUNDLE_TITLE_REQUIRED:
    "Enter a name for this series so you can find it under Continue Existing Curation.",
  ONLINE_PROVIDER_VERIFICATION_REQUIRED:
    "The video provider is asking the import service to verify access. This does not mean your videos are private. Your playlist and settings are saved; individual videos do not need to be retried.",
  ONLINE_PROVIDER_RATE_LIMITED:
    "The video provider has temporarily limited downloads. The import service will wait and resume your playlist automatically.",
  UNSUPPORTED_VIDEO_LINK:
    "Paste a full YouTube or Facebook video link. For a YouTube playlist, select Import playlist.",
  ONLINE_SOURCE_RESTRICTED:
    "This video requires a login, membership or other access. Upload an authorized copy instead.",
  ONLINE_SOURCE_UNAVAILABLE:
    "The source video could not be downloaded. Check the original link or upload the recording.",
  ONLINE_SOURCE_FORMAT_UNSUPPORTED:
    "The video is reachable, but the provider has not offered a supported downloadable format. A recent livestream may still be processing. Retry later or upload your original recording.",
  ONLINE_SOURCE_TOO_LARGE:
    "This recording exceeds the 20 GB online download limit. Upload a smaller complete recording or split it into complete teachings.",
  PLAYLIST_ALREADY_STARTED:
    "This playlist already has saved settings. Open its progress below; existing curation has been preserved.",
  PLAYLIST_NOT_READY:
    "The playlist is still being read. Wait for its video list, then start curation.",
  PLAYLIST_PERMISSIONS_INVALID:
    "Confirm public, worldwide permission for every selected channel and current dates before starting this playlist.",
  ONLINE_IMPORT_TIMEOUT: "The download took too long. Retry the import or upload the recording.",
  ONLINE_PLAYLIST_TOO_LARGE: "Import playlists of up to 100 videos at a time.",
  ONLINE_IMPORT_FORBIDDEN:
    "Your Content Curator access is no longer available. Ask your administrator to check your role.",
  ONLINE_IMPORT_DISABLED:
    "Online video import is not available on this service yet. You can upload a recording.",
  ONLINE_SOURCE_PREVIOUS_VERSION:
    "This video matches an earlier version of an existing master. Open its master history in Continue Existing Curation before choosing the source to curate.",
  ONLINE_IMPORT_BUSY:
    "Your import queue is full. Wait for the current downloads to finish before adding more.",
  ONLINE_IMPORT_RETRY_EXHAUSTED:
    "This import stopped after repeated interruptions. Retry it to start a fresh download.",
  OPERATOR_AUTHORITY_UNAVAILABLE:
    "Curator access could not be verified. Retry when the account service is available.",
};
