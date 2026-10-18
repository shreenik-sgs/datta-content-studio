// Full source audio plus multi-message drafts can exceed three minutes; the worker renews its lease.
export const STUDIO_GENERATIVE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

/** Retry only explicit transient Gemini refusals, never ambiguous network failures or publication. */
export async function fetchGeminiWithRetry(
  fetcher: typeof fetch,
  url: string,
  request: RequestInit,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    request.signal?.throwIfAborted();
    const response = await fetcher(url, request);
    if (attempt >= 2 || ![502, 503, 504].includes(response.status)) return response;
    const header = response.headers.get("retry-after");
    const retryAfter = header
      ? /^\d+$/.test(header)
        ? Number(header) * 1000
        : Date.parse(header) - Date.now()
      : 0;
    // A long provider cooldown needs an explicit later retry, not an early request.
    if (Number.isFinite(retryAfter) && retryAfter > 30000) return response;
    await response.body?.cancel();
    const delay = Math.max(
      attempt === 0 ? 2000 : 8000,
      Number.isFinite(retryAfter) ? retryAfter : 0,
    );
    await new Promise<void>((resolve, reject) => {
      const signal = request.signal;
      const abort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(new Error("STUDIO_PROVIDER_ABORTED"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, delay);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
}
