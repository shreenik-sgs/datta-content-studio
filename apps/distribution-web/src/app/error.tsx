"use client";

export default function StudioError({
  reset,
}: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="shell">
      <section className="panel" aria-labelledby="studio-error-heading">
        <p className="eyebrow">Workspace unavailable</p>
        <h1 id="studio-error-heading">We couldn’t open this screen.</h1>
        <p>
          Your saved sources, edits and review history are retained. Try opening the screen again.
        </p>
        <div className="actions wrap">
          <button type="button" className="button primary" onClick={reset}>
            Try again
          </button>
          <a className="button" href="/distribution">
            Back to workspace
          </a>
        </div>
      </section>
    </main>
  );
}
