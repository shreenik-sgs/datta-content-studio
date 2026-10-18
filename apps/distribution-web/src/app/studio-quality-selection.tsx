import type { StudioExcludedMessage } from "@satsang/distribution-domain";

export function StudioQualitySelection({
  messages,
}: { messages?: StudioExcludedMessage[] | undefined }) {
  if (!messages?.length) return null;
  return (
    <details className="notice" style={{ display: "block" }}>
      <summary>Why {messages.length} proposed message(s) were excluded</summary>
      <p>
        These proposals did not pass AI review after correction attempts. Only the messages that
        passed are included below. They still need human approval before publication.
      </p>
      <ul>
        {messages.map((message) => (
          <li key={message.messageId}>
            <strong>{message.title}</strong>
            {message.reasons.map((reason, index) => (
              <p key={`${message.messageId}-${index}`}>{reason}</p>
            ))}
          </li>
        ))}
      </ul>
    </details>
  );
}
