import { verifyStudioMediaToken } from "@satsang/distribution-assets";
import { studioPublicationMatchesFile } from "@satsang/distribution-domain";
import { distributionHubPolicyEnabled } from "../../../../../../lib/auth";
import { json, singleRange } from "../../../../../../lib/http";
import { privateAssets } from "../../../../../../lib/runtime";
import { studioRepository } from "../../../../../../lib/studio-runtime";

export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (
      process.env.DISTRIBUTION_HUB_ENABLED !== "true" ||
      !["ON", "LIMITED"].includes(process.env.DISTRIBUTION_HUB_STAGE ?? "") ||
      process.env.STUDIO_PUBLISHING_ENABLED !== "true"
    )
      return json({ error: "NOT_FOUND" }, 404);
    const token = new URL(request.url).searchParams.get("token") ?? "";
    const secret = process.env.STUDIO_MEDIA_SIGNING_SECRET ?? "";
    const claims = verifyStudioMediaToken(token, secret);
    if (!claims || claims.publicationId !== id) return json({ error: "NOT_FOUND" }, 404);
    if (!(await distributionHubPolicyEnabled())) return json({ error: "NOT_FOUND" }, 404);
    const repo = studioRepository();
    const initial = await repo.publicationMedia(id);
    const matches = (result: typeof initial) =>
      result.package.isTest === false &&
      result.publication.isTest === false &&
      result.publication.id === id &&
      result.publication.packageId === claims.packageId &&
      result.publication.packageRevision === claims.revision &&
      result.publication.outputId === claims.outputId &&
      result.package.id === claims.packageId &&
      studioPublicationMatchesFile(result.package, result.output, result.publication) &&
      result.output.id === claims.outputId &&
      result.output.asset?.sha256 === claims.sha256;
    const asset = initial.output.asset;
    if (!asset || !matches(initial)) return json({ error: "NOT_FOUND" }, 404);
    const bytes = await privateAssets({ isTest: false }).readDerivedDescriptor(asset);
    const current = await repo.publicationMedia(id);
    if (
      !(await distributionHubPolicyEnabled()) ||
      !matches(current) ||
      !verifyStudioMediaToken(token, secret) ||
      bytes.length !== asset.byteSize ||
      current.output.asset?.storageKey !== asset.storageKey ||
      current.output.asset?.filename !== asset.filename ||
      current.output.asset?.mimeType !== asset.mimeType ||
      current.output.asset?.byteSize !== asset.byteSize
    )
      return json({ error: "NOT_FOUND" }, 404);
    const headers = {
      "Content-Type": asset.mimeType,
      "Content-Disposition": `inline; filename="${asset.filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
      "Referrer-Policy": "no-referrer",
    };
    const range = singleRange(request.headers.get("range"), bytes.length);
    if (range === "invalid")
      return new Response(null, {
        status: 416,
        headers: { ...headers, "Content-Range": `bytes */${bytes.length}` },
      });
    if (range)
      return new Response(new Uint8Array(bytes.subarray(range.start, range.end + 1)), {
        status: 206,
        headers: {
          ...headers,
          "Content-Length": String(range.end - range.start + 1),
          "Content-Range": `bytes ${range.start}-${range.end}/${bytes.length}`,
        },
      });
    return new Response(new Uint8Array(bytes), {
      headers: { ...headers, "Content-Length": String(bytes.length) },
    });
  } catch {
    return json({ error: "NOT_FOUND" }, 404);
  }
}
