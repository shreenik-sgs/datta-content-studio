"use client";

import { DISTRIBUTION_LANGUAGE_NAMES } from "@satsang/distribution-contracts";
import { STUDIO_CHANNELS, studioChannelLabel } from "@satsang/distribution-domain";
import { useId, useState } from "react";
import { studioLatestReview, studioOutputLength, studioOutputState } from "../lib/studio-lineage";
import type { PublicStudioPackage, PublicStudioPublication } from "../lib/studio-model";
import { useHubLocale, useHubTimestamp } from "./hub-locale";
import "./studio-lineage.css";

function LocalTime({ value }: { value: string }) {
  const formatTimestamp = useHubTimestamp();
  const { timezone, timezoneSource } = useHubLocale();
  return (
    <time
      dateTime={value}
      title={
        timezoneSource === "profile"
          ? `Profile timezone: ${timezone}`
          : "UTC — profile timezone unavailable"
      }
    >
      {formatTimestamp(value)}
    </time>
  );
}

export function StudioLineage({
  value,
  publications,
  onPreview,
}: {
  value: PublicStudioPackage;
  publications: PublicStudioPublication[];
  onPreview: (outputId: string) => void;
}) {
  const headingId = useId();
  const helpId = useId();
  const latestReview = studioLatestReview(value);
  const [channel, setChannel] = useState("all");
  const [language, setLanguage] = useState("all");
  const shown = value.outputs.filter(
    (output) =>
      (channel === "all" || output.channel === channel) &&
      (language === "all" || output.language === language),
  );
  const groups = STUDIO_CHANNELS.map((channel) => ({
    channel,
    outputs: value.outputs.filter((output) => output.channel === channel),
  })).filter((group) => group.outputs.length > 0);
  const included = value.outputs.filter((output) => output.included).length;
  return (
    <section className="studio-lineage" aria-labelledby={headingId}>
      <div className="lineage-heading">
        <div>
          <p className="eyebrow">Source and derived content</p>
          <h3 id={headingId}>One master, every channel output</h3>
        </div>
        <span className="badge">
          {value.outputs.length} outputs · {groups.length} channels
        </span>
      </div>
      {["QUEUED", "GENERATING"].includes(value.status) && value.outputs.length > 0 && (
        <output className="lineage-help">
          Showing previous versions while replacements are generated and checked. This table updates
          when the selected set is ready.
        </output>
      )}
      <div className="lineage-map">
        <div className="lineage-master">
          <span className="lineage-master-mark" aria-hidden="true">
            SGS
          </span>
          <div>
            <p className="eyebrow">Master recording</p>
            <strong>{value.source.title}</strong>
            <details className="lineage-identity">
              <summary>Source identifiers</summary>
              <p>Master {value.source.masterId}</p>
              <p>Source version {value.source.versionId}</p>
            </details>
          </div>
        </div>
        <div className="lineage-connector" aria-hidden="true">
          <span />↓<span />
        </div>
        <p className="lineage-summary">
          {included} included · {value.outputs.length - included} excluded
        </p>
        <ul className="lineage-branches" aria-label="Channels derived from this master">
          {groups.map(({ channel, outputs }) => (
            <li key={channel}>
              <button
                type="button"
                onClick={() => setChannel(channel)}
                aria-label={`Show ${studioChannelLabel(channel)} files`}
              >
                <strong>{studioChannelLabel(channel)}</strong>
                <span>{outputs.length} files</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <p className="lineage-help" id={helpId}>
        Select a channel to narrow the list, then a filename to preview it. Approval applies to all
        included files, including files hidden by these filters.
      </p>
      <div className="lineage-filters">
        <label>
          Channel
          <select
            aria-label="Filter by channel"
            value={channel}
            onChange={(event) => setChannel(event.target.value)}
          >
            <option value="all">All channels</option>
            {groups.map((group) => (
              <option key={group.channel} value={group.channel}>
                {studioChannelLabel(group.channel)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Language
          <select
            aria-label="Filter by language"
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
          >
            <option value="all">All languages</option>
            {[...new Set(value.outputs.map((output) => output.language))].map((item) => (
              <option key={item} value={item}>
                {DISTRIBUTION_LANGUAGE_NAMES[item]}
              </option>
            ))}
          </select>
        </label>
        <output>
          {shown.length} of {value.outputs.length} files
        </output>
      </div>
      <section
        className="lineage-table-scroll"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: A labeled scroll region must be keyboard-scrollable.
        tabIndex={0}
        aria-label="Derived content table"
        aria-describedby={helpId}
      >
        <table className="lineage-table">
          <caption>Derived files for {value.source.title}</caption>
          <thead>
            <tr>
              <th scope="col">Filename</th>
              <th scope="col">Channel</th>
              <th scope="col">Type / language</th>
              <th scope="col">Length</th>
              <th scope="col">File &amp; time</th>
              <th scope="col">Lifecycle status</th>
              <th scope="col">Review comments</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((output) => {
              const length = studioOutputLength(output);
              const status = studioOutputState(value, output, publications);
              return (
                <tr key={output.id} data-included={output.included}>
                  <th scope="row" className="lineage-file">
                    <button
                      type="button"
                      onClick={(event) => {
                        // Safari does not focus a button on pointer activation. Keep the return target explicit.
                        event.currentTarget.focus({ preventScroll: true });
                        onPreview(output.id);
                      }}
                      aria-label={`Preview ${output.asset?.filename ?? output.title}`}
                    >
                      {output.asset?.filename ?? output.title}
                    </button>
                    <small>{output.asset ? output.title : "File needs generation"}</small>
                    {output.captions.length > 0 && (
                      <small>
                        CC:{" "}
                        {output.captions
                          .map((caption) => DISTRIBUTION_LANGUAGE_NAMES[caption.language])
                          .join(" · ")}
                      </small>
                    )}
                  </th>
                  <td>{studioChannelLabel(output.channel)}</td>
                  <td>
                    <strong className="lineage-format">{output.format}</strong>
                    <small>{DISTRIBUTION_LANGUAGE_NAMES[output.language]}</small>
                  </td>
                  <td>
                    {length.label}
                    <small>{length.detail}</small>
                  </td>
                  <td>
                    <strong>File version {output.fileVersion ?? 1}</strong>
                    <small>Generated</small>
                    {output.asset && value.provenance ? (
                      <LocalTime value={output.generatedAt ?? value.provenance.generatedAt} />
                    ) : (
                      "File needs generation"
                    )}
                    <small>Package updated</small>
                    <LocalTime value={value.updatedAt} />
                  </td>
                  <td>
                    <span className={`lineage-status lineage-status-${status.tone}`}>
                      {status.label}
                    </span>
                    <small>{status.detail}</small>
                  </td>
                  <td className="lineage-comment">
                    {output.correction ? (
                      <>
                        <details>
                          <summary>File review comments</summary>
                          <p>{output.correction.comment}</p>
                        </details>
                        <small>
                          {output.correction.state === "resolved"
                            ? "Correction approved"
                            : "File correction requested"}{" "}
                          · <LocalTime value={output.correction.requestedAt} />
                        </small>
                      </>
                    ) : latestReview?.action === "REJECTED" &&
                      value.outputs.some((o) => o.correction) ? (
                      <span className="muted">Not returned for correction</span>
                    ) : latestReview ? (
                      <>
                        <details>
                          <summary>View comments</summary>
                          <p>{latestReview.comment || "No additional comment."}</p>
                        </details>
                        <small>
                          {latestReview.action === "REJECTED"
                            ? "Changes requested"
                            : latestReview.action === "APPROVED"
                              ? "Approved"
                              : "Discarded"}{" "}
                          · <LocalTime value={latestReview.createdAt} />
                        </small>
                        <small>
                          Shared package feedback
                          {latestReview.revision !== value.revision ? " · earlier review" : ""}
                        </small>
                      </>
                    ) : (
                      <span className="muted">No Content Approver review yet</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </section>
  );
}
