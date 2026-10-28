import { describe, expect, it } from "vitest";
import {
  STUDIO_PROVIDER_ERROR_DETAIL_MAX,
  studioProviderErrorDetail,
} from "./studio-provider-errors";

describe("studioProviderErrorDetail", () => {
  it("keeps the provider's message as one trimmed line", () => {
    expect(
      studioProviderErrorDetail({
        message: " The user has exceeded the number of videos\r\n they may upload. ",
      }),
    ).toBe("The user has exceeded the number of videos they may upload.");
    expect(studioProviderErrorDetail("Channel is locked.")).toBe("Channel is locked.");
  });
  it("falls back to the raw error only when there is no message", () => {
    expect(studioProviderErrorDetail({ rawError: "uploadLimitExceeded" })).toBe(
      "uploadLimitExceeded",
    );
    expect(studioProviderErrorDetail({ message: "quota", rawError: "ignored" })).toBe("quota");
  });
  it("returns null for nothing useful", () => {
    for (const value of [null, undefined, "", "   ", 7, {}, { message: 3 }, []])
      expect(studioProviderErrorDetail(value)).toBeNull();
  });
  it("never stores token-like strings and caps the length", () => {
    expect(studioProviderErrorDetail(`Bearer ${"a".repeat(48)} rejected`)).toBe(
      "[redacted] rejected",
    );
    const long = studioProviderErrorDetail("quota exceeded ".repeat(200));
    expect(long?.length).toBe(STUDIO_PROVIDER_ERROR_DETAIL_MAX);
    expect(long?.endsWith("\u2026")).toBe(true);
  });
});
