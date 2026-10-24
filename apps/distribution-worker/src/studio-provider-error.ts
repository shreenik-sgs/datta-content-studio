/** Safe diagnostics only: never retain provider messages, credential-bearing URLs or response bodies. */
export class StudioProviderError extends Error {
  constructor(
    code: string,
    readonly retryAfterMs = 0,
    readonly requestNotSent = false,
    readonly transcriptionResumable = false,
  ) {
    super(code);
  }
}

export async function studioHttpFailure(response: Response): Promise<never> {
  const header = response.headers.get("retry-after");
  const delay = header
    ? /^\d+(\.\d+)?$/.test(header)
      ? Number(header) * 1000
      : Date.parse(header) - Date.now()
    : 0;
  let quotaExhausted = false;
  let spendCapReached = false;
  // Read only a bounded error payload to classify quota versus temporary rate limiting.
  if (response.status === 429) {
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (reader)
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 16384) break;
          chunks.push(part.value);
        }
      if (size <= 16384) {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        // Gemini can report a project spend cap as HTTP 429 without QuotaFailure
        // details. This requires the owner's budget decision, not a timed retry.
        const message = typeof value?.error?.message === "string" ? value.error.message : "";
        spendCapReached =
          /\b(?:exceeded|reached)\s+(?:its\s+|your\s+|the\s+)?(?:monthly\s+)?spend(?:ing)?\s+cap\b/i.test(
            message,
          ) ||
          /\b(?:monthly\s+)?spend(?:ing)?\s+cap\s+(?:(?:has been|is)\s+)?(?:exceeded|reached)\b/i.test(
            message,
          );
        quotaExhausted =
          value?.error?.code === "insufficient_quota" ||
          value?.error?.details?.some((detail: { violations?: { quotaId?: string }[] }) =>
            detail?.violations?.some((violation) => /PerDay|Daily/.test(violation?.quotaId ?? "")),
          ) === true;
      }
    } catch {
      /* Unknown payloads retain the HTTP classification. */
    } finally {
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
    }
  } else await response.body?.cancel();
  const code =
    response.status === 429
      ? spendCapReached
        ? "STUDIO_PROVIDER_SPEND_CAP_REACHED"
        : quotaExhausted
          ? "STUDIO_PROVIDER_QUOTA_EXHAUSTED"
          : "STUDIO_PROVIDER_RATE_LIMITED"
      : [401, 403].includes(response.status)
        ? "STUDIO_PROVIDER_AUTHENTICATION_FAILED"
        : response.status === 402
          ? "STUDIO_PROVIDER_BILLING_REQUIRED"
          : [400, 404, 422].includes(response.status)
            ? "STUDIO_PROVIDER_REQUEST_INVALID"
            : "STUDIO_PROVIDER_UNAVAILABLE";
  throw new StudioProviderError(
    code,
    Number.isFinite(delay) ? Math.max(0, Math.min(86400000, delay)) : 0,
  );
}

/** Only failures before a connection exists prove that no paid request reached the provider. */
export function studioTransportFailure(
  error: unknown,
  signal?: AbortSignal | null,
): StudioProviderError {
  const cause =
    error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  const requestNotSent =
    typeof cause?.code === "string" &&
    [
      "ENOTFOUND",
      "EAI_AGAIN",
      "ECONNREFUSED",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "UND_ERR_CONNECT_TIMEOUT",
    ].includes(cause.code);
  return new StudioProviderError(
    signal?.aborted
      ? signal.reason?.name === "TimeoutError"
        ? "STUDIO_PROVIDER_TIMEOUT"
        : "STUDIO_PROVIDER_ABORTED"
      : error instanceof Error && error.name === "TimeoutError"
        ? "STUDIO_PROVIDER_TIMEOUT"
        : "STUDIO_PROVIDER_UNAVAILABLE",
    0,
    requestNotSent,
  );
}
