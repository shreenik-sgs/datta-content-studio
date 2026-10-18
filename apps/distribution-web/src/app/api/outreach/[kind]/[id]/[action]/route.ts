import {
  campaignChangeSchema,
  makeCtaChangeSchema,
  outreachReviewCommandSchema,
} from "@satsang/distribution-contracts";
import { z } from "zod";
import { boundedJson, json, safeProblem } from "../../../../../../lib/http";
import { outreachRepository } from "../../../../../../lib/outreach-runtime";
import { access } from "../../../../../../lib/runtime";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ kind: string; id: string; action: string }> },
) {
  const { kind, id, action } = await params;
  const auth = await access(
    request,
    action === "approve" ? "content.review" : action === "edit" ? "campaigns.manage" : undefined,
  );
  if (!auth.ok) return auth.response;
  try {
    z.string().uuid().parse(id);
    if (
      !["campaign", "cta"].includes(kind) ||
      !["edit", "approve", "pause", "stop"].includes(action) ||
      (kind === "cta" && ["pause", "stop"].includes(action))
    )
      return json({ error: "NOT_FOUND" }, 404);
    const body = await boundedJson(request);
    const repo = outreachRepository();
    if (kind === "campaign") {
      if (action === "edit")
        return json({
          campaign: await repo.updateCampaign(auth.context, id, campaignChangeSchema.parse(body)),
        });
      const command = outreachReviewCommandSchema.parse(body);
      if (action === "approve")
        return json({ campaign: await repo.approveCampaign(auth.context, id, command) });
      if (action === "pause")
        return json({ campaign: await repo.pauseCampaign(auth.context, id, command) });
      return json({ campaign: await repo.stopCampaign(auth.context, id, command) });
    }
    if (action === "edit")
      return json({
        cta: await repo.updateCta(auth.context, id, makeCtaChangeSchema().parse(body)),
      });
    return json({
      cta: await repo.approveCta(auth.context, id, outreachReviewCommandSchema.parse(body)),
    });
  } catch (error) {
    return safeProblem(error);
  }
}
