import { manualActivationCommandSchema } from "@satsang/distribution-contracts";
import { z } from "zod";
import { socialPackageEnabled } from "../../../../lib/destination-status";
import { boundedJson, json, safeProblem } from "../../../../lib/http";
import { activationRepository } from "../../../../lib/outreach-runtime";
import { access } from "../../../../lib/runtime";
export async function GET(request: Request) {
  const auth = await access(request);
  if (!auth.ok) return auth.response;
  try {
    const repo = activationRepository();
    const url = new URL(request.url);
    if (url.searchParams.get("choices") === "1")
      return json({
        artifacts: await repo.choices(auth.context),
        packageEnabled: await socialPackageEnabled(request),
      });
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const activations = await repo.list(auth.context, {
      offset,
      limit: 50,
      ...(url.searchParams.get("campaignId")
        ? { campaignId: z.string().uuid().parse(url.searchParams.get("campaignId")) }
        : {}),
    });
    return json({
      version: 1,
      activations,
      packageEnabled: await socialPackageEnabled(request),
      nextOffset: activations.length === 50 ? offset + 50 : null,
    });
  } catch (error) {
    return safeProblem(error);
  }
}
export async function POST(request: Request) {
  const auth = await access(request, "campaigns.manage");
  if (!auth.ok) return auth.response;
  try {
    const command = manualActivationCommandSchema.parse(await boundedJson(request));
    const enabled = await socialPackageEnabled(request);
    if (command.reviewPackage && !enabled) throw new Error("FEATURE_UNAVAILABLE");
    if (enabled && !command.reviewPackage) throw new Error("ACTIVATION_PACKAGE_REQUIRED");
    return json(
      {
        activation: await activationRepository().create(auth.context, command),
      },
      201,
    );
  } catch (error) {
    return safeProblem(error);
  }
}
