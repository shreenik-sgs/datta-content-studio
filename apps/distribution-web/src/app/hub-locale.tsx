"use client";

import { type ReactNode, createContext, useContext, useMemo } from "react";

export type HubLocale = {
  locale: string;
  timezone: string;
  timezoneSource: "profile" | "fallback";
};
const DEFAULT_LOCALE: HubLocale = { locale: "en", timezone: "UTC", timezoneSource: "fallback" };
const HubLocaleContext = createContext<HubLocale>(DEFAULT_LOCALE);

/** Core supplies the profile timezone. Browser and server defaults never decide
 * which calendar day an operator sees; older core contracts explicitly use UTC. */
export function HubLocaleProvider({
  locale,
  timezone,
  children,
}: { locale: string; timezone?: string | undefined; children: ReactNode }) {
  const value = useMemo<HubLocale>(
    () => ({
      locale,
      timezone: timezone ?? "UTC",
      timezoneSource: timezone ? "profile" : "fallback",
    }),
    [locale, timezone],
  );
  return <HubLocaleContext.Provider value={value}>{children}</HubLocaleContext.Provider>;
}

export function useHubLocale(): HubLocale {
  return useContext(HubLocaleContext);
}

/** Explicit locale and zone produce the same timestamp during SSR and hydration. */
export function useHubTimestamp(): (value: string) => string {
  const { locale, timezone } = useHubLocale();
  return useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "medium",
      timeZone: timezone,
    });
    return (value: string) => {
      const timestamp = new Date(value);
      return Number.isFinite(timestamp.getTime())
        ? formatter.format(timestamp)
        : "Time unavailable";
    };
  }, [locale, timezone]);
}
