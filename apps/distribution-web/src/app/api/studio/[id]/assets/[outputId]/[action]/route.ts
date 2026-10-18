import { STUDIO_LANGUAGES } from "@satsang/distribution-domain";
import { z } from "zod";
import { json, singleRange } from "../../../../../../../lib/http";
import { access, privateAssets } from "../../../../../../../lib/runtime";
import { studioProblem, studioRepository } from "../../../../../../../lib/studio-runtime";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; outputId: string; action: string }> },
) {
  const { id, outputId, action } = await params;
  const required = action === "download" ? "content.publish" : undefined;
  const auth = await access(request, required);
  if (!auth.ok) return auth.response;
  try {
    if (!["media", "captions", "download", "thumbnail"].includes(action))
      return json({ error: "NOT_FOUND" }, 404);
    z.string().uuid().parse(id);
    z.string().uuid().parse(outputId);
    const options =
      action === "captions"
        ? {
            kind: "caption" as const,
            language: z
              .enum(STUDIO_LANGUAGES)
              .parse(new URL(request.url).searchParams.get("language")),
          }
        : action === "thumbnail"
          ? { kind: "thumbnail" as const }
          : { kind: "asset" as const, forExport: action === "download" };
    const repo = studioRepository();
    const descriptor = await repo.getOutputAsset(auth.context, id, outputId, options);
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(descriptor.filename) ||
      ![
        "video/mp4",
        "image/png",
        "text/markdown",
        "text/plain",
        "text/vtt",
        "application/json",
      ].includes(descriptor.mimeType)
    )
      throw new Error("INVALID_ASSET");
    const bytes = await privateAssets(auth.context).readDerivedDescriptor(descriptor);
    const fresh = await access(request, required);
    if (!fresh.ok) return fresh.response;
    if (
      fresh.context.userId !== auth.context.userId ||
      fresh.context.isTest !== auth.context.isTest
    )
      throw new Error("FORBIDDEN");
    const current = await repo.getOutputAsset(fresh.context, id, outputId, options);
    if (JSON.stringify(current) !== JSON.stringify(descriptor))
      throw new Error("REVISION_CONFLICT");
    const tag = `"${descriptor.sha256}"`;
    const headers = {
      "Content-Type": descriptor.mimeType.startsWith("text/")
        ? `${descriptor.mimeType}; charset=utf-8`
        : descriptor.mimeType,
      "Content-Disposition": `${action === "download" ? "attachment" : "inline"}; filename="${descriptor.filename}"`,
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
    return studioProblem(error);
  }
}
