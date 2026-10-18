import { z } from "zod";
import { json } from "../../../../../lib/http";
import { access } from "../../../../../lib/runtime";
import {
  publicStudioPackage,
  studioProblem,
  studioRepository,
} from "../../../../../lib/studio-runtime";

const historyQuery = z.object({
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** Revision metadata is read-only. Historical snapshots never grant media or publishing access. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await access(request);
  if (!auth.ok) return auth.response;
  try {
    const id = z
      .string()
      .uuid()
      .parse((await params).id);
    const query = historyQuery.parse(Object.fromEntries(new URL(request.url).searchParams));
    const history = await studioRepository().history(auth.context, id, query);
    return json({
      version: 1,
      revisions: history.revisions.map((revision) => ({
        revision: revision.revision,
        action: revision.action,
        actorId: revision.actorId,
        createdAt: revision.createdAt,
        package: publicStudioPackage(revision.package),
      })),
      nextOffset: history.nextOffset,
    });
  } catch (error) {
    return studioProblem(error);
  }
}
