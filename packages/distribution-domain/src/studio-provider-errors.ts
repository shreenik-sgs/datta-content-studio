/** Longest channel reason Studio keeps; providers can return whole response bodies. */
export const STUDIO_PROVIDER_ERROR_DETAIL_MAX = 400;
/**
 * Reduce a provider's error report (Buffer `PostPublishingError`, a `MutationError`
 * message, or a bare string) to one line of plain text safe to store and show.
 * Control characters, surrounding whitespace and anything that looks like a bearer
 * token or key are dropped; nothing else is interpreted.
 */
export function studioProviderErrorDetail(value: unknown): string | null {
  const text =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? typeof (value as { message?: unknown }).message === "string"
          ? (value as { message: string }).message
          : typeof (value as { rawError?: unknown }).rawError === "string"
            ? (value as { rawError: string }).rawError
            : ""
        : "";
  const line = Array.from(text, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029
      ? " "
      : ch;
  })
    .join("")
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{40,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (!line) return null;
  return line.length > STUDIO_PROVIDER_ERROR_DETAIL_MAX
    ? `${line.slice(0, STUDIO_PROVIDER_ERROR_DETAIL_MAX - 1)}\u2026`
    : line;
}
