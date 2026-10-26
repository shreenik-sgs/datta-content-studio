import { DISTRIBUTION_LANGUAGE_NAMES } from "@satsang/distribution-contracts";
import {
  type StudioGenerationProgress,
  studioChannelLabel,
  studioContentReviewIssues,
  studioNeedsSuitabilityReview,
  studioOutputKey,
} from "@satsang/distribution-domain";
import { studioMessage } from "../lib/studio-model";

const phases = {
  source: "Checking the recording",
  transcription: "Transcribing the recording",
  drafting: "Drafting and translating channel content",
  reviewing: "AI review of meaning, video, audio and subtitles",
  rendering: "Creating branded files and subtitles",
  complete: "Files are ready for review",
};
export function StudioGenerationProgressView({
  value,
  status,
  formatTimestamp,
}: {
  value: StudioGenerationProgress;
  status: string;
  formatTimestamp: (value: string) => string;
}) {
  const waiting = status === "QUEUED" || (status === "GENERATING" && Boolean(value.retryAt));
  const discovering = Boolean(value.discoverySection && value.discoverySections);
  const issues = value.reviewIssues?.filter((issue) => studioContentReviewIssues([issue]).length);
  if (studioNeedsSuitabilityReview(value.errorCode))
    return (
      <section className="notice" style={{ display: "block" }} aria-label="Source suitability">
        <strong>No suitable excerpt found</strong>
        <p>{studioMessage(value.errorCode as string)}</p>
        {value.excludedChannels?.length ? (
          <ul>
            {value.excludedChannels.map((item) => (
              <li key={item.channel}>
                <strong>{studioChannelLabel(item.channel)}:</strong> {item.reason}
              </li>
            ))}
          </ul>
        ) : null}
        <p>The source is saved. Other recordings in this bundle continue normally.</p>
      </section>
    );
  return (
    <section
      className="notice"
      style={{ display: "block" }}
      aria-label="Generation progress"
      aria-live="polite"
    >
      <strong>
        {value.errorCode ? (waiting ? "Waiting to resume: " : "Stopped during: ") : ""}
        {phases[value.phase]}
      </strong>
      <p>
        {value.provider === "local"
          ? "Media processing"
          : value.provider === "sarvam"
            ? "Sarvam"
            : value.provider === "gemini"
              ? "Gemini"
              : "OpenAI"}
        {value.language ? ` · ${DISTRIBUTION_LANGUAGE_NAMES[value.language]}` : ""}
        {value.channel ? ` · ${studioChannelLabel(value.channel)}` : ""}
      </p>
      {value.discoverySection && value.discoverySections ? (
        <p>
          Reviewing section {value.discoverySection} of {value.discoverySections}. Completed
          sections are saved for resuming.
        </p>
      ) : null}
      <progress
        style={{ width: "100%", maxWidth: 480 }}
        aria-label={
          discovering
            ? "Sections before the current discovery section"
            : "Completed work in this stage"
        }
        max={Math.max(1, discovering ? (value.discoverySections ?? 1) : value.total)}
        value={discovering ? Math.max(0, (value.discoverySection ?? 1) - 1) : value.completed}
      />
      {discovering ? (
        <p>
          Teaching discovery comes before video rendering. Files appear after rendering and quality
          checks.
        </p>
      ) : (
        <p>
          {value.completed} of {value.total}{" "}
          {value.phase === "drafting"
            ? "drafting groups"
            : value.phase === "rendering"
              ? "files"
              : "steps"}{" "}
          complete.
        </p>
      )}
      {waiting && value.retryAt ? (
        <p>
          Waiting for the service. Retry scheduled for {formatTimestamp(value.retryAt)}. Completed
          work is saved; you can leave this page.
        </p>
      ) : null}
      {value.errorCode ? <p>{studioMessage(value.errorCode)}</p> : null}
      {value.presentationIssues?.length ? (
        <ul>
          {value.presentationIssues.map((issue, index) => (
            <li key={`${index}-${issue}`}>{issue}</li>
          ))}
        </ul>
      ) : null}
      {issues?.length ? (
        <ul>
          {issues.map((issue) => (
            <li key={studioOutputKey(issue)}>
              <strong>
                {issue.channel} / {issue.language}:
              </strong>{" "}
              {issue.reason}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
