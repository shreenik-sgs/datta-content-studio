import { z } from "zod";
import { json, safeProblem } from "../../../../../lib/http";
import { outreachRepository } from "../../../../../lib/outreach-runtime";
import { access } from "../../../../../lib/runtime";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ kind: string; id: string }> },
) {
  const auth = await access(request);
  if (!auth.ok) return auth.response;
  try {
    const { kind, id } = await params;
    z.string().uuid().parse(id);
    const repo = outreachRepository();
    if (kind === "campaign")
      return json({
        campaign: await repo.getCampaign(auth.context, id),
        history: await repo.campaignHistory(auth.context, id),
      });
    if (kind === "cta")
      return json({
        cta: await repo.getCta(auth.context, id),
        history: await repo.ctaHistory(auth.context, id),
      });
    return json({ error: "NOT_FOUND" }, 404);
  } catch (error) {
    return safeProblem(error);
  }
}
