import { computerRecoveryEnabled } from "@satsang/distribution-domain";
import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { trustedDistributionOrigin } from "../lib/auth";
import { access } from "../lib/runtime";
import { STUDIO_PRODUCT_NAME, studioIdentity } from "../lib/studio-identity";
import { HubLocaleProvider } from "./hub-locale";
import "./globals.css";
import "./studio-experience.css";
export function generateMetadata(): Metadata {
  const identity = studioIdentity();
  return {
    title: identity.organization
      ? `${STUDIO_PRODUCT_NAME} · ${identity.organization}`
      : STUDIO_PRODUCT_NAME,
    description: "Curate, review and publish Sri Swamiji’s teachings.",
    ...(identity.logo ? { icons: { icon: identity.logo, apple: identity.logo } } : {}),
  };
}
export default async function RootLayout({ children }: { children: ReactNode }) {
  const identity = studioIdentity();
  const origin =
    trustedDistributionOrigin(process.env.DISTRIBUTION_APP_ORIGIN) ?? "http://localhost";
  const auth = await access(new Request(`${origin}/distribution`, { headers: await headers() }));
  const roles = auth.ok
    ? [
        auth.capabilities.includes("content.create") ? "Curator" : null,
        auth.capabilities.includes("content.review") ? "Approver" : null,
        auth.capabilities.includes("operations.manage") ? "Admin" : null,
      ].filter(Boolean)
    : [];
  return (
    <html lang={auth.ok ? auth.identity.locale : "en"}>
      <body>
        <HubLocaleProvider locale={auth.ok ? auth.identity.locale : "en"}>
          <nav className="topbar shell studio-topbar" aria-label="Main navigation">
            <a className="brand" href="/distribution">
              {identity.logo && (
                <img src={identity.logo} width="48" height="48" alt={identity.logoAlt} />
              )}
              <span className="studio-brand-copy">
                <span>{STUDIO_PRODUCT_NAME}</span>
                {identity.organization && <small>{identity.organization}</small>}
              </span>
            </a>
            {auth.ok && (
              <div className="studio-topbar-controls">
                <span className="studio-role" aria-label="Your roles">
                  {roles.join(" · ") || "Studio member"}
                </span>
                {auth.identity.isTest && (
                  <span className="studio-world" title="Posting is simulated in this workspace.">
                    Test workspace
                  </span>
                )}
                <a className="button quiet" href="/distribution">
                  Workspace
                </a>
                {auth.capabilities.includes("content.create") &&
                  computerRecoveryEnabled(process.env) && (
                    <a className="button quiet" href="/distribution/recover">
                      Recover staging playlist
                    </a>
                  )}
                {auth.capabilities.includes("operations.manage") && (
                  <a className="button quiet" href="/distribution/settings">
                    Settings
                  </a>
                )}
                <form method="post" action="/distribution/api/auth/logout">
                  <button className="button quiet" type="submit">
                    Sign out
                  </button>
                </form>
              </div>
            )}
          </nav>
          {children}
        </HubLocaleProvider>
      </body>
    </html>
  );
}
