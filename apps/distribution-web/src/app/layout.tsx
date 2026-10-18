import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { trustedDistributionOrigin } from "../lib/auth";
import { access } from "../lib/runtime";
import { HubLocaleProvider } from "./hub-locale";
import "./globals.css";
export const metadata: Metadata = {
  title: "Datta Content Studio",
  description: "Curate, review and publish Sri Swamiji’s teachings.",
};
export default async function RootLayout({ children }: { children: ReactNode }) {
  const origin =
    trustedDistributionOrigin(process.env.DISTRIBUTION_APP_ORIGIN) ?? "http://localhost";
  const auth = await access(new Request(`${origin}/distribution`, { headers: await headers() }));
  return (
    <html lang={auth.ok ? auth.identity.locale : "en"}>
      <body>
        <HubLocaleProvider locale={auth.ok ? auth.identity.locale : "en"}>
          <nav className="topbar shell" aria-label="Main navigation">
            <a className="brand" href="/distribution">
              <img
                src="/distribution/brand/sgsswamiji-channel-avatar.jpg"
                width="48"
                height="48"
                alt=""
              />
              <span>Datta Content Studio</span>
            </a>
            {auth.ok && (
              <div className="actions wrap">
                {auth.capabilities.includes("operations.manage") && (
                  <a className="button" href="/distribution/settings">
                    Settings
                  </a>
                )}
                <form method="post" action="/distribution/api/auth/logout">
                  <button className="button" type="submit">
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
