import { Writable } from "node:stream";
import busboy from "busboy";

/** Parse multipart incrementally; never concatenate the complete request body. */
export async function readBoundedFormData(request: Request, maximum: number): Promise<FormData> {
  const length = request.headers.get("content-length");
  if (length && Number(length) > maximum) throw new Error("UPLOAD_TOO_LARGE");
  let total = 0;
  let oversized = false;
  try {
    if (!request.body) throw new Error("INVALID_REQUEST");
    const form = new FormData();
    const parser = busboy({
      headers: { "content-type": request.headers.get("content-type") ?? "" },
      defParamCharset: "utf8",
      limits: { files: 1, fields: 8, parts: 9, fieldSize: 8192, fileSize: maximum },
    });
    const invalid = () => parser.destroy(new Error("INVALID_REQUEST"));
    parser.on("filesLimit", invalid).on("fieldsLimit", invalid).on("partsLimit", invalid);
    parser.on("field", (name, value, info) => {
      if (info.nameTruncated || info.valueTruncated) invalid();
      else form.append(name, value);
    });
    parser.on("file", (name, file, info) => {
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      file.on("error", () => {});
      file.on("limit", () => {
        oversized = true;
        parser.destroy(new Error("UPLOAD_TOO_LARGE"));
      });
      file.on("data", (chunk: Buffer<ArrayBuffer>) => chunks.push(chunk));
      file.on("end", () => {
        if (!file.truncated)
          form.append(name, new File(chunks, info.filename, { type: info.mimeType }));
        chunks.length = 0;
      });
    });
    await request.body
      .pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            total += chunk.byteLength;
            if (total > maximum) {
              oversized = true;
              throw new Error("UPLOAD_TOO_LARGE");
            }
            controller.enqueue(chunk);
          },
        }),
      )
      .pipeTo(Writable.toWeb(parser));
    return form;
  } catch {
    throw new Error(oversized ? "UPLOAD_TOO_LARGE" : "INVALID_REQUEST");
  }
}

/** Share the memory budget across upload routes, including separate Next route bundles. */
export function acquireMasterUpload(): () => void {
  const state = globalThis as typeof globalThis & { __sgsMasterUploadActive?: boolean };
  if (state.__sgsMasterUploadActive) throw new Error("UPLOAD_BUSY");
  state.__sgsMasterUploadActive = true;
  let released = false;
  return () => {
    if (!released) state.__sgsMasterUploadActive = false;
    released = true;
  };
}

export async function readBoundedBody(
  request: Request | Response,
  maximum: number,
): Promise<Uint8Array> {
  const length = request.headers.get("content-length");
  if (length && Number(length) > maximum) throw new Error("UPLOAD_TOO_LARGE");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new Error("UPLOAD_TOO_LARGE");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

const statuses: Record<string, number> = {
  INDEPENDENT_REVIEW_REQUIRED: 403,
  INVALID_ACTIVATION_PACKAGE: 400,
  ACTIVATION_PACKAGE_REQUIRED: 409,
  ACTIVATION_PACKAGE_CHANGED: 409,
  DESTINATION_TEST_REQUIRED: 409,
  CTA_DESTINATION_MISMATCH: 409,
  DESTINATION_AUDIENCE_REFUSED: 409,
  ANALYTICS_POLICY_REQUIRED: 409,
  ANALYTICS_POLICY_ALREADY_APPROVED: 409,
  INVALID_ANALYTICS_POLICY: 400,
  INVALID_ANALYTICS_BATCH: 400,
  INVALID_ANALYTICS_EVENT: 400,
  ANALYTICS_PRODUCER_NOT_ADOPTED: 403,
  ANALYTICS_RETENTION_WINDOW: 400,
  INVALID_ANALYTICS_WINDOW: 400,
  ANALYTICS_REBUILD_LIMIT: 409,
  INVALID_PROVIDER_METRIC: 400,
  INVALID_ANALYTICS_LINEAGE: 400,
  ANALYTICS_CAMPAIGN_DEFINITION_REQUIRED: 409,

  NATIVE_REVIEW_REQUIRED: 409,
  NATIVE_REVIEWER_REQUIRED: 403,
  REVIEWER_NOT_FOUND: 404,
  INVALID_REVIEWER_LANGUAGES: 400,
  REVIEWER_LANGUAGES_CHANGED: 409,
  TEACHING_INTEGRITY_FAILED: 409,
  INTEGRITY_EVIDENCE_REQUIRED: 400,
  NATIVE_SOURCE_MISMATCH: 409,
  NATIVE_TRACEABILITY_REQUIRED: 400,
  INVALID_NATIVE_ANNOTATION: 400,
  INVALID_LANGUAGE_SPAN: 400,
  INVALID_WORD_SPAN: 400,
  DUPLICATE_NATIVE_ID: 400,
  INVALID_TEACHING_SOURCE: 400,
  INVALID_NATIVE_BOUNDARY: 400,
  INVALID_CANDIDATE_SCORE: 400,
  IDEMPOTENCY_CONFLICT: 409,
  FEATURE_UNAVAILABLE: 404,
  DESTINATION_UNAVAILABLE: 409,
  DESTINATION_CHECK_STALE: 409,
  ACTIVATION_DEPENDENCY_CHANGED: 409,
  ACTIVATION_NOT_APPROVED: 409,
  ACTIVATION_NOT_DRAFT: 409,
  ACTIVATION_STOPPED: 409,
  CTA_NOT_APPROVED: 409,
  CAMPAIGN_OUTSIDE_WINDOW: 409,
  CHANNEL_UNAVAILABLE: 409,
  NOT_DUE: 409,
  STOPPED: 409,
  TEST_WORLD_REQUIRED: 403,
  UNSUPPORTED_LINK_LANGUAGE: 400,
  INVALID_ACTIVATION: 400,
  ARTIFACT_NOT_APPROVED: 409,
  ARTIFACT_MISMATCH: 409,
  SOURCE_DEPENDENCY_CHANGED: 409,
  QUOTE_NOT_APPROVED: 409,
  UNSUPPORTED_RENDER_MEDIA: 400,
  UNSUPPORTED_RENDER_TEMPLATE: 400,
  TRANSLATION_RENDER_NOT_AVAILABLE: 400,
  INVALID_TEMPLATE: 400,
  INVALID_CAPTION_MODE: 400,
  PARTIAL_CAPTION_SEGMENT: 400,
  TRANSLATION_NOT_APPROVED: 409,
  CAMPAIGN_STOPPED: 409,
  CAMPAIGN_NOT_DRAFT: 409,
  CAMPAIGN_NOT_APPROVED: 409,
  INVALID_OUTREACH_CAMPAIGN: 400,
  INVALID_CTA: 400,
  UNSAFE_DESTINATION: 400,
  GENERIC_FALLBACK_REFUSED: 400,
  INVALID_PAGINATION: 400,
  SOURCE_VERSION_STALE: 409,
  TRANSCRIPT_SUPERSEDED: 409,
  TRANSCRIPT_ALREADY_EXISTS: 409,
  GLOSSARY_SUPERSEDED: 409,
  TRANSCRIPT_NOT_APPROVED: 409,
  SOURCE_MISMATCH: 409,
  INVALID_TRANSCRIPT: 400,
  INVALID_TRANSCRIPT_VERSION: 400,
  INVALID_REVIEW: 400,
  INVALID_SOURCE_SPAN: 400,
  INVALID_QUOTE_CANDIDATE: 400,
  NOT_EXACT_QUOTE: 400,
  QUOTE_TEXT_MISMATCH: 400,
  INVALID_GLOSSARY_ENTRY: 400,
  INVALID_LANGUAGE: 400,

  FORBIDDEN: 403,
  NOT_FOUND: 404,
  REVISION_CONFLICT: 409,
  CONTENT_WITHDRAWN: 409,
  WITHDRAWN: 409,
  NOT_APPROVED: 409,
  APPROVAL_STALE: 409,
  RIGHTS_MISSING: 409,
  RELEASE_PENDING: 409,
  RIGHTS_EXPIRED: 409,
  CHANNEL_NOT_PERMITTED: 403,
  TERRITORY_NOT_PERMITTED: 403,
  RESTRICTED_CONTENT: 403,
  INVALID_RIGHTS: 400,
  INVALID_MEDIA: 400,
  INVALID_CONTENT: 400,
  INVALID_ASSET: 400,
  UPLOAD_TOO_LARGE: 413,
  UPLOAD_BUSY: 429,
  DUPLICATE_MASTER: 409,
  NOT_READY_FOR_REVIEW: 409,
  INVALID_REQUEST: 400,
};
export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}
export function safeProblem(error: unknown): Response {
  const code =
    error instanceof Error
      ? error.message.replace(/^(?:EXPORT_REFUSED|APPROVAL_REFUSED):/, "")
      : "";
  if (Object.hasOwn(statuses, code)) return json({ error: code }, statuses[code]);
  if (error instanceof Error && error.name === "ZodError")
    return json({ error: "INVALID_REQUEST" }, 400);
  return json({ error: "unavailable" }, 503);
}
export async function boundedJson(request: Request): Promise<unknown> {
  try {
    return JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 16384)));
  } catch {
    throw new Error("INVALID_REQUEST");
  }
}

/** A source preview supports one HTTP byte range; multipart ranges are refused. */
export function singleRange(
  value: string | null,
  length: number,
): { start: number; end: number } | null | "invalid" {
  if (value === null) return null;
  if (!Number.isSafeInteger(length) || length < 1) return "invalid";
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return "invalid";
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return "invalid";
    return { start: Math.max(0, length - suffix), end: length - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : length - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= length || end < start)
    return "invalid";
  return { start, end: Math.min(end, length - 1) };
}
