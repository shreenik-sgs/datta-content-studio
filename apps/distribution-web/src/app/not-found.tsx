export default function StudioNotFound() {
  return (
    <main className="shell">
      <section className="panel">
        <p className="eyebrow">Page not found</p>
        <h1>This page is no longer available.</h1>
        <p>Return to the workspace to find your sources and saved curations.</p>
        <a className="button primary" href="/distribution">
          Back to workspace
        </a>
      </section>
    </main>
  );
}
