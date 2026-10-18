import { distributionText } from "@satsang/distribution-contracts";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { analyticsEnabled } from "../lib/analytics-policy";
import { trustedDistributionOrigin } from "../lib/auth";
import { access } from "../lib/runtime";
import { ContentLibrary } from "./content-library";

export const dynamic = "force-dynamic";

export default async function DistributionHome({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; master?: string; package?: string }>;
}) {
  const query = await searchParams;
  const requestedView = query.view;
  const origin = trustedDistributionOrigin(process.env.DISTRIBUTION_APP_ORIGIN);
  const auth = await access(
    new Request(`${origin ?? "http://localhost"}/distribution`, {
      headers: await headers(),
    }),
  );
  if (!auth.ok) {
    if (auth.response.status === 404) notFound();
    return (
      <main className="shell">
        <header className="topbar">
          <div>
            <p className="eyebrow">Datta Content Studio</p>
            <h1>{distributionText("en", "hub")}</h1>
          </div>
        </header>
        <section className="empty">
          <h2>
            {distributionText("en", auth.response.status === 401 ? "signIn" : "accessDenied")}
          </h2>
          {auth.response.status === 401 && (
            <a className="button primary" href="/distribution/login">
              {distributionText("en", "signIn")}
            </a>
          )}
        </section>
      </main>
    );
  }
  return (
    <ContentLibrary
      initialMasterId={
        query.master && /^[a-f0-9-]{36}$/.test(query.master) ? query.master : undefined
      }
      initialStudioPackageId={
        query.package && /^[a-f0-9-]{36}$/.test(query.package) ? query.package : undefined
      }
      {...(requestedView === "content" || requestedView === "studio" || requestedView === "complete"
        ? { initialView: requestedView }
        : {})}
      locale={auth.identity.locale}
      displayName={auth.identity.displayName}
      capabilities={auth.capabilities}
      analyticsEnabled={
        auth.capabilities.includes("analytics.view") &&
        (await analyticsEnabled(
          new Request(`${origin ?? "http://localhost"}/distribution`, { headers: await headers() }),
        ))
      }
      stage={process.env.DISTRIBUTION_HUB_STAGE ?? "OFF"}
    />
  );
}
