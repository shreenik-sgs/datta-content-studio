"use client";

import { DISTRIBUTION_LANGUAGE_NAMES } from "@satsang/distribution-contracts";
import { studioChannelLabel } from "@satsang/distribution-domain";
import { useState } from "react";
import { studioOutputLength, studioOutputState } from "../lib/studio-lineage";
import { type PublicStudioPackage, STUDIO_STATUS_LABELS } from "../lib/studio-model";
import { useHubTimestamp } from "./hub-locale";
import "./studio-lineage.css";

export function PlaylistFiles({
  packages,
  onOpen,
  onPreview,
  totalRecordings,
}: {
  packages: readonly PublicStudioPackage[];
  totalRecordings?: number | undefined;
  onOpen: (value: PublicStudioPackage) => void;
  onPreview: (value: PublicStudioPackage, outputId: string) => void;
}) {
  const [channel, setChannel] = useState("all");
  const [search, setSearch] = useState("");
  const formatTimestamp = useHubTimestamp();
  const outputs = packages.flatMap((value) => value.outputs);
  const channels = [...new Set(outputs.map((output) => output.channel))];
  const groups = packages
    .map((value, index) => ({
      value,
      index,
      shown: value.outputs.filter(
        (output) =>
          (channel === "all" || output.channel === channel) &&
          `${value.source.title} ${output.title} ${output.asset?.filename ?? ""}`
            .toLocaleLowerCase()
            .includes(search.trim().toLocaleLowerCase()),
      ),
    }))
    .filter((group) => group.shown.length);
  const skipped = packages.filter(
    (value) =>
      !value.outputs.length && value.status === "DRAFT" && value.provenance?.skippedChannels.length,
  );
  const waiting = packages.filter((value) => !value.outputs.length && !skipped.includes(value));
  return (
    <section className="studio-lineage" aria-label="All bundle files">
      <h3>All bundle files</h3>
      <p>
        {outputs.length} files across {packages.length} recordings
        {channels
          .map(
            (name) =>
              ` · ${studioChannelLabel(name)}: ${outputs.filter((output) => output.channel === name).length}`,
          )
          .join("")}
      </p>
      {totalRecordings !== undefined && totalRecordings > packages.length && (
        <p>
          This bundle contains {totalRecordings} recordings. Another{" "}
          {totalRecordings - packages.length} are downloading or waiting to enter curation. Their
          files will appear here automatically.
        </p>
      )}
      <p>
        Preview any file below. Open a recording’s workflow for corrections, approval and publishing
        results.
      </p>
      <div className="lineage-filters">
        <label>
          Channel
          <select
            aria-label="Playlist file channel"
            value={channel}
            onChange={(event) => setChannel(event.target.value)}
          >
            <option value="all">All channels ({outputs.length})</option>
            {channels.map((name) => (
              <option key={name} value={name}>
                {studioChannelLabel(name)} (
                {outputs.filter((output) => output.channel === name).length})
              </option>
            ))}
          </select>
        </label>
        <label>
          Search files
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Title, filename or recording"
          />
        </label>
        <output>
          {groups.reduce((count, group) => count + group.shown.length, 0)} of {outputs.length} files
        </output>
      </div>
      <section
        className="lineage-table-scroll"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: A labeled scroll region must be keyboard-scrollable.
        tabIndex={0}
        aria-label="Playlist files table"
      >
        <table className="lineage-table playlist-files-table">
          <caption>Generated files from every recording in this bundle</caption>
          <thead>
            <tr>
              <th scope="col">Master recording</th>
              <th scope="col">File / preview</th>
              <th scope="col">Channel</th>
              <th scope="col">Type / language</th>
              <th scope="col">Length</th>
              <th scope="col">Version / generated</th>
              <th scope="col">Review status</th>
            </tr>
          </thead>
          {groups.map(({ value, index, shown }) => (
            <tbody key={value.id}>
              {shown.map((output, row) => {
                const status = studioOutputState(value, output, []);
                const generatedAt = output.generatedAt ?? value.provenance?.generatedAt;
                return (
                  <tr key={output.id} data-included={output.included}>
                    {row === 0 && (
                      <th scope="rowgroup" rowSpan={shown.length} className="playlist-file-master">
                        <span>
                          {index + 1}. {value.source.title}
                        </span>
                        <small>{value.outputs.length} files</small>
                        <button
                          className="button"
                          type="button"
                          onClick={() => onOpen(value)}
                          aria-label={`Open workflow for ${value.source.title}`}
                        >
                          Open workflow
                        </button>
                      </th>
                    )}
                    <th scope="row" className="lineage-file">
                      <button
                        type="button"
                        aria-label={`Preview ${output.asset?.filename ?? output.title}`}
                        onClick={(event) => {
                          event.currentTarget.focus({ preventScroll: true });
                          onPreview(value, output.id);
                        }}
                      >
                        {output.asset?.filename ?? output.title}
                      </button>
                      <small>{output.title}</small>
                    </th>
                    <td>{studioChannelLabel(output.channel)}</td>
                    <td>
                      {output.format}
                      <small>{DISTRIBUTION_LANGUAGE_NAMES[output.language]}</small>
                    </td>
                    <td>{studioOutputLength(output).label}</td>
                    <td>
                      v{output.fileVersion ?? 1}
                      {generatedAt && (
                        <small>
                          <time dateTime={generatedAt}>{formatTimestamp(generatedAt)}</time>
                        </small>
                      )}
                    </td>
                    <td>
                      <span className={`lineage-status lineage-status-${status.tone}`}>
                        {status.label}
                      </span>
                      {output.correction && <small>{output.correction.comment}</small>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </section>
      {!groups.length && (
        <p>
          {outputs.length
            ? "No files match these filters."
            : waiting.length
              ? "Files will appear here as generation finishes."
              : "No complete teaching was selected from these sections."}
        </p>
      )}
      {skipped.length > 0 && (
        <details>
          <summary>{skipped.length} sections checked — no complete teaching selected</summary>
          <ul>
            {skipped.map((value) => (
              <li key={value.id}>
                {value.source.title}:{" "}
                {value.provenance?.skippedChannels.map((skip) => skip.reason).join(" ")}
              </li>
            ))}
          </ul>
        </details>
      )}
      {waiting.length > 0 && (
        <details>
          <summary>{waiting.length} recordings still need generated files</summary>
          <ul>
            {waiting.map((value) => (
              <li key={value.id}>
                {value.source.title} · {STUDIO_STATUS_LABELS[value.status]}{" "}
                <button type="button" className="button" onClick={() => onOpen(value)}>
                  Open workflow
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
