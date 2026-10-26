import type { PublicStudioPackage } from "../lib/studio-model";
import { useHubTimestamp } from "./hub-locale";

export function StudioGenerationPreviews({
  packages,
}: { packages: readonly PublicStudioPackage[] }) {
  const formatTimestamp = useHubTimestamp();
  const files = packages.flatMap((pkg) =>
    (pkg.generationPreviews ?? []).map((file) => ({ pkg, file })),
  );
  if (!files.length) {
    const pending = packages.some(
      (pkg) => !pkg.outputs.length && ["QUEUED", "GENERATING"].includes(pkg.status),
    );
    return pending ? (
      <section className="playlist-overview" aria-label="Completed MP4 previews">
        <h3>No playable MP4s yet</h3>
        <p>
          Teaching discovery and AI review come before rendering. Each completed video appears here
          automatically after its render checks; you do not need to wait for the whole recording or
          playlist. See the live generation progress for the current stage.
        </p>
      </section>
    ) : null;
  }
  const previous = files.filter(({ file }) => file.fromPreviousRun).length;
  return (
    <section className="playlist-overview" aria-label="Completed MP4 previews">
      <h3>
        Ready to preview · {files.length} MP4{files.length === 1 ? "" : "s"}
      </h3>
      <p>
        Watch completed videos while generation continues. Editing and submission unlock when their
        recording finishes. Nothing has been approved or posted.
      </p>
      {previous > 0 && (
        <p>
          {previous} {previous === 1 ? "preview is" : "previews are"} from an earlier run. Settings,
          branding or the closing-card destination may differ from your latest choices. These are
          retained for viewing only while updated drafts are prepared.
        </p>
      )}
      {files.map(({ pkg, file }, index) => {
        const base = `/distribution/api/studio/${pkg.id}/assets/${file.id}`;
        return (
          <details key={`${pkg.id}-${file.id}`} className="generation-preview" open={index === 0}>
            <summary>
              {file.title} · Preview MP4{file.fromPreviousRun ? " · Earlier render" : ""}
            </summary>
            <p className="muted">{pkg.workspaceName ?? pkg.source.title}</p>
            <p className="muted">
              {file.asset?.filename}
              {file.generatedAt && (
                <>
                  {" · Rendered "}
                  <time dateTime={file.generatedAt}>{formatTimestamp(file.generatedAt)}</time>
                </>
              )}
            </p>
            <div className="studio-video-frame">
              {/* biome-ignore lint/a11y/useMediaCaption: Captions are already embedded; optional tracks are included below. */}
              <video
                controls
                playsInline
                preload="none"
                src={`${base}/media?preview=1`}
                aria-label={`Preview ${file.title}`}
              >
                {file.captions.map((caption) => (
                  <track
                    key={caption.language}
                    kind="subtitles"
                    srcLang={caption.language}
                    label={caption.language}
                    src={`${base}/captions?preview=1&language=${caption.language}`}
                  />
                ))}
              </video>
            </div>
          </details>
        );
      })}
    </section>
  );
}
