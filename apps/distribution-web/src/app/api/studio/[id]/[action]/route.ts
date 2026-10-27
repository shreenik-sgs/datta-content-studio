import {
  studioClosingRefreshSchema,
  studioDiscardSchema,
  studioPublishSchema,
  studioRegenerateSchema,
  studioRetractSchema,
  studioReviewSchema,
  studioReviseSchema,
  studioSubmitSchema,
} from "@satsang/distribution-contracts";
import { loadStudioProviderConfig, studioSettingsPath } from "@satsang/distribution-db";
import {
  type DistributionCapability,
  studioFileStatus,
  studioPublishingAccounts,
  studioSelectedOutputs,
} from "@satsang/distribution-domain";
import { z } from "zod";
import { json } from "../../../../../lib/http";
import { access } from "../../../../../lib/runtime";
import {
  publicStudioPackage,
  publicStudioPublication,
  publicStudioSummary,
  studioJson,
  studioProblem,
  studioRepository,
} from "../../../../../lib/studio-runtime";

const permissions: Record<string, DistributionCapability | undefined> = {
  regenerate: "content.create",
  "verify-closings": "content.create",
  revise: "content.create",
  submit: "content.create",
  review: "content.review",
  discard: undefined,
  publish: "content.publish",
  retract: "content.publish",
};
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; action: string }> },
) {
  const { id, action } = await params;
  const auth = await access(request, permissions[action]);
  if (!auth.ok) return auth.response;
  try {
    if (!Object.hasOwn(permissions, action)) return json({ error: "NOT_FOUND" }, 404);
    z.string().uuid().parse(id);
    if (
      action === "discard" &&
      !auth.capabilities.some(
        (capability) => capability === "content.create" || capability === "content.review",
      )
    )
      throw new Error("FORBIDDEN");
    const body = await studioJson(request);
    const repo = studioRepository();
    if (action === "publish") {
      const command = studioPublishSchema.parse(body);
      const pkg = await repo.get(auth.context, id);
      const config = await loadStudioProviderConfig(
        studioSettingsPath(process.env, auth.context.isTest),
      );
      const accounts = studioPublishingAccounts(
        config.accounts,
        studioSelectedOutputs(
          pkg.outputs,
          command.outputIds ??
            (pkg.outputs.some((o) => o.workflow)
              ? pkg.outputs.filter((o) => studioFileStatus(pkg, o) === "APPROVED").map((o) => o.id)
              : undefined),
        ).map((output) => output.channel),
        command.accounts ?? {},
        auth.context.isTest,
      );
      return json({
        publications: (await repo.publish(auth.context, id, { ...command, accounts })).map(
          publicStudioPublication,
        ),
      });
    }
    if (action === "retract") {
      const results = await repo.retract(auth.context, id, studioRetractSchema.parse(body));
      return json({
        results: results.map((entry) => ({
          ...entry,
          publication: publicStudioPublication(entry.publication),
        })),
      });
    }
    const value =
      action === "verify-closings"
        ? await repo.enqueueClosingVerification(
            auth.context,
            id,
            studioClosingRefreshSchema.parse(body),
          )
        : action === "regenerate"
          ? await repo.enqueueGeneration(auth.context, id, studioRegenerateSchema.parse(body))
          : action === "revise"
            ? await repo.revise(auth.context, id, studioReviseSchema.parse(body))
            : action === "submit"
              ? await repo.submit(auth.context, id, studioSubmitSchema.parse(body))
              : action === "review"
                ? await repo.review(auth.context, id, studioReviewSchema.parse(body))
                : await repo.discard(auth.context, id, studioDiscardSchema.parse(body));
    return json({
      package: (new URL(request.url).searchParams.get("view") === "action"
        ? publicStudioSummary
        : publicStudioPackage)(value),
    });
  } catch (error) {
    return studioProblem(error);
  }
}
