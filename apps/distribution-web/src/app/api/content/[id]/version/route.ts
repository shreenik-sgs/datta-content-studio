import { approvalCommandSchema } from "@satsang/distribution-contracts";
import { distributionTransactionRolledBack } from "@satsang/distribution-db";
import { z } from "zod";
import {
  acquireMasterUpload,
  json,
  readBoundedFormData,
  safeProblem,
} from "../../../../../lib/http";
import { access, privateAssets } from "../../../../../lib/runtime";
import { masterUploadLimit } from "../../../../../lib/upload-policy";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await access(request, "content.create");
  if (!auth.ok) return auth.response;
  let asset: Awaited<ReturnType<ReturnType<typeof privateAssets>["write"]>> | undefined;
  let files: ReturnType<typeof privateAssets> | undefined;
  let metadataAttempted = false;
  let limit: number | undefined;
  let releaseUpload: (() => void) | undefined;
  try {
    const { id } = await params;
    z.string().uuid().parse(id);
    releaseUpload = acquireMasterUpload();
    limit = await masterUploadLimit(auth.context.isTest);
    const form = await readBoundedFormData(request, limit + 16384);
    const { expectedRevision } = approvalCommandSchema.parse({
      expectedRevision: Number(form.get("expectedRevision")),
    });
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("INVALID_MEDIA");
    if (file.size > limit) throw new Error("UPLOAD_TOO_LARGE");
    files = privateAssets(auth.context);
    asset = await files.write({
      bytes: new Uint8Array(await file.arrayBuffer()),
      originalName: file.name,
      mimeType: file.type,
    });
    const freshAuth = await access(request, "content.create");
    if (!freshAuth.ok) {
      await files.removeUnreferenced(asset).catch(() => undefined);
      return freshAuth.response;
    }
    if (
      freshAuth.context.userId !== auth.context.userId ||
      freshAuth.context.isTest !== auth.context.isTest
    )
      throw new Error("FORBIDDEN");
    metadataAttempted = true;
    return json(
      {
        content: await freshAuth.repo.addVersion(freshAuth.context, id, {
          expectedRevision,
          asset,
        }),
      },
      201,
    );
  } catch (error) {
    // An unanswered COMMIT may have succeeded. Retain its media until reconciled.
    if (asset && files && (!metadataAttempted || distributionTransactionRolledBack(error)))
      await files.removeUnreferenced(asset).catch(() => undefined);
    if (error instanceof Error && error.message === "UPLOAD_TOO_LARGE")
      return json({ error: "UPLOAD_TOO_LARGE", maxMasterBytes: limit }, 413);
    return safeProblem(error);
  } finally {
    releaseUpload?.();
  }
}
