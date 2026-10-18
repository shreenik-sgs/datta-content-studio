import {
  approvalCommandSchema,
  exportCommandSchema,
  exportManifestSchema,
  rightsCommandSchema,
  updateContentSchema,
  withdrawCommandSchema,
} from "@satsang/distribution-contracts";
import { MAX_MASTER_BYTES, buildMasterAssetNames } from "@satsang/distribution-domain";
import { z } from "zod";
import { exportArchive, exportMasterArchiveStream } from "../../../../../lib/export";
import { boundedJson, json, safeProblem, singleRange } from "../../../../../lib/http";
import { access, privateAssets } from "../../../../../lib/runtime";

import { rightsErrors } from "../../../../../lib/rights-errors";

type Params = { params: Promise<{ id: string; action: string }> };
export async function POST(request: Request, { params }: Params) {
  const auth = await access(request);
  if (!auth.ok) return auth.response;
  try {
    const { id, action } = await params;
    z.string().uuid().parse(id);
    const body = await boundedJson(request);
    if (action === "metadata")
      return json({
        content: await auth.repo.updateMetadata(auth.context, id, updateContentSchema.parse(body)),
      });
    if (action === "rights") {
      const parsed = rightsCommandSchema.safeParse(body);
      if (!parsed.success)
        return json({ error: "INVALID_REQUEST", fields: rightsErrors(parsed.error.issues) }, 400);
      return json({ content: await auth.repo.attestRights(auth.context, id, parsed.data) });
    }
    if (action === "approve")
      return json({
        content: await auth.repo.approve(auth.context, id, approvalCommandSchema.parse(body)),
      });
    if (action === "withdraw")
      return json({
        content: await auth.repo.withdraw(auth.context, id, withdrawCommandSchema.parse(body)),
      });
    if (action === "export") {
      const command = exportCommandSchema.parse(body);
      const now = new Date().toISOString();
      const { content, asset } = await auth.repo.getExport(auth.context, id, {
        ...command,
        now,
        recordAudit: false,
      });
      const manifest = exportManifestSchema.parse({
        schemaVersion: 1,
        exportedAt: now,
        exportedBy: auth.identity.id,
        channel: command.channel,
        territory: command.territory,
        content,
      });
      const store = privateAssets(auth.context);
      const large = asset.byteSize > MAX_MASTER_BYTES && store.readRange;
      const bytes = large
        ? await large(asset, 0, Math.min(asset.byteSize, 8 * 1024 * 1024) - 1)
        : await store.read(asset);
      // Recheck current identity and release conditions after private storage IO.
      const freshAuth = await access(request, "content.publish");
      if (!freshAuth.ok) return freshAuth.response;
      if (
        freshAuth.context.userId !== auth.context.userId ||
        freshAuth.context.isTest !== auth.context.isTest
      )
        throw new Error("FORBIDDEN");
      await freshAuth.repo.getExport(freshAuth.context, id, {
        ...command,
        now: new Date().toISOString(),
        recordAudit: true,
      });
      const names = buildMasterAssetNames({
        masterId: content.id,
        versionNumber: content.currentVersion.number,
      });
      const archiveBody = large
        ? exportMasterArchiveStream(
            (start, end) => (start === 0 ? Promise.resolve(bytes) : large(asset, start, end)),
            manifest,
          )
        : new Uint8Array(exportArchive(bytes, manifest));
      return new Response(archiveBody, {
        headers: {
          "Content-Type": "application/x-tar",
          "Content-Disposition": `attachment; filename="${names.archive}"`,
          "Cache-Control": "no-store",
        },
      });
    }
    return json({ error: "NOT_FOUND" }, 404);
  } catch (error) {
    return safeProblem(error);
  }
}
export async function GET(request: Request, { params }: Params) {
  const auth = await access(request);
  if (!auth.ok) return auth.response;
  try {
    const { id, action } = await params;
    z.string().uuid().parse(id);
    if (action === "detail") return json({ content: await auth.repo.get(auth.context, id) });
    if (action === "versions")
      return json({ versions: await auth.repo.versions(auth.context, id) });
    if (action !== "media") return json({ error: "NOT_FOUND" }, 404);
    const initial = await auth.repo.getAsset(auth.context, id);
    const { asset } = initial;
    const store = privateAssets(auth.context);
    const tag = `"${asset.sha256}"`;
    const ifRange = request.headers.get("if-range");
    const requestedRange = singleRange(
      ifRange && ifRange !== tag ? null : request.headers.get("range"),
      asset.byteSize,
    );
    if (requestedRange === "invalid")
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${asset.byteSize}`, "Cache-Control": "no-store" },
      });
    const large = asset.byteSize > MAX_MASTER_BYTES && store.readRange;
    const start = requestedRange ? requestedRange.start : 0;
    const end = requestedRange ? requestedRange.end : asset.byteSize - 1;
    const chunkEnd = Math.min(end, start + 8 * 1024 * 1024 - 1);
    const bytes = large ? await large(asset, start, chunkEnd) : await store.read(asset);
    const freshAuth = await access(request);
    if (!freshAuth.ok) return freshAuth.response;
    if (
      freshAuth.context.userId !== auth.context.userId ||
      freshAuth.context.isTest !== auth.context.isTest
    )
      throw new Error("FORBIDDEN");
    const current = await freshAuth.repo.getAsset(freshAuth.context, id);
    // Never return an earlier source if a version/rights change won the race.
    if (
      current.content.revision !== initial.content.revision ||
      current.asset.storageKey !== asset.storageKey ||
      current.asset.sha256 !== asset.sha256 ||
      current.asset.byteSize !== asset.byteSize
    )
      throw new Error("REVISION_CONFLICT");
    const headers = {
      "Content-Type": asset.mimeType,
      "Cache-Control": "no-store",
      "Content-Security-Policy": "sandbox",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
      ETag: tag,
    };
    if (large) {
      let offset = start;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const part =
              offset === start
                ? bytes
                : await large(asset, offset, Math.min(end, offset + 8 * 1024 * 1024 - 1));
            offset += part.length;
            controller.enqueue(new Uint8Array(part));
            if (offset > end) controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
      });
      return new Response(stream, {
        status: requestedRange ? 206 : 200,
        headers: {
          ...headers,
          "Content-Length": String(end - start + 1),
          ...(requestedRange ? { "Content-Range": `bytes ${start}-${end}/${asset.byteSize}` } : {}),
        },
      });
    }
    const range = requestedRange;
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
