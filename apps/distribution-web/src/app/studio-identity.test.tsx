// @vitest-environment jsdom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("../lib/runtime", () => ({ access: async () => ({ ok: false }) }));
vi.mock("./hub-locale", () => ({
  HubLocaleProvider: ({ children }: { children: React.ReactNode }) => children,
}));
import RootLayout, { generateMetadata } from "./layout";
import Login from "./login/page";

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubEnv("DISTRIBUTION_APP_ORIGIN", "http://localhost:3070");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each([
  ["gbadpt", "Guru Bhavana", "sri-bala-swamiji-portrait.jpg", "sgsswamiji-channel-avatar.jpg"],
  ["dp", "Datta Peetham", "sgsswamiji-channel-avatar.jpg", "sri-bala-swamiji-portrait.jpg"],
])(
  "keeps %s branding consistent across navigation, sign-in and browser metadata",
  async (id, organization, ownLogo, otherLogo) => {
    vi.stubEnv("STUDIO_IDENTITY", id);
    const markup = renderToStaticMarkup(await RootLayout({ children: "Workspace" }));
    const login = renderToStaticMarkup(await Login({ searchParams: Promise.resolve({}) }));
    expect(markup).toContain("Datta Media Studio");
    expect(markup).toContain(organization);
    expect(markup).toContain(ownLogo);
    expect(markup).not.toContain(otherLogo);
    expect(markup).not.toContain("Datta Content Studio");
    expect(login).toContain("Sign in to Datta Media Studio");
    expect(login).toContain(organization);
    expect(generateMetadata()).toMatchObject({
      title: `Datta Media Studio · ${organization}`,
      icons: { icon: `/distribution/brand/${ownLogo}` },
    });
  },
);
