import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { publicVideoAddress } from "./online-video-network";
export function liveMediaUrl(raw: string) {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !(url.hostname === "googlevideo.com" || url.hostname.endsWith(".googlevideo.com"))
  )
    throw Error("LIVE_STREAM_UNSUPPORTED");
  return url;
}
/** HTTPS, exact media-domain allowlist, public-IP pinning and bounded redirects/body on every fragment. */
export async function fetchLiveMedia(
  raw: string,
  limit: number,
  signal: AbortSignal,
  redirects = 0,
): Promise<Buffer> {
  signal.throwIfAborted();
  if (redirects > 4) throw Error("LIVE_STREAM_UNSUPPORTED");
  const url = liveMediaUrl(raw);
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((a) => !publicVideoAddress(a.address)))
    throw Error("LIVE_STREAM_UNSUPPORTED");
  const pinned = addresses[0];
  if (!pinned) throw Error("LIVE_STREAM_UNSUPPORTED");
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        signal,
        timeout: 20000,
        // A specific address family prevents automatic alternate-address selection.
        family: pinned.family,
        lookup: (_host, _opts, callback) => callback(null, pinned.address, pinned.family),
        headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*" },
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0) && res.headers.location) {
          res.resume();
          void fetchLiveMedia(
            new URL(res.headers.location, url).href,
            limit,
            signal,
            redirects + 1,
          ).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(
            Error(
              res.statusCode === 429 ? "ONLINE_PROVIDER_RATE_LIMITED" : "LIVE_CAPTURE_UNAVAILABLE",
            ),
          );
          return;
        }
        const parts: Buffer[] = [];
        let size = 0;
        res.on("data", (part: Buffer) => {
          size += part.length;
          if (size > limit) {
            res.destroy(Error("LIVE_FRAGMENT_TOO_LARGE"));
            return;
          }
          parts.push(part);
        });
        res.on("error", reject);
        res.on("end", () => resolve(Buffer.concat(parts)));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(Error("LIVE_CAPTURE_UNAVAILABLE")));
    req.end();
  });
}
export type LiveHlsSegment = {
  sequence: number;
  durationMs: number;
  url: string;
  programAt: string | null;
};
/** RFC 8216 media sequence is the resume cursor; discontinuities must never be stitched as continuous speech. */
export function parseLiveHls(
  text: string,
  base: string,
): { segments: LiveHlsSegment[]; ended: boolean } {
  liveMediaUrl(base);
  if (!text.startsWith("#EXTM3U") || text.length > 2 * 1024 * 1024)
    throw Error("LIVE_STREAM_UNSUPPORTED");
  const lines = text
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);
  const sequenceLine = lines.find((v) => v.startsWith("#EXT-X-MEDIA-SEQUENCE:"));
  let sequence = Number(sequenceLine?.split(":")[1] ?? 0);
  let durationMs: number | null = null;
  let programAt: string | null = null;
  const segments: LiveHlsSegment[] = [];
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw Error("LIVE_STREAM_UNSUPPORTED");
  for (const line of lines) {
    if (line.startsWith("#EXT-X-KEY:") && !/^#EXT-X-KEY:METHOD=NONE(?:,|$)/.test(line))
      throw Error("LIVE_STREAM_UNSUPPORTED");
    if (
      line.startsWith("#EXT-X-MAP:") ||
      line.startsWith("#EXT-X-STREAM-INF:") ||
      line.startsWith("#EXT-X-BYTERANGE:")
    )
      throw Error("LIVE_STREAM_UNSUPPORTED");
    if (line === "#EXT-X-DISCONTINUITY" || line === "#EXT-X-GAP") throw Error("LIVE_CAPTURE_GAP");
    if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      const value = line.slice(25);
      if (!Number.isFinite(Date.parse(value))) throw Error("LIVE_STREAM_UNSUPPORTED");
      programAt = new Date(value).toISOString();
    }
    if (line.startsWith("#EXTINF:")) {
      durationMs = Math.round(Number(line.slice(8).split(",")[0]) * 1000);
      if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 30000)
        throw Error("LIVE_STREAM_UNSUPPORTED");
    }
    if (line.startsWith("#")) continue;
    if (durationMs === null || !Number.isSafeInteger(sequence + 1))
      throw Error("LIVE_STREAM_UNSUPPORTED");
    const url = liveMediaUrl(new URL(line, base).href).href;
    segments.push({ sequence: sequence++, durationMs, url, programAt });
    if (programAt) programAt = new Date(Date.parse(programAt) + durationMs).toISOString();
    durationMs = null;
  }
  if (durationMs !== null || segments.length > 5000) throw Error("LIVE_STREAM_UNSUPPORTED");
  return { segments, ended: lines.includes("#EXT-X-ENDLIST") };
}
