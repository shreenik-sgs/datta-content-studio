import type { ContentRights } from "./content";
import { validateContentRights } from "./content";

export const LIVE_CURATION_WINDOW_MS = 600_000;
export const LIVE_CURATION_OVERLAP_MS = 180_000;
export type LiveCurationChannel = {
  channelId: string;
  name: string;
  handle: string | null;
  enabled: boolean;
};
export type LiveCurationSettings = {
  channelId: string;
  channelName: string;
  enabled: boolean;
  language: string;
  rights: ContentRights;
};
export type LiveCurationMonitor = LiveCurationSettings & {
  id: string;
  revision: number;
  checkedAt: string | null;
  error: string | null;
};
export type LiveCurationWindow = {
  id: string;
  number: number;
  startMs: number;
  endMs: number;
  ownedEndMs: number;
  masterId: string;
  packageId: string | null;
};
export type LiveCurationBroadcast = {
  id: string;
  channelId: string;
  videoId: string;
  title: string;
  status: "CAPTURING" | "ENDED" | "NEEDS_ATTENTION";
  error: string | null;
  capturedMs: number;
  capturedFrom: string | null;
  windows: LiveCurationWindow[];
};

export function validateLiveCurationSettings(input: LiveCurationSettings, now: number) {
  if (
    !/^UC[A-Za-z0-9_-]{22}$/.test(input.channelId) ||
    !input.channelName.trim() ||
    input.channelName.length > 200 ||
    !["te", "kn", "en", "hi", "ta", "ml", "sa"].includes(input.language) ||
    typeof input.enabled !== "boolean"
  )
    throw Error("INVALID_LIVE_CURATION");
  validateContentRights(input.rights);
  if (
    input.enabled &&
    (input.rights.privacyClass !== "PUBLIC" ||
      !input.rights.territories.includes("WORLDWIDE") ||
      !input.rights.channels.includes("youtube") ||
      (input.rights.releaseAt && Date.parse(input.rights.releaseAt) > now) ||
      (input.rights.expiresAt && Date.parse(input.rights.expiresAt) <= now))
  )
    throw Error("LIVE_CURATION_RIGHTS_REQUIRED");
}

/** Three minutes of look-ahead keeps a whole Short inside one window. Starts belong to one window only. */
export function liveCurationWindow(
  segments: readonly { sequence: number; durationMs: number }[],
  ended: boolean,
): { count: number; nextIndex: number; durationMs: number; ownedEndMs: number } | null {
  let durationMs = 0;
  let count = 0;
  for (const segment of segments) {
    if (
      !Number.isSafeInteger(segment.sequence) ||
      !Number.isSafeInteger(segment.durationMs) ||
      segment.durationMs <= 0 ||
      segment.durationMs > 30_000 ||
      (count > 0 && segment.sequence !== (segments[count - 1]?.sequence ?? -2) + 1)
    )
      throw Error("LIVE_CAPTURE_GAP");
    durationMs += segment.durationMs;
    count++;
    if (durationMs >= LIVE_CURATION_WINDOW_MS) break;
  }
  if (!count || (!ended && durationMs < LIVE_CURATION_WINDOW_MS)) return null;
  if (ended && count === segments.length)
    return { count, nextIndex: count, durationMs, ownedEndMs: durationMs + 1 };
  let ownedEndMs = 0;
  let nextIndex = 0;
  while (
    nextIndex < count &&
    ownedEndMs + (segments[nextIndex]?.durationMs ?? 0) <= durationMs - LIVE_CURATION_OVERLAP_MS
  ) {
    ownedEndMs += segments[nextIndex]?.durationMs ?? 0;
    nextIndex++;
  }
  if (!nextIndex) throw Error("INVALID_LIVE_WINDOW");
  return { count, nextIndex, durationMs, ownedEndMs };
}

export const LIVE_CURATION_ERRORS: Record<string, string> = {
  LIVE_MONITOR_UNAVAILABLE:
    "Live capture is not running. Ask the administrator to start the capture worker, then refresh.",
  LIVE_MONITOR_LIMIT:
    "You can monitor up to two channels. Pause an existing channel before selecting another.",
  ONLINE_PROVIDER_RATE_LIMITED:
    "YouTube is temporarily limiting requests. Capture will retry; saved sections are retained.",
  LIVE_CAPTURE_GAP:
    "Part of the live stream was missed. Capture is paused so disconnected speech is never joined. Import the complete recording after the broadcast to recover it.",
  LIVE_STREAM_UNSUPPORTED:
    "This broadcast does not offer a supported live stream. Import its recording after it ends.",
  ONLINE_PROVIDER_VERIFICATION_REQUIRED:
    "YouTube requires verification. Live capture is paused. Use the Hub’s verified online import or upload the authorized recording after the broadcast.",
  ONLINE_SOURCE_RESTRICTED:
    "YouTube requires authorized access to this broadcast. Upload an authorized recording after it ends.",
  LIVE_CURATION_RIGHTS_REQUIRED:
    "The channel’s saved permission has expired or does not cover public YouTube curation. Update its permissions to resume.",
  LIVE_CHANNEL_DISABLED: "This channel is disabled or removed in Practices. Monitoring is paused.",
  LIVE_CAPTURE_UNAVAILABLE:
    "Live capture could not continue. Your saved sections are retained; check access and resume monitoring.",
  OPERATOR_AUTHORITY_UNAVAILABLE:
    "The app could not verify the curator’s current access. Monitoring will retry without processing new content.",
  REQUESTER_ROLE_REVOKED:
    "The curator no longer has permission to create content. Reassign monitoring to an authorized curator.",
};
