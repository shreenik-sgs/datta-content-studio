import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOnlineImportRepository,
  createStudioRoleAuthority,
  onlineImportTransactionRolledBack,
} from "@satsang/distribution-db";
import {
  IMPORT_RECOVERY_ERRORS,
  MAX_ONLINE_MASTER_BYTES,
  ONLINE_IMPORT_ERRORS,
} from "@satsang/distribution-domain";
import { z } from "zod";
import { acquireMasterUpload, json, safeProblem } from "../../../../../../lib/http";
import { access, distributionPool, privateAssets } from "../../../../../../lib/runtime";

/** Stream one original at a time to private temporary disk, not a multi-GB FormData buffer. */
export async function POST(request: Request, route: { params: Promise<{ id: string }> }) {
  const auth = await access(request, "content.create");
  if (!auth.ok) return auth.response;
  let directory: string | undefined;
  let release: (() => void) | undefined;
  let asset: Awaited<ReturnType<ReturnType<typeof privateAssets>["write"]>> | undefined;
  let store: ReturnType<typeof privateAssets> | undefined;
  let saving = false;
  try {
    const id = z
      .string()
      .uuid()
      .parse((await route.params).id);
    const rootId = z.string().uuid().parse(new URL(request.url).searchParams.get("bundle"));
    const repo = createOnlineImportRepository(
      distributionPool(),
      createStudioRoleAuthority(process.env),
    );
    const { root } = await repo.recoveryTarget(auth.context, rootId);
    if (root.id !== id && !root.childIds?.includes(id)) throw Error("ORIGINAL_NOT_IN_PLAYLIST");
    const name = decodeURIComponent(request.headers.get("x-original-filename") ?? "");
    if (
      !name ||
      name.length > 255 ||
      [...name].some(
        (char) =>
          char === "/" || char === "\\" || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      )
    )
      throw Error("INVALID_MEDIA");
    const mimeType = request.headers.get("content-type")?.split(";")[0] ?? "";
    if (!["video/mp4", "audio/mpeg", "audio/wav", "audio/mp4"].includes(mimeType))
      throw Error("INVALID_MEDIA");
    if (!request.body) throw Error("INVALID_MEDIA");
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > MAX_ONLINE_MASTER_BYTES) throw Error("UPLOAD_TOO_LARGE");
    release = acquireMasterUpload();
    directory = await mkdtemp(join(tmpdir(), "sgs-original-"));
    const path = join(directory, "recording");
    const file = await open(path, "wx", 0o600);
    const reader = request.body.getReader();
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_ONLINE_MASTER_BYTES) throw Error("UPLOAD_TOO_LARGE");
        await file.writeFile(part.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
      await file.close();
    }
    const fresh = await access(request, "content.create");
    if (!fresh.ok) return fresh.response;
    if (
      fresh.context.userId !== auth.context.userId ||
      fresh.context.isTest !== auth.context.isTest
    )
      throw Error("FORBIDDEN");
    store = privateAssets(fresh.context);
    if (!store.writeFile) throw Error("VERIFICATION_UNAVAILABLE");
    asset = await store.writeFile({ path, mimeType, originalName: name });
    saving = true;
    const result = await repo.attachOriginal(fresh.context, rootId, id, {
      asset,
      title: name.replace(/\.[^.]+$/, "").slice(0, 200),
    });
    if (result.duplicate) await store.removeUnreferenced(asset).catch(() => undefined);
    return json(result, 201);
  } catch (error) {
    // After a lost COMMIT response, retain bytes for reconciliation rather than deleting a master.
    if (asset && store && (!saving || onlineImportTransactionRolledBack(error)))
      await store.removeUnreferenced(asset).catch(() => undefined);
    const code = error instanceof Error ? error.message : "";
    if (IMPORT_RECOVERY_ERRORS[code] || ONLINE_IMPORT_ERRORS[code])
      return json({ error: code }, 409);
    return safeProblem(error);
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    release?.();
  }
}
