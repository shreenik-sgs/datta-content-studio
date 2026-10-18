"use client";
import { useEffect, useState } from "react";
export default function StoragePage() {
  const [jobs, setJobs] = useState<
    {
      id: string;
      title: string;
      status: string;
      error: string | null;
      total: number;
      removed: number;
    }[]
  >([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    async function load() {
      try {
        const response = await fetch("/distribution/api/storage", {
          signal: abort.signal,
          cache: "no-store",
        });
        if (!response.ok) throw Error();
        setJobs((await response.json()).jobs);
        setError("");
      } catch {
        if (!abort.signal.aborted)
          setError("Unable to load cleanup progress. Refresh to try again.");
      }
    }
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, []);
  return (
    <main className="shell">
      <a href="/distribution?view=studio">Back to curation</a>
      <section className="panel">
        <h1>Storage cleanup</h1>
        <p>
          Open a source in Continue Existing Curation. Choose Delete master, Delete package or
          Delete playlist near the workspace title to preview and confirm deletion.
        </p>
        {error && <p role="alert">{error}</p>}
        {jobs.length === 0 && !error && <p>No cleanup has been requested.</p>}
        {jobs.map((job) => (
          <article className="panel" key={job.id}>
            <h2>{job.title}</h2>
            <p>
              {job.status === "COMPLETE"
                ? "Cleanup complete"
                : job.status === "RETRY"
                  ? "Waiting to retry"
                  : "Removing files"}{" "}
              · {job.removed} of {job.total} files
            </p>
            {job.error && <p role="alert">{job.error}</p>}
          </article>
        ))}
      </section>
    </main>
  );
}
