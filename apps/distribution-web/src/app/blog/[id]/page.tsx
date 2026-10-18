import { STUDIO_BRAND_NAME, STUDIO_BRAND_SIGNATURE } from "@satsang/distribution-domain";
import { notFound } from "next/navigation";
import { distributionHubPolicyEnabled } from "../../../lib/auth";
import { studioRepository } from "../../../lib/studio-runtime";

export const dynamic = "force-dynamic";
export default async function PublishedStudioBlog({ params }: { params: Promise<{ id: string }> }) {
  if (
    process.env.DISTRIBUTION_HUB_ENABLED !== "true" ||
    !["ON", "LIMITED"].includes(process.env.DISTRIBUTION_HUB_STAGE ?? "") ||
    process.env.STUDIO_PUBLISHING_ENABLED !== "true"
  )
    notFound();
  if (!(await distributionHubPolicyEnabled())) notFound();
  const { id } = await params;
  const result = await studioRepository()
    .publishedBlog(id)
    .catch(() => null);
  if (
    !result ||
    result.package.isTest ||
    result.publication.isTest ||
    result.publication.status !== "PUBLISHED" ||
    result.publication.channel !== "website" ||
    result.output.format !== "blog" ||
    !result.output.included ||
    result.publication.packageId !== result.package.id ||
    result.publication.packageRevision !== result.package.revision ||
    result.publication.outputId !== result.output.id
  )
    notFound();
  return (
    <main className="shell" lang={result.output.language}>
      <header className="topbar">
        <a className="brand" href="https://www.youtube.com/@sgsswamiji">
          <img
            src="/distribution/brand/sgsswamiji-channel-avatar.jpg"
            width="48"
            height="48"
            alt=""
          />
          <span>{STUDIO_BRAND_SIGNATURE}</span>
        </a>
      </header>
      <article className="panel" style={{ maxWidth: 850, margin: "36px auto", padding: 32 }}>
        <p className="eyebrow">{STUDIO_BRAND_NAME}</p>
        <h1>{result.output.title}</h1>
        {result.output.body.split(/\n\s*\n/).map((paragraph, index) => (
          <p
            key={`${index}-${paragraph.slice(0, 12)}`}
            style={{ lineHeight: 1.8, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
          >
            {paragraph}
          </p>
        ))}
      </article>
    </main>
  );
}
