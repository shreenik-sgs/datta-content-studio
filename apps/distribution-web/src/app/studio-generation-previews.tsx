import type { PublicStudioPackage } from "../lib/studio-model";

export function StudioGenerationPreviews({
  packages,
}: { packages: readonly PublicStudioPackage[] }) {
  const files = packages.flatMap((pkg) =>
    (pkg.generationPreviews ?? []).map((file) => ({ pkg, file })),
  );
  if (!files.length) return null;
  return (
    <section className="playlist-overview" aria-label="Completed MP4 previews">
      <h3>
        Ready to preview · {files.length} MP4{files.length === 1 ? "" : "s"}
      </h3>
      <p>
        These videos have passed their render checks. You can watch them now while the remaining
        files are created. Editing and submission unlock when their recording finishes. Nothing has
        been approved or posted.
      </p>
      {files.map(({ pkg, file }) => {
        const base = `/distribution/api/studio/${pkg.id}/assets/${file.id}`;
        return (
          <details key={`${pkg.id}-${file.id}`} className="generation-preview">
            <summary>{file.title} · Preview MP4</summary>
            <p className="muted">{pkg.workspaceName ?? pkg.source.title}</p>
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
