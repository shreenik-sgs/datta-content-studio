import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { trustedDistributionOrigin } from "../../lib/auth";
import { access } from "../../lib/runtime";
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
    <main className="shell">
      <a href="/distribution">Back to workspace</a>
      <h1>Curation &amp; Publishing</h1>
      <CurationSettings />
    </main>
  );
}
