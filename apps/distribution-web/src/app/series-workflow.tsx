"use client";
import type { OnlineImport } from "@satsang/distribution-domain";
import { useState } from "react";
import { studioMessage } from "../lib/studio-model";

export function SeriesWorkflow({
  item,
  canCurate,
  busy,
  send,
}: {
  item: OnlineImport;
  canCurate: boolean;
  busy: boolean;
  send: (data: unknown) => Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [rebaseConfirmed, setRebaseConfirmed] = useState(false);
  const plan = item.curation;
  if (!plan || plan.pausedForCleanup || plan.pausedForSettings) return null;
  const workflow = plan.workflow;
  const supported =
    plan.request?.channels.length === 1 &&
    plan.request.channels[0] === "youtube" &&
    plan.request.captions &&
    plan.request.allCompleteMessages;
  if (!workflow && !supported) return null;
  const results = Object.values(workflow?.members ?? {});
  const action = (operation: "start" | "pause" | "resume" | "rebase") =>
    send({
      action: "series-workflow",
      id: item.id,
      operation,
      confirmed: true,
      ...(workflow ? { workflowId: workflow.id, expectedVersion: workflow.version } : {}),
    });
  return (
    <section className="card" aria-label="Complete series workflow">
      <h3>Shorts and complete stories</h3>
      <p>
        Studio finishes every recording's Shorts, then finds continuous stories over 3 and up to 30
        minutes, and checks the final files and closing cards. It continues on the server when you
        leave this page.
      </p>
      <p>
        Existing files, original speech and subtitles are preserved. New files stay drafts. Longer
        videos can be downloaded for YouTube Studio; Buffer posting supports Shorts only.
      </p>
      {workflow ? (
        <>
          <output>
            <strong>
              {workflow.state === "complete"
                ? `Last completed run · final media checks passed ${new Date(workflow.updatedAt).toLocaleString()}`
                : workflow.state === "paused"
                  ? "Paused between stages"
                  : workflow.state === "blocked"
                    ? "Needs attention"
                    : {
                        shorts: "Waiting for all Shorts and other queued work to finish",
                        stories: "Discovering and reviewing complete stories",
                        closings: "Checking final media and closing cards",
                        complete: "Complete",
                      }[workflow.phase]}
            </strong>
          </output>
          {workflow.error && (
            <p role="alert">
              {studioMessage(workflow.error)} Use the recording's recovery controls to resolve a
              failure, then resume this workflow. It never retries a failed paid request
              automatically.
            </p>
          )}
          {results.length > 0 && (
            <p>
              {results.reduce((n, m) => n + (m.shorts ?? 0), 0)} Shorts ·{" "}
              {results.reduce((n, m) => n + (m.stories ?? 0), 0)} longer stories ·{" "}
              {results.filter((m) => m.noSuitableStory).length} recordings with no suitable longer
              story · {results.filter((m) => m.completedRevision).length} recordings verified
            </p>
          )}
          {results.some((m) => m.exclusions?.length) && (
            <details>
              <summary>Reviewed exclusions and source coverage</summary>
              <ul>
                {Object.entries(workflow.members).map(([id, member]) => (
                  <li key={id}>
                    {Object.keys(plan.items).find((child) => plan.items[child]?.packageId === id)
                      ? `Recording ${workflow.sourceIds.indexOf(Object.keys(plan.items).find((child) => plan.items[child]?.packageId === id) ?? "") + 1}`
                      : "Recording"}
                    : {member.stories ?? 0} stories
                    {member.noSuitableStory ? " · No suitable complete story found" : ""}
                    <ul>
                      {[...new Set(member.exclusions ?? [])].map((reason) => (
                        <li key={`${id}-${reason}`}>{reason}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {canCurate && workflow.state !== "complete" && (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => void action(workflow.state === "running" ? "pause" : "resume")}
            >
              {workflow.state === "running" ? "Pause after current work" : "Resume series workflow"}
            </button>
          )}
          {canCurate &&
            (workflow.state === "complete" ||
              (workflow.state === "blocked" &&
                ["STUDIO_SERIES_CONTENT_CHANGED", "STUDIO_SERIES_MEMBERS_CHANGED"].includes(
                  workflow.error ?? "",
                ))) && (
              <div>
                <label>
                  <input
                    type="checkbox"
                    checked={rebaseConfirmed}
                    onChange={(event) => setRebaseConfirmed(event.target.checked)}
                  />{" "}
                  I reviewed the current drafts and want to use them as the new preservation
                  baseline. The previous workflow history will remain saved.
                </label>
                <button
                  type="button"
                  className="button"
                  disabled={busy || !rebaseConfirmed}
                  onClick={() => void action("rebase")}
                >
                  Use current drafts and run checks
                </button>
              </div>
            )}
          <details>
            <summary>Workflow history</summary>
            <ol>
              {workflow.history.map((entry, index) => (
                <li key={`${entry.at}-${index}`}>
                  {entry.action} · {new Date(entry.at).toLocaleString()}
                </li>
              ))}
            </ol>
          </details>
        </>
      ) : canCurate ? (
        <>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />{" "}
            Continue this series through complete-story discovery and final media checks using its
            saved permissions and settings.
          </label>
          <button
            type="button"
            className="button primary"
            disabled={busy || !confirmed}
            onClick={() => void action("start")}
          >
            Complete this series automatically
          </button>
        </>
      ) : (
        <p>The Content Curator can enable the complete series workflow here.</p>
      )}
    </section>
  );
}
