"use client";

import { useEffect, useState } from "react";
import { z } from "zod";

const responseSchema = z.object({
  bundles: z.array(
    z.object({ id: z.string().uuid(), title: z.string(), recordings: z.number().int().min(1) }),
  ),
});

/** Resolve membership independently of the paginated source picker, including reused masters. */
export function SeriesNavigation({ masterId, disabled }: { masterId: string; disabled: boolean }) {
  const [result, setResult] = useState<{
    masterId: string;
    bundles: z.infer<typeof responseSchema>["bundles"];
  } | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit retry restarts this read-only lookup.
  useEffect(() => {
    const abort = new AbortController();
    setError(false);
    void fetch(`/distribution/api/content/import?masterId=${encodeURIComponent(masterId)}`, {
      cache: "no-store",
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15000)]),
    })
      .then(async (response) => {
        if (!response.ok) throw Error("SERIES_LOOKUP_FAILED");
        const data = responseSchema.parse(await response.json());
        if (!abort.signal.aborted) setResult({ masterId, bundles: data.bundles });
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true);
      });
    return () => abort.abort();
  }, [masterId, retry]);
  if (error)
    return (
      <output>
        Series navigation could not load. Your recording is still available.{" "}
        <button className="button" type="button" onClick={() => setRetry((value) => value + 1)}>
          Retry series navigation
        </button>
      </output>
    );
  if (result?.masterId !== masterId || !result.bundles.length) return null;
  return (
    <nav className="playlist-review-navigation" aria-label="This recording’s series">
      <p>You are viewing one recording. Open the series to see all its curated files.</p>
      {result.bundles.map((bundle) => (
        <div className="actions wrap" key={bundle.id}>
          <span>
            {bundle.title} · {bundle.recordings} recordings
          </span>
          <a
            className="button"
            href={`/distribution?view=studio&bundle=${encodeURIComponent(bundle.id)}`}
            aria-disabled={disabled}
            onClick={(event) => {
              if (disabled) event.preventDefault();
            }}
          >
            All series files
          </a>
        </div>
      ))}
      {disabled && <p className="muted">Finish or cancel your edits before changing recordings.</p>}
    </nav>
  );
}
