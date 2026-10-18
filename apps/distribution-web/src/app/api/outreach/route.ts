import { json, safeProblem } from "../../../lib/http";
import { outreachRepository } from "../../../lib/outreach-runtime";
import { access } from "../../../lib/runtime";
export async function GET(request: Request) {
  const auth = await access(request);
  if (!auth.ok) return auth.response;
  try {
    const offset = Number(new URL(request.url).searchParams.get("offset") ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("INVALID_PAGINATION");
    const repo = outreachRepository();
    const [campaigns, ctas] = await Promise.all([
      repo.listCampaigns(auth.context, { limit: 50, offset }),
      repo.listCtas(auth.context, { limit: 50, offset }),
    ]);
    return json({
      version: 1,
      campaigns,
      ctas,
      nextOffset: campaigns.length === 50 || ctas.length === 50 ? offset + 50 : null,
    });
  } catch (error) {
    return safeProblem(error);
  }
}
