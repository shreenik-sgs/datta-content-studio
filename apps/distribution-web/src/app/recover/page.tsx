import { computerRecoveryEnabled } from "@satsang/distribution-domain";
import { headers } from "next/headers";
import { z } from "zod";
import { trustedDistributionOrigin } from "../../lib/auth";
import { access } from "../../lib/runtime";
import { ComputerRecovery } from "../computer-recovery";

export const dynamic = "force-dynamic";
export default async function Recover({
  searchParams,
}: { searchParams: Promise<{ bundle?: string }> }) {
  const result = z
    .string()
    .uuid()
    .safeParse((await searchParams).bundle);
  const bundle = result.success ? result.data : undefined;
  const returnTo = `/distribution/recover${bundle ? `?bundle=${bundle}` : ""}`;
  const origin = trustedDistributionOrigin(process.env.DISTRIBUTION_APP_ORIGIN);
  const auth = await access(
    new Request(`${origin ?? "http://localhost"}/distribution/recover`, {
      headers: await headers(),
    }),
    "content.create",
  );
  return (
    <main className="shell computer-recovery-page">
      <h1>Recover a staging playlist</h1>
      {!auth.ok ? (
        <section className="panel">
          <p>
            {auth.response.status === 401
              ? "Sign in to local Studio as a Curator to use this computer for recovery."
              : "This feature requires the Curator role in local Studio."}
          </p>
          <a
            className="button primary"
            href={`/distribution/login?returnTo=${encodeURIComponent(returnTo)}`}
          >
            Sign in to local Studio
          </a>
        </section>
      ) : !computerRecoveryEnabled(process.env) ? (
        <section className="panel">
          <p>
            Recovery runs in Studio on your computer. Open local Studio at localhost:3070. If you
            are already there, ask your Studio administrator to enable local recovery once.
          </p>
        </section>
      ) : (
        <ComputerRecovery initialBundle={bundle} />
      )}
    </main>
  );
}
