import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { providerJson } from "./studio-intelligence.js";
import { studioHttpFailure, studioTransportFailure } from "./studio-provider-error.js";
import { STUDIO_GENERATIVE_REQUEST_TIMEOUT_MS } from "./studio-provider-retry.js";

// Full 30-minute proxies retain the same picture, frame rate and audio as Shorts.
export const STUDIO_REVIEW_MEDIA_MAX_BYTES = 128 * 1024 * 1024;
const inlineBudget = 12 * 1024 * 1024; // 16 MiB after base64, across the entire request.
const origin = "https://generativelanguage.googleapis.com";
export type StudioReviewPart =
  | { text: string }
  | { bytes: Buffer; mimeType: "video/mp4" | "image/png" };
type ProviderPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { mimeType: string; fileUri: string } };

/** Use owned, temporary provider files when the complete evidence is too large to inline. */
export async function withStudioReviewMedia<T>(
  input: {
    apiKey: string;
    fetcher?: typeof fetch;
    signal?: AbortSignal;
    parts: StudioReviewPart[];
  },
  consume: (parts: ProviderPart[]) => Promise<T>,
): Promise<T> {
  const media = input.parts.filter((part) => "bytes" in part);
  if (media.some((part) => !part.bytes.length || part.bytes.length > STUDIO_REVIEW_MEDIA_MAX_BYTES))
    throw Error("STUDIO_PRESENTATION_REVIEW_MEDIA_TOO_LARGE");
  let inlineBytes = media.reduce((sum, part) => sum + part.bytes.length, 0);
  const external = new Set<StudioReviewPart>();
  for (const part of [...media].sort((a, b) => b.bytes.length - a.bytes.length)) {
    if (inlineBytes <= inlineBudget) break;
    external.add(part);
    inlineBytes -= part.bytes.length;
  }
  const fetcher = input.fetcher ?? fetch;
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(STUDIO_GENERATIVE_REQUEST_TIMEOUT_MS)])
    : AbortSignal.timeout(STUDIO_GENERATIVE_REQUEST_TIMEOUT_MS);
  const owned: string[] = [];
  const json = (url: string, init: RequestInit) =>
    providerJson(fetcher, url, { redirect: "error", signal, ...init }, 64 * 1024);
  const headers = { "x-goog-api-key": input.apiKey };
  try {
    const parts: ProviderPart[] = [];
    for (const part of input.parts) {
      signal.throwIfAborted();
      if ("text" in part) {
        parts.push(part);
        continue;
      }
      if (!external.has(part)) {
        parts.push({
          inlineData: { mimeType: part.mimeType, data: part.bytes.toString("base64") },
        });
        continue;
      }
      // Client-chosen identity permits cleanup even after an ambiguous upload result.
      // Never delete a resource name taken from an untrusted provider response.
      const name = `files/dcs-${randomUUID().replaceAll("-", "")}`;
      owned.push(name);
      let start: Response;
      try {
        start = await fetcher(`${origin}/upload/v1beta/files`, {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            ...headers,
            "Content-Type": "application/json",
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": String(part.bytes.length),
            "X-Goog-Upload-Header-Content-Type": part.mimeType,
          },
          body: JSON.stringify({ file: { name, displayName: "Studio review evidence" } }),
        });
      } catch (error) {
        throw studioTransportFailure(error, signal);
      }
      if (!start.ok) throw await studioHttpFailure(start);
      const upload = start.headers.get("x-goog-upload-url");
      await start.body?.cancel();
      const url = upload ? URL.parse(upload) : null;
      if (
        !url ||
        url.origin !== origin ||
        url.username ||
        url.password ||
        url.hash ||
        url.pathname !== "/upload/v1beta/files"
      )
        throw Error("STUDIO_PROVIDER_INVALID_RESPONSE");
      const result = await json(url.href, {
        method: "POST",
        headers: {
          "Content-Type": part.mimeType,
          "Content-Length": String(part.bytes.length),
          "X-Goog-Upload-Offset": "0",
          "X-Goog-Upload-Command": "upload, finalize",
        },
        body: new Uint8Array(part.bytes),
      });
      let file: unknown =
        result && typeof result === "object" && "file" in result ? result.file : null;
      for (;;) {
        if (!file || typeof file !== "object") throw Error("STUDIO_PROVIDER_INVALID_RESPONSE");
        const metadata = file as Record<string, unknown>;
        if (
          metadata.name !== name ||
          metadata.uri !== `${origin}/v1beta/${name}` ||
          metadata.mimeType !== part.mimeType ||
          Number(metadata.sizeBytes) !== part.bytes.length
        )
          throw Error("STUDIO_PROVIDER_INVALID_RESPONSE");
        if (metadata.state === "ACTIVE") {
          parts.push({ fileData: { mimeType: part.mimeType, fileUri: metadata.uri as string } });
          break;
        }
        if (metadata.state !== "PROCESSING") throw Error("STUDIO_PRESENTATION_REVIEW_FILE_FAILED");
        await delay(5000, undefined, { signal });
        file = await json(`${origin}/v1beta/${name}`, { headers });
      }
    }
    return await consume(parts);
  } finally {
    // Aborting a job must still release its own uploads. Provider retention is a
    // final fallback if cleanup is unavailable; cleanup never replays paid review.
    for (const name of owned) {
      try {
        const response = await fetcher(`${origin}/v1beta/${name}`, {
          method: "DELETE",
          redirect: "error",
          headers,
          signal: AbortSignal.timeout(10000),
        });
        await response.body?.cancel();
        if (!response.ok && response.status !== 404)
          console.warn(JSON.stringify({ event: "studio.review.file.cleanup_failed" }));
      } catch {
        console.warn(JSON.stringify({ event: "studio.review.file.cleanup_failed" }));
      }
    }
  }
}
