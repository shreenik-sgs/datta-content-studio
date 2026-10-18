import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { trustedDistributionOrigin } from "../../lib/auth";
import { access } from "../../lib/runtime";
import { LiveCurationPanel } from "./panel";
import "./live.css";
export const dynamic = "force-dynamic";
export default async function LiveCurationPage() {
  const auth = await access(
    new Request(
      `${trustedDistributionOrigin(process.env.DISTRIBUTION_APP_ORIGIN) ?? "http://localhost"}/distribution/live`,
      { headers: await headers() },
    ),
  );
  if (!auth.ok) notFound();
  return (
    <main className="shell live-curation">
      <a href="/distribution?view=studio">Back to curation</a>
      <LiveCurationPanel capabilities={auth.capabilities} />
    </main>
  );
}
