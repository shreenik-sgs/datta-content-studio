import { z } from "zod";
import { json } from "../../../../../lib/http";
import { access } from "../../../../../lib/runtime";
import {
  studioProblem,
  studioRefusalDetail,
  studioRepository,
} from "../../../../../lib/studio-runtime";

/** The exact fresh publication checks, with no job creation or external sends. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await access(request, "content.publish");
  if (!auth.ok) return auth.response;
  try {
    const id = z
      .string()
      .uuid()
      .parse((await params).id);
    const search = new URL(request.url).searchParams;
    const expectedRevision = z.coerce.number().int().positive().parse(search.get("revision"));
    const outputIds = z
      .array(z.string().uuid())
      .min(1)
      .max(500)
      .parse(search.get("outputs")?.split(","));
    const result = await studioRepository().publicationPreflight(
      auth.context,
      id,
      expectedRevision,
      outputIds,
    );
    return json({
      ...result,
      ...(await studioRefusalDetail(result.operatorId, auth.context.isTest)),
    });
  } catch (error) {
    return studioProblem(error);
  }
}
