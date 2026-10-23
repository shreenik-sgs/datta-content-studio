import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { trustedDistributionOrigin } from "../../lib/auth";
import { access } from "../../lib/runtime";
import { ReviewerLanguages } from "./reviewer-languages";
import { CurationSettings } from "./settings-panel";
export const dynamic = "force-dynamic";
export default async function Settings() {
  const auth = await access(
    new Request(
      `${trustedDistributionOrigin(process.env.DISTRIBUTION_APP_ORIGIN) ?? "http://localhost"}/distribution/settings`,
      { headers: await headers() },
    ),
    "operations.manage",
  );
  if (!auth.ok) notFound();
  return (
    <main className="shell studio-settings-page">
      <a className="studio-back-link" href="/distribution">
        ← Back to workspace
      </a>
      <header className="studio-page-intro">
        <p className="eyebrow">Administration</p>
        <h1>Curation &amp; Publishing</h1>
        <p>Manage generation defaults, connected accounts and media delivery.</p>
      </header>
      <ReviewerLanguages />
      <CurationSettings />
    </main>
  );
}
