import { renderArtifactReviewSchema } from "@satsang/distribution-contracts";
import { buildDerivedAssetNames } from "@satsang/distribution-domain";
import { z } from "zod";
import { derivativeArchive } from "../../../../../lib/export";
import { boundedJson, json, safeProblem, singleRange } from "../../../../../lib/http";
import { requireNativeRenderPolicy } from "../../../../../lib/native-render-policy";
import {
  publicRenderArtifact,
  renderArtifactNaming,
  renderRepository,
  sameRenderArtifact,
} from "../../../../../lib/render-runtime";
import { access, privateAssets } from "../../../../../lib/runtime";

type Params = { params: Promise<{ id: string; action: string }> };
export async function POST(request: Request, { params }: Params) {
  const auth = await access(request, "content.review");
  if (!auth.ok) return auth.response;
  try {
    const { id, action } = await params;
    z.string().uuid().parse(id);
    if (action !== "review") return json({ error: "NOT_FOUND" }, 404);
    const command = renderArtifactReviewSchema.parse(await boundedJson(request));
    await requireNativeRenderPolicy(request, auth.context, { artifactId: id });
    const artifact = await renderRepository().reviewArtifact(auth.context, id, command);
    return json({ artifact: publicRenderArtifact(artifact) });
  } catch (error) {
    return safeProblem(error);
  }
}
export async function GET(request: Request, { params }: Params) {
  const { action } = await params;
  const required = action === "export" ? "content.publish" : undefined;
  const auth = await access(request, required);
  if (!auth.ok) return auth.response;
  try {
    const { id } = await params;
    z.string().uuid().parse(id);
    if (!["media", "captions", "export"].includes(action)) return json({ error: "NOT_FOUND" }, 404);
    if (action === "export")
      await requireNativeRenderPolicy(request, auth.context, { artifactId: id });
    const repo = renderRepository();
    const initial = await repo.getArtifact(auth.context, id);
    const { artifact } = initial;
    const previewAllowed =
      !initial.eligibility.allowed &&
      initial.eligibility.reason === "ARTIFACT_NOT_APPROVED" &&
      action !== "export";
    if (!initial.eligibility.allowed && !previewAllowed)
      throw new Error(initial.eligibility.reason);
    const checks = {
      expectedRevision: artifact.revision,
      expectedRecipeSha256: artifact.recipeSha256,
      expectedAssetSha256: artifact.output.video.sha256,
    };
    if (action === "export")
      await repo.getArtifactExport(auth.context, id, { ...checks, recordAudit: false });
    const files = privateAssets(auth.context);
    const descriptor = action === "captions" ? artifact.output.captions : artifact.output.video;
    if (!descriptor) return json({ error: "NOT_FOUND" }, 404);
    const bytes = await files.readDerivedDescriptor(descriptor);
    const extra =
      action === "export"
        ? {
            captions: artifact.output.captions
              ? await files.readDerivedDescriptor(artifact.output.captions)
              : null,
            manifest: await files.readDerivedDescriptor(artifact.output.manifest),
          }
        : null;
    // Recheck current platform identity and explicit grants after storage IO.
    const freshAuth = await access(request, required);
    if (!freshAuth.ok) return freshAuth.response;
    if (
      freshAuth.context.userId !== auth.context.userId ||
      freshAuth.context.isTest !== auth.context.isTest
    )
      throw new Error("FORBIDDEN");
    if (action === "export")
      await requireNativeRenderPolicy(request, freshAuth.context, { artifactId: id });
    const current =
      action === "export"
        ? {
            artifact: await repo.getArtifactExport(freshAuth.context, id, {
              ...checks,
              recordAudit: true,
            }),
            eligibility: { allowed: true as const },
          }
        : await repo.getArtifact(freshAuth.context, id);
    if (!current.eligibility.allowed && current.eligibility.reason !== "ARTIFACT_NOT_APPROVED")
      throw new Error(current.eligibility.reason);
    if (!sameRenderArtifact(artifact, current.artifact)) throw new Error("REVISION_CONFLICT");
    const naming = renderArtifactNaming(current.artifact, initial.job);
    const names = buildDerivedAssetNames(naming);
    if (extra) {
      const sourceManifest = JSON.parse(extra.manifest.toString("utf8"));
      const manifest = Buffer.from(
        JSON.stringify(
          {
            schemaVersion: 1,
            exportedAt: new Date().toISOString(),
            intendedChannel: naming.destination,
            transport: "manual_export",
            masterId: initial.job.masterId,
            sourceVersionId: initial.job.sourceVersionId,
            artifact: publicRenderArtifact(current.artifact, naming),
            recipe: initial.job.recipe,
            renderer: sourceManifest.renderer,
          },
          null,
          2,
        ),
      );
      return new Response(
        new Uint8Array(
          derivativeArchive({ naming, video: bytes, captions: extra.captions, manifest }),
        ),
        {
          headers: {
            "Content-Type": "application/x-tar",
            "Content-Disposition": `attachment; filename="${names.archive}"`,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        },
      );
    }
    const tag = `"${descriptor.sha256}"`;
    const headers = {
      "Content-Type": action === "captions" ? "text/vtt; charset=utf-8" : "video/mp4",
      "Content-Disposition": `inline; filename="${action === "captions" ? names.captions : names.video}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
      "Accept-Ranges": "bytes",
      ETag: tag,
    };
    const ifRange = request.headers.get("if-range");
    const range = singleRange(
      ifRange && ifRange !== tag ? null : request.headers.get("range"),
      bytes.length,
    );
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
  } catch (error) {
    return safeProblem(error);
  }
}
