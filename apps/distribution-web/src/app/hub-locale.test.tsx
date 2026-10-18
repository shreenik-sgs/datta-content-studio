import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HubLocaleProvider, useHubLocale, useHubTimestamp } from "./hub-locale";

function Timestamp({ value = "2026-10-10T23:30:00.000Z" }: { value?: string }) {
  const format = useHubTimestamp();
  const { timezone, timezoneSource } = useHubLocale();
  return (
    <time data-timezone={timezone} data-source={timezoneSource}>
      {format(value)}
    </time>
  );
}

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => vi.unstubAllGlobals());

describe("Hub profile timezone", () => {
  it("shows the next calendar day in the devotee's profile timezone during the initial server render", () => {
    const html = renderToStaticMarkup(
      <HubLocaleProvider locale="en" timezone="Asia/Kolkata">
        <Timestamp />
      </HubLocaleProvider>,
    );
    expect(html).toContain('data-timezone="Asia/Kolkata"');
    expect(html).toContain('data-source="profile"');
    expect(html).toContain("Oct 11, 2026");
    expect(html).toContain("5:00:00 AM");
  });
  it("uses the saved western timezone rather than a browser or server default", () => {
    const html = renderToStaticMarkup(
      <HubLocaleProvider locale="en" timezone="America/Los_Angeles">
        <Timestamp value="2026-10-10T01:30:00.000Z" />
      </HubLocaleProvider>,
    );
    expect(html).toContain("Oct 9, 2026");
    expect(html).toContain("6:30:00 PM");
  });
  it("uses an explicit UTC fallback for older core contracts with no profile timezone", () => {
    const html = renderToStaticMarkup(
      <HubLocaleProvider locale="en">
        <Timestamp />
      </HubLocaleProvider>,
    );
    expect(html).toContain('data-timezone="UTC"');
    expect(html).toContain('data-source="fallback"');
    expect(html).toContain("Oct 10, 2026");
    expect(html).toContain("11:30:00 PM");
  });
  it("handles unavailable timestamps without inventing a time", () => {
    expect(renderToStaticMarkup(<Timestamp value="invalid" />)).toContain("Time unavailable");
  });
});
