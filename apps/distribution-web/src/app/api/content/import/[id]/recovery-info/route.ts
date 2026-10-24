import { createOnlineImportRepository, createStudioRoleAuthority } from "@satsang/distribution-db";
import { COMPUTER_RECOVERY_ORIGIN } from "@satsang/distribution-domain";
import { z } from "zod";
import { json, safeProblem } from "../../../../../../lib/http";
import { access, distributionPool } from "../../../../../../lib/runtime";
import { studioIdentity } from "../../../../../../lib/studio-identity";

/** Authenticated read gate before the local worker fetches any recording. */
export async function GET(request: Request, route: { params: Promise<{ id: string }> }) {
  const auth = await access(request, "content.create");
  if (!auth.ok) return auth.response;
  try {
    if (
      process.env.DISTRIBUTION_APP_ORIGIN !== COMPUTER_RECOVERY_ORIGIN ||
      studioIdentity().id !== "gbadpt" ||
      !auth.context.isTest
    )
      return json({ error: "RECOVERY_DESTINATION_MISMATCH" }, 403);
    const id = z
      .string()
      .uuid()
      .parse((await route.params).id);
    const repo = createOnlineImportRepository(
      distributionPool(),
      createStudioRoleAuthority(process.env),
    );
    const items = await repo.list(auth.context, { rootId: id });
    const root = items.find((item) => item.id === id);
    if (!root?.childIds?.length) return json({ error: "RECOVERY_INVALID_PLAYLIST" }, 409);
    if (!root.curation) return json({ error: "RECOVERY_SAVED_PLAYLIST_REQUIRED" }, 409);
    return json({
      identity: "gbadpt",
      isTest: true,
      root,
      children: root.childIds
        .map((child) => items.find((item) => item.id === child))
        .filter(Boolean),
    });
  } catch (error) {
    return safeProblem(error);
  }
}
