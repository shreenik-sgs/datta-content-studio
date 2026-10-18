import { makeCtaCommandSchema, outreachCampaignInputSchema } from "@satsang/distribution-contracts";
import { boundedJson, json, safeProblem } from "../../../../lib/http";
import { outreachRepository } from "../../../../lib/outreach-runtime";
import { access } from "../../../../lib/runtime";
export async function POST(request: Request, { params }: { params: Promise<{ kind: string }> }) {
  const auth = await access(request, "campaigns.manage");
  if (!auth.ok) return auth.response;
  try {
    const { kind } = await params;
    const repo = outreachRepository();
    if (kind !== "campaign" && kind !== "cta") return json({ error: "NOT_FOUND" }, 404);
    const body = await boundedJson(request);
    if (kind === "campaign")
      return json(
        {
          campaign: await repo.createCampaign(
            auth.context,
            outreachCampaignInputSchema.parse(body),
          ),
        },
        201,
      );
    return json(
      { cta: await repo.createCta(auth.context, makeCtaCommandSchema().parse(body)) },
      201,
    );
  } catch (error) {
    return safeProblem(error);
  }
}
