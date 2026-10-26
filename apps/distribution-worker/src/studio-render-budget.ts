/** Portrait composition on a fractional CPU can be much slower than playback.
 * Bound total runtime by source duration while a separate watchdog detects stalls.
 * This changes no framing, captions, encoding quality or content-review gates.
 */
export function studioRenderBudget(durationMs: number) {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw Error("RENDER_DURATION_LIMIT");
  return {
    timeoutMs: Math.min(3600000, Math.max(600000, durationMs * 30)),
    progressTimeoutMs: 300000,
  };
}
