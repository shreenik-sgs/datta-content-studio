import {
  createStorageCleanupRepository,
  createStudioRoleAuthority,
} from "@satsang/distribution-db";
import { z } from "zod";
import { json, readBoundedBody } from "../../../lib/http";
import { access, distributionPool, privateAssets } from "../../../lib/runtime";
const selection = z
  .object({
    kind: z.enum(["package", "master", "playlist"]),
    id: z.string().uuid(),
    mode: z.enum(["generated", "all"]),
  })
  .strict();
const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preview"), selection }).strict(),
  z
    .object({
      action: z.literal("delete"),
      selection,
      token: z.string().regex(/^[a-f0-9]{64}$/),
      confirmed: z.literal(true),
    })
    .strict(),
]);
const repo = () =>
  createStorageCleanupRepository(distributionPool(), createStudioRoleAuthority(process.env));
export async function GET(request: Request) {
  const auth = await access(request);
  if (!auth.ok) return auth.response;
  try {
    return json({ jobs: await repo().list(auth.context) });
  } catch {
    return json({ error: "Unable to load storage cleanup history." }, 503);
  }
}
export async function POST(request: Request) {
  const auth = await access(request);
  if (!auth.ok) return auth.response;
  try {
    privateAssets(auth.context); // Enforce the configured storage/world boundary before any tombstone.
    const data = command.parse(
      JSON.parse(Buffer.from(await readBoundedBody(request, 4096)).toString("utf8")),
    );
    return data.action === "preview"
      ? json({ preview: await repo().preview(auth.context, data.selection) })
      : json({ job: await repo().request(auth.context, data.selection, data.token) }, 202);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (error instanceof z.ZodError)
      return json({ error: "Select a valid source and cleanup option." }, 400);
    if (code === "FORBIDDEN")
      return json({ error: "You do not have permission to delete this content." }, 403);
    if (code === "NOT_FOUND")
      return json({ error: "This source has already been removed. Refresh the workspace." }, 404);
    if (code === "CLEANUP_CHANGED")
      return json(
        {
          error: "The content changed since this preview. Preview cleanup again before confirming.",
        },
        409,
      );
    if (code === "CLEANUP_BLOCKED")
      return json(
        { error: "Cleanup is blocked. Refresh the preview to see what still uses these files." },
        409,
      );
    return json(
      {
        error:
          "Cleanup could not be completed. Your files have not been confirmed as deleted. Refresh the cleanup history before retrying.",
      },
      503,
    );
  }
}
