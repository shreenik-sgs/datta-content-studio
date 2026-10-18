import { STUDIO_LANGUAGES, type StudioTranscript } from "@satsang/distribution-domain";
import { normalizeStudioTranscription } from "./studio-intelligence";
import {
  StudioProviderError,
  studioHttpFailure,
  studioTransportFailure,
} from "./studio-provider-error.js";
import { fetchGeminiWithRetry } from "./studio-provider-retry.js";

const API = "https://api.sarvam.ai/speech-to-text/job/v1";
const AUDIO_FILE = "source.mp3";
const MAX_AUDIO_BYTES = 128 * 1024 * 1024;
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const JOB_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;
const codes = new Set([
  "STUDIO_PROVIDER_RATE_LIMITED",
  "STUDIO_PROVIDER_AUTHENTICATION_FAILED",
  "STUDIO_PROVIDER_UNAVAILABLE",
  "STUDIO_PROVIDER_INVALID_RESPONSE",
  "STUDIO_PROVIDER_RESPONSE_LIMIT",
  "STUDIO_PROVIDER_UNSAFE_STORAGE_URL",
  "STUDIO_PROVIDER_TRANSCRIPTION_FAILED",
  "STUDIO_TRANSCRIPTION_CONTEXT_LIMIT",
  "STUDIO_PROVIDER_ABORTED",
  "STUDIO_PROVIDER_TIMEOUT",
  "STUDIO_TRANSCRIPT_INVALID",
  "STUDIO_TRANSCRIPT_LANGUAGE_MISMATCH",
]);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("STUDIO_PROVIDER_INVALID_RESPONSE");
  return value as Record<string, unknown>;
}

function waitForPoll(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("STUDIO_PROVIDER_ABORTED"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, POLL_INTERVAL_MS);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Only public object-storage hosts matching Sarvam's returned backend may receive source bytes. */
function storageUrl(value: unknown, storageType: unknown): string {
  if (typeof value !== "string" || value.length > 16000 || /[\s\\]/u.test(value))
    throw new Error("STUDIO_PROVIDER_UNSAFE_STORAGE_URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("STUDIO_PROVIDER_UNSAFE_STORAGE_URL");
  }
  const azure = /^https:\/\/[a-z0-9]{3,24}\.blob\.core\.windows\.net$/u.test(url.origin);
  const google =
    url.hostname === "storage.googleapis.com" ||
    /^[a-z0-9][a-z0-9.-]*\.storage\.googleapis\.com$/u.test(url.hostname);
  // Sarvam also returns AWS for batch jobs. Accept S3 object endpoints, never
  // arbitrary AWS services, website endpoints or caller-controlled redirects.
  const aws =
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\.s3(?:\.[a-z]{2}(?:-[a-z]+)+-\d)?\.amazonaws\.com$/u.test(
      url.hostname,
    );
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    (!((storageType === "Azure" || storageType === "Azure_V1") && azure) &&
      !(storageType === "Google" && google) &&
      !(storageType === "AWS" && aws))
  )
    throw new Error("STUDIO_PROVIDER_UNSAFE_STORAGE_URL");
  return url.href;
}

async function checkResponse(response: Response): Promise<void> {
  if (response.ok) return;
  return studioHttpFailure(response);
}

async function jsonResponse(response: Response, maximum: number): Promise<unknown> {
  await checkResponse(response);
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > maximum) {
    await response.body?.cancel();
    throw new Error("STUDIO_PROVIDER_RESPONSE_LIMIT");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("STUDIO_PROVIDER_INVALID_RESPONSE");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > maximum) {
        await reader.cancel();
        throw new Error("STUDIO_PROVIDER_RESPONSE_LIMIT");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("STUDIO_PROVIDER_INVALID_RESPONSE");
  }
}

function assertJob(value: unknown, expectedId?: string): Record<string, unknown> {
  const job = record(value);
  if (
    typeof job.job_id !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/u.test(job.job_id) ||
    (expectedId !== undefined && job.job_id !== expectedId) ||
    !["Accepted", "Pending", "Running", "Completed", "Failed"].includes(String(job.job_state))
  )
    throw new Error("STUDIO_PROVIDER_INVALID_RESPONSE");
  if (job.job_state === "Failed") throw new Error("STUDIO_PROVIDER_TRANSCRIPTION_FAILED");
  return job;
}

function outputFile(job: Record<string, unknown>): string {
  // A confirmed terminal model-capacity failure is safe to split and resubmit.
  // Never classify timeouts, transport failures or arbitrary provider text this way.
  if (
    job.job_state === "Completed" &&
    job.total_files === 1 &&
    job.successful_files_count === 0 &&
    job.failed_files_count === 1 &&
    Array.isArray(job.job_details) &&
    job.job_details.length === 1
  ) {
    const detail = record(job.job_details[0]);
    if (
      detail.state === "API Error" &&
      Array.isArray(detail.inputs) &&
      detail.inputs.length === 1 &&
      record(detail.inputs[0]).file_name === AUDIO_FILE &&
      typeof detail.error_message === "string" &&
      /Input length \(\d+\) exceeds model's maximum context length \(\d+\)/u.test(
        detail.error_message,
      )
    )
      throw new Error("STUDIO_TRANSCRIPTION_CONTEXT_LIMIT");
  }
  if (
    job.total_files !== 1 ||
    job.successful_files_count !== 1 ||
    job.failed_files_count !== 0 ||
    !Array.isArray(job.job_details) ||
    job.job_details.length !== 1
  )
    throw new Error("STUDIO_PROVIDER_TRANSCRIPTION_FAILED");
  const detail = record(job.job_details[0]);
  if (
    detail.state !== "Success" ||
    !Array.isArray(detail.inputs) ||
    detail.inputs.length !== 1 ||
    record(detail.inputs[0]).file_name !== AUDIO_FILE ||
    !Array.isArray(detail.outputs) ||
    detail.outputs.length !== 1
  )
    throw new Error("STUDIO_PROVIDER_TRANSCRIPTION_FAILED");
  const file = record(detail.outputs[0]).file_name;
  if (typeof file !== "string" || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,127}\.json$/u.test(file))
    throw new Error("STUDIO_PROVIDER_INVALID_RESPONSE");
  return file;
}

export function normalizeSarvamStudioTranscription(
  raw: unknown,
  language: string,
  durationMs: number,
  allowEmptySection = false,
): StudioTranscript {
  const data = record(raw);
  if (data.language_code !== `${language}-IN`)
    throw new Error("STUDIO_TRANSCRIPT_LANGUAGE_MISMATCH");
  const emptyTiming = data.timestamps as Record<string, unknown> | undefined;
  if (
    allowEmptySection &&
    data.transcript === "" &&
    emptyTiming &&
    [
      emptyTiming.words ?? emptyTiming.chunks,
      emptyTiming.start_time_seconds,
      emptyTiming.end_time_seconds,
    ].every((value) => Array.isArray(value) && value.length === 0) &&
    (emptyTiming.chunks === undefined ||
      (Array.isArray(emptyTiming.chunks) && emptyTiming.chunks.length === 0))
  )
    return {
      language,
      durationMs,
      provenance: "MACHINE_TRANSCRIPT",
      sourceTranscriptId: null,
      segments: [],
    };
  if (typeof data.transcript !== "string" || !data.transcript.trim())
    throw new Error("STUDIO_TRANSCRIPT_INVALID");
  const timestamps = record(data.timestamps);
  // The live v4 batch schema calls sentence/phrase entries `words`; older
  // documented responses call them `chunks`. Both carry the same coarse timing.
  const texts = timestamps.words === undefined ? timestamps.chunks : timestamps.words;
  const starts = timestamps.start_time_seconds;
  const ends = timestamps.end_time_seconds;
  if (
    !Array.isArray(texts) ||
    texts.length === 0 ||
    texts.length > 20000 ||
    !Array.isArray(starts) ||
    !Array.isArray(ends) ||
    texts.length !== starts.length ||
    texts.length !== ends.length
  )
    throw new Error("STUDIO_TRANSCRIPT_INVALID");
  if (
    timestamps.words !== undefined &&
    timestamps.chunks !== undefined &&
    (!Array.isArray(timestamps.chunks) ||
      timestamps.chunks.length !== texts.length ||
      timestamps.chunks.some((text, index) => text !== texts[index]))
  )
    throw new Error("STUDIO_TRANSCRIPT_INVALID");
  // Saaras returns phrase/sentence timing, not word timing. Never invent alignment.
  return normalizeStudioTranscription(
    {
      language,
      segments: texts.map((text, index) => {
        const end = ends[index];
        const endMs = typeof end === "number" ? Math.round(end * 1000) : Number.NaN;
        // Sarvam rounds phrase boundaries to hundredths of a second. The physical
        // recording can end between ticks (e.g. 3019.337s vs 3019.34s). Bound that
        // final half-tick to EOF; retain the strict validator for all other timing.
        const roundedPastEof =
          Number.isSafeInteger(endMs) &&
          Math.abs(end * 100 - Math.round(end * 100)) < 0.000001 &&
          endMs > durationMs &&
          endMs - durationMs <= 5;
        return { text, start: starts[index], end: roundedPastEof ? durationMs / 1000 : end };
      }),
    },
    language,
    durationMs,
  );
}

/**
 * Full-recording original-language transcription using Sarvam's asynchronous batch API.
 * https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/batch-api
 * No implicit provider retry: re-creating a paid job after an uncertain response can duplicate billing.
 */
export type SarvamJobCheckpoint = { jobId: string; stage: "created" | "starting" | "started" };
export async function transcribeSarvamStudioAudio(input: {
  bytes: Uint8Array;
  language: string;
  durationMs: number;
  apiKey: string;
  fetcher: typeof fetch;
  signal?: AbortSignal;
  model?: string;
  keyterms?: readonly string[];
  allowEmptySection?: boolean;
  recovery?: {
    saved: SarvamJobCheckpoint | undefined;
    save: (value: SarvamJobCheckpoint) => Promise<void>;
  };
}): Promise<StudioTranscript> {
  if (!input.apiKey.trim() || !input.bytes.length || input.bytes.length > MAX_AUDIO_BYTES)
    throw new Error("STUDIO_TRANSCRIPTION_NOT_CONFIGURED_OR_TOO_LARGE");
  if (
    !STUDIO_LANGUAGES.includes(input.language as never) ||
    !Number.isSafeInteger(input.durationMs) ||
    input.durationMs < 1 ||
    input.durationMs > MAX_DURATION_MS
  )
    throw new Error("STUDIO_TRANSCRIPT_INVALID");
  const model = input.model ?? "saaras:v4";
  const keyterms = input.keyterms ?? [];
  if (
    !["saaras:v4", "saaras:v3"].includes(model) ||
    !Array.isArray(keyterms) ||
    keyterms.length > 50 ||
    keyterms.some(
      (term) =>
        typeof term !== "string" ||
        !term.trim() ||
        Array.from(term).length > 64 ||
        /\p{Cc}/u.test(term),
    ) ||
    (model !== "saaras:v4" && keyterms.length > 0)
  )
    throw new Error("STUDIO_SARVAM_CONFIGURATION_INVALID");

  const timeout = AbortSignal.timeout(JOB_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  const apiHeaders = { "api-subscription-key": input.apiKey, "Content-Type": "application/json" };
  const requestJson = async (path: string, body?: unknown): Promise<unknown> => {
    signal.throwIfAborted();
    return jsonResponse(
      await (body === undefined ? fetchGeminiWithRetry.bind(null, input.fetcher) : input.fetcher)(
        `${API}${path}`,
        {
          method: body === undefined ? "GET" : "POST",
          redirect: "error",
          headers: apiHeaders,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
        },
      ),
      256 * 1024,
    );
  };
  let transcriptionResumable = false;
  try {
    const saved = input.recovery?.saved;
    if (
      saved &&
      (!/^[a-zA-Z0-9_-]{1,128}$/.test(saved.jobId) ||
        !["created", "starting", "started"].includes(saved.stage))
    )
      throw new Error("STUDIO_CACHE_INVALID");
    const created = saved
      ? { job_id: saved.jobId }
      : assertJob(
          await requestJson("", {
            job_parameters: {
              model,
              mode: "transcribe",
              language_code: `${input.language}-IN`,
              with_timestamps: true,
              with_diarization: false,
              input_audio_codec: "mp3",
              ...(keyterms.length
                ? { keyterms: [...new Set(keyterms.map((term) => term.trim()))] }
                : {}),
            },
          }),
        );
    const jobId = created.job_id as string;
    if (!saved) await input.recovery?.save({ jobId, stage: "created" });
    transcriptionResumable = Boolean(input.recovery);
    let status: Record<string, unknown>;
    if (saved && saved.stage !== "created") {
      status = assertJob(await requestJson(`/${jobId}/status`), jobId);
      if (saved.stage === "starting" && status.job_state === "Accepted")
        throw new Error("STUDIO_TRANSCRIPTION_START_UNCERTAIN");
    } else {
      const upload = assertJob(
        await requestJson("/upload-files", { job_id: jobId, files: [AUDIO_FILE] }),
        jobId,
      );
      const uploadEntry = record(record(upload.upload_urls)[AUDIO_FILE]);
      const uploadUrl = storageUrl(uploadEntry.file_url, upload.storage_container_type);
      signal.throwIfAborted();
      const uploaded = await input.fetcher(uploadUrl, {
        method: "PUT",
        redirect: "error",
        body: new Uint8Array(input.bytes),
        headers: {
          "Content-Type": "audio/mpeg",
          ...(["Azure", "Azure_V1"].includes(String(upload.storage_container_type))
            ? { "x-ms-blob-type": "BlockBlob" }
            : {}),
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(180000)]),
      });
      await checkResponse(uploaded);
      await uploaded.body?.cancel();
      await input.recovery?.save({ jobId, stage: "starting" });
      try {
        status = assertJob(await requestJson(`/${jobId}/start`, {}), jobId);
      } catch (error) {
        // An explicit rejection (or failure before connecting) proves this start
        // was not accepted. Keep the SAME job retryable; an ambiguous timeout,
        // disconnect or 5xx must retain "starting" for status reconciliation.
        const rejected =
          error instanceof StudioProviderError &&
          [
            "STUDIO_PROVIDER_RATE_LIMITED",
            "STUDIO_PROVIDER_QUOTA_EXHAUSTED",
            "STUDIO_PROVIDER_AUTHENTICATION_FAILED",
            "STUDIO_PROVIDER_BILLING_REQUIRED",
            "STUDIO_PROVIDER_REQUEST_INVALID",
          ].includes(error.message);
        if (rejected || studioTransportFailure(error, signal).requestNotSent)
          await input.recovery?.save({ jobId, stage: "created" });
        throw error;
      }
      await input.recovery?.save({ jobId, stage: "started" });
    }
    while (status.job_state !== "Completed") {
      status = assertJob(await requestJson(`/${jobId}/status`), jobId);
      if (status.job_state !== "Completed") await waitForPoll(signal);
    }
    const filename = outputFile(status);
    const download = assertJob(
      await requestJson("/download-files", { job_id: jobId, files: [filename] }),
      jobId,
    );
    if (download.job_state !== "Completed") throw new Error("STUDIO_PROVIDER_INVALID_RESPONSE");
    const entry = record(record(download.download_urls)[filename]);
    const downloadUrl = storageUrl(entry.file_url, download.storage_container_type);
    signal.throwIfAborted();
    const transcript = await jsonResponse(
      await input.fetcher(downloadUrl, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
      }),
      16 * 1024 * 1024,
    );
    return {
      ...normalizeSarvamStudioTranscription(
        transcript,
        input.language,
        input.durationMs,
        input.allowEmptySection,
      ),
      recognition: { provider: "sarvam", model },
    };
  } catch (error) {
    // Never include provider error bodies, signed URLs, API keys or transport error messages.
    if (input.signal?.aborted)
      throw new StudioProviderError("STUDIO_PROVIDER_ABORTED", 0, false, transcriptionResumable);
    if (timeout.aborted || (error instanceof Error && error.name === "TimeoutError"))
      throw new StudioProviderError("STUDIO_PROVIDER_TIMEOUT", 0, false, transcriptionResumable);
    if (error instanceof StudioProviderError)
      throw new StudioProviderError(
        error.message,
        error.retryAfterMs,
        error.requestNotSent,
        transcriptionResumable,
      );
    if (
      error instanceof Error &&
      (codes.has(error.message) ||
        [
          "STUDIO_TRANSCRIPTION_START_UNCERTAIN",
          "STUDIO_CACHE_INVALID",
          "STUDIO_LEASE_LOST",
          "REQUESTER_ROLE_REVOKED",
          "STUDIO_EXTERNAL_PROCESSING_NOT_AUTHORIZED",
        ].includes(error.message))
    )
      throw error;
    const transport = studioTransportFailure(error, signal);
    throw new StudioProviderError(
      transport.message,
      transport.retryAfterMs,
      transport.requestNotSent,
      transcriptionResumable,
    );
  }
}
