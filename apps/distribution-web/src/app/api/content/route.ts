import { contentListQuerySchema, createContentSchema } from "@satsang/distribution-contracts";
import { distributionTransactionRolledBack } from "@satsang/distribution-db";
import { acquireMasterUpload, json, readBoundedFormData, safeProblem } from "../../../lib/http";
import { access, privateAssets } from "../../../lib/runtime";
import { masterUploadLimit } from "../../../lib/upload-policy";

export async function GET(request: Request) {
  const auth = await access(request);
  if (!auth.ok) return auth.response;
  try {
    const { offset, query, view, archive } = contentListQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const items = await auth.repo.list(auth.context, {
      limit: 50,
      offset,
      query,
      archive,
      ...(view === "approvals"
        ? { state: "RIGHTS_CLEARED" }
        : view === "releases"
          ? { state: "APPROVED" }
          : {}),
    });
    return json({
      version: 1,
      items,
      nextOffset: items.length === 50 ? offset + 50 : null,
      identity: { displayName: auth.identity.displayName, locale: auth.identity.locale },
      capabilities: auth.capabilities,
    });
  } catch (error) {
    return safeProblem(error);
  }
}
export async function POST(request: Request) {
  const auth = await access(request, "content.create");
  if (!auth.ok) return auth.response;
  let asset: Awaited<ReturnType<ReturnType<typeof privateAssets>["write"]>> | undefined;
  let files: ReturnType<typeof privateAssets> | undefined;
  let metadataAttempted = false;
  let limit: number | undefined;
  let releaseUpload: (() => void) | undefined;
  try {
    releaseUpload = acquireMasterUpload();
    limit = await masterUploadLimit(auth.context.isTest);
    const form = await readBoundedFormData(request, limit + 16384);
    const metadata = createContentSchema.parse({
      title: form.get("title"),
      language: form.get("language"),
      category: form.get("category"),
    });
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("INVALID_MEDIA");
    if (file.size > limit) throw new Error("UPLOAD_TOO_LARGE");
    files = privateAssets(auth.context);
    asset = await files.write({
      bytes: new Uint8Array(await file.arrayBuffer()),
      mimeType: file.type,
      originalName: file.name,
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
    const content = await freshAuth.repo.create(freshAuth.context, { ...metadata, asset });
    // Upload is step 1. Queue generation only after the Curator confirms permissions
    // and chooses Generate in step 2; an active worker must not race that decision.
    return json({ content }, 201);
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
