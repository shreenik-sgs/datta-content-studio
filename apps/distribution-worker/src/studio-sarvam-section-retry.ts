import { StudioProviderError } from "./studio-provider-error.js";

/** A rate-limit budget belongs to one durable audio section, not the entire master. */
export async function retrySarvamSection<T>(input: {
  run: () => Promise<T>;
  onWait: (retryAt: string | null) => Promise<void>;
  signal?: AbortSignal | undefined;
}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    if (input.signal?.aborted)
      throw new StudioProviderError("STUDIO_PROVIDER_ABORTED", 0, false, true);
    try {
      return await input.run();
    } catch (error) {
      if (
        attempt >= 2 ||
        !(error instanceof StudioProviderError) ||
        error.message !== "STUDIO_PROVIDER_RATE_LIMITED" ||
        (!error.transcriptionResumable && !error.requestNotSent) ||
        error.retryAfterMs > 3600000
      )
        throw error;
      const delay = Math.max(error.retryAfterMs, (attempt + 1) * 60000);
      await input.onWait(new Date(Date.now() + delay).toISOString());
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", abort);
          reject(new StudioProviderError("STUDIO_PROVIDER_ABORTED", 0, false, true));
        };
        const timer = setTimeout(() => {
          input.signal?.removeEventListener("abort", abort);
          resolve();
        }, delay);
        input.signal?.addEventListener("abort", abort, { once: true });
        if (input.signal?.aborted) abort();
      });
      await input.onWait(null);
    }
  }
}
