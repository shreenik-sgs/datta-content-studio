import {
  type StudioGenerationProgress,
  studioNeedsSuitabilityReview,
} from "@satsang/distribution-domain";
import { studioMessage } from "../lib/studio-model";
import { useHubTimestamp } from "./hub-locale";
import { StudioGenerationProgressView } from "./studio-generation-progress";

export type SeriesGenerationItem = {
  id: string;
  title: string;
  status?: string | undefined;
  generationProgress?: StudioGenerationProgress | null | undefined;
  failure?: string | null | undefined;
};

/** The same live job evidence is visible in both the playlist overview and file workspace. */
export function SeriesGenerationProgress({ items }: { items: readonly SeriesGenerationItem[] }) {
  const formatTimestamp = useHubTimestamp();
  const active = items.filter((item) => item.status === "GENERATING");
  const queued = items.filter((item) => item.status === "QUEUED");
  const failed = items.filter(
    (item) => item.status === "FAILED" && !studioNeedsSuitabilityReview(item.failure),
  );
  if (!active.length && !queued.length && !failed.length) return null;
  const visible = [
    ...active,
    ...queued.filter((item) => item.generationProgress?.retryAt),
    ...failed,
  ];
  return (
    <section
      className="playlist-overview"
      aria-label="Series generation progress"
      aria-live="polite"
    >
      <strong>
        {active.length
          ? "Generation in progress"
          : queued.length
            ? "Waiting for generation"
            : "Generation needs attention"}
      </strong>
      <p>
        {active.length} processing · {queued.length} queued
        {failed.length ? ` · ${failed.length} stopped` : ""}
      </p>
      {visible.map((item) => (
        <div key={item.id}>
          <h4>{item.title}</h4>
          {item.generationProgress ? (
            <StudioGenerationProgressView
              value={item.generationProgress}
              status={item.status ?? "FAILED"}
              formatTimestamp={formatTimestamp}
            />
          ) : (
            <p>
              {item.status === "FAILED"
                ? studioMessage(item.failure ?? "unavailable")
                : "The worker has started this recording. Waiting for its first progress update."}
            </p>
          )}
        </div>
      ))}
      {queued.length > 0 && (
        <p>
          Queued recordings start as worker capacity becomes available. You do not need to generate
          them again.
        </p>
      )}
      {(active.length > 0 || queued.length > 0) && (
        <p>Status refreshes automatically. Generated files remain drafts for human review.</p>
      )}
    </section>
  );
}
