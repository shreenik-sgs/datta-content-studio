import { STUDIO_STORY_MAX_DURATION_MS } from "@satsang/distribution-domain";

/** Portrait composition on a fractional CPU can be much slower than playback.
 * Bound total runtime by source duration while a separate watchdog detects stalls.
 * This changes no framing, captions, encoding quality or content-review gates.
 */
export function studioRenderBudget(durationMs: number) {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw Error("RENDER_DURATION_LIMIT");
  return {
    // Apply the existing 30x encoding allowance to supported complete stories too.
    // A fixed one-hour ceiling killed advancing long renders before they finished.
    timeoutMs: Math.min(STUDIO_STORY_MAX_DURATION_MS * 30, Math.max(600000, durationMs * 30)),
    progressTimeoutMs: 300000,
  };
}
