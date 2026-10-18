"use client";
import type { LiveCurationBroadcast } from "@satsang/distribution-domain";
import { useEffect, useState } from "react";
export function LiveCurationEntry({
  onGroupedMasters,
}: { onGroupedMasters: (ids: string[]) => void }) {
  const [broadcasts, setBroadcasts] = useState<LiveCurationBroadcast[]>([]);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await fetch("/distribution/api/live-curation", {
          cache: "no-store",
          signal: abort.signal,
        });
        if (!response.ok) return;
        const data = await response.json();
        setBroadcasts(data.broadcasts ?? []);
        onGroupedMasters(
          (data.broadcasts ?? []).flatMap((b: LiveCurationBroadcast) =>
            b.windows.map((w) => w.masterId),
          ),
        );
      } catch {
        /* Existing master workspaces remain available while the monitor is unreachable. */
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(load, 10000);
      }
    };
    void load();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [onGroupedMasters]);
  if (!broadcasts.length)
    return (
      <p>
        <a href="/distribution/live">Live channel monitoring</a>
      </p>
    );
  return (
    <section className="panel" aria-label="Live broadcast bundles">
      <h2>Live broadcasts</h2>
      <p>Open a broadcast to see all its generated files together.</p>
      {broadcasts.map((b) => (
        <article className="panel" key={b.id}>
          <strong>{b.title}</strong>
          <p>
            {b.status === "CAPTURING"
              ? "Capturing live"
              : b.status === "ENDED"
                ? "Capture ended"
                : "Capture needs attention"}{" "}
            · {b.windows.length} saved sections
          </p>
          <a className="button" href={`/distribution/live?broadcast=${encodeURIComponent(b.id)}`}>
            Open broadcast
          </a>
        </article>
      ))}
      <a href="/distribution/live">Manage monitoring</a>
    </section>
  );
}
