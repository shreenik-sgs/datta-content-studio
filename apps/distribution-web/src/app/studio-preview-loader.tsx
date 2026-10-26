"use client";
import { type ReactNode, useEffect, useState } from "react";
import type { PublicStudioOutput, PublicStudioPackage, StudioDetail } from "../lib/studio-model";

/** The series table carries metadata; load full review evidence only for the opened file. */
export function StudioPreviewLoader({
  packageId,
  outputId,
  revision,
  children,
}: {
  packageId: string;
  outputId: string;
  revision: number;
  children: (pkg: PublicStudioPackage, output: PublicStudioOutput) => ReactNode;
}) {
  const [detail, setDetail] = useState<StudioDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Revision and retry signals intentionally reload the full file.
  useEffect(() => {
    const abort = new AbortController();
    setDetail(null);
    setFailed(false);
    void (async () => {
      try {
        const response = await fetch(`/distribution/api/studio/${packageId}`, {
          cache: "no-store",
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]),
        });
        const data: StudioDetail = await response.json();
        if (!response.ok || data.package?.id !== packageId || data.package.summaryOnly)
          throw Error("PREVIEW_UNAVAILABLE");
        if (!abort.signal.aborted) setDetail(data);
      } catch {
        if (!abort.signal.aborted) setFailed(true);
      }
    })();
    return () => abort.abort();
  }, [packageId, revision, attempt]);
  if (failed)
    return (
      <output style={{ display: "block" }}>
        <span>The file preview could not load. Your file and edits are saved.</span>
        <button className="button" type="button" onClick={() => setAttempt((value) => value + 1)}>
          Retry preview
        </button>
      </output>
    );
  if (!detail) return <output>Loading file and review details…</output>;
  const output = detail.package.outputs.find((file) => file.id === outputId);
  return output ? (
    children(detail.package, output)
  ) : (
    <output>This file has changed. Close the preview and refresh the file list.</output>
  );
}
