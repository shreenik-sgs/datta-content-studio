import {
  activationPackageChangeSchema,
  outreachReviewCommandSchema,
} from "@satsang/distribution-contracts";
import { buildDerivedAssetNames } from "@satsang/distribution-domain";
import { z } from "zod";
import { enqueueDestinationValidation } from "../../../../../../lib/activation-events";
import {
  checkDistributionCanonicalDestinations,
  checkDistributionDestinations,
  socialPackageEnabled,
} from "../../../../../../lib/destination-status";
import { derivativeArchive } from "../../../../../../lib/export";
import { boundedJson, json, safeProblem } from "../../../../../../lib/http";
import { requireNativeRenderPolicy } from "../../../../../../lib/native-render-policy";
import { activationRepository } from "../../../../../../lib/outreach-runtime";
import {
  publicRenderArtifact,
  renderArtifactNaming,
  sameRenderArtifact,
} from "../../../../../../lib/render-runtime";
import { access, privateAssets } from "../../../../../../lib/runtime";
type Params = { params: Promise<{ id: string; action: string }> };
export async function POST(request: Request, { params }: Params) {
  const { id, action } = await params;
  const auth = await access(request, action === "approve" ? "content.review" : undefined);
  if (!auth.ok) return auth.response;
  try {
    z.string().uuid().parse(id);
    const body = await boundedJson(request);
    const command =
      action === "revise"
        ? activationPackageChangeSchema.parse(body)
        : outreachReviewCommandSchema.parse(body);
    const repo = activationRepository();
    if (action === "stop") return json({ activation: await repo.stop(auth.context, id, command) });
    if (!["approve", "revise", "validate-destination"].includes(action))
      return json({ error: "NOT_FOUND" }, 404);
    const draft = await repo.get(auth.context, id);
    if (action === "revise") {
      if (!(await socialPackageEnabled(request))) throw new Error("FEATURE_UNAVAILABLE");
      return json({
        activation: await repo.revisePackage(
          auth.context,
          id,
          activationPackageChangeSchema.parse(body),
        ),
      });
    }
    if (!draft.reviewPackage && (await socialPackageEnabled(request)))
      throw new Error("ACTIVATION_PACKAGE_REQUIRED");
    await requireNativeRenderPolicy(request, auth.context, { artifactId: draft.derivativeId });
    const destinations = await (draft.reviewPackage
      ? checkDistributionCanonicalDestinations
      : checkDistributionDestinations)(request, [
      draft.pinnedCta.destination.path,
      draft.pinnedCta.fallback.path,
    ]);
    if (action === "validate-destination") {
      if (destinations.version !== 2) throw new Error("INVALID_ACTIVATION_PACKAGE");
      const activation = await repo.validateDestination(auth.context, id, {
        ...command,
        destinations,
      });
      await enqueueDestinationValidation(activation);
      return json({ activation });
    }
    return json({ activation: await repo.approve(auth.context, id, { ...command, destinations }) });
  } catch (error) {
    return safeProblem(error);
  }
}
export async function GET(request: Request, { params }: Params) {
  const { id, action } = await params;
  const auth = await access(request, action === "export" ? "content.publish" : undefined);
  if (!auth.ok) return auth.response;
  try {
    z.string().uuid().parse(id);
    if (action !== "export") return json({ error: "NOT_FOUND" }, 404);
    const repo = activationRepository();
    const a = await repo.get(auth.context, id);
    const paths = [a.pinnedCta.destination.path, a.pinnedCta.fallback.path];
    if (!a.reviewPackage && (await socialPackageEnabled(request)))
      throw new Error("ACTIVATION_PACKAGE_REQUIRED");
    await requireNativeRenderPolicy(request, auth.context, { artifactId: a.derivativeId });
    const check = a.reviewPackage
      ? checkDistributionCanonicalDestinations
      : checkDistributionDestinations;
    const initial = await repo.getExport(auth.context, id, {
      expectedRevision: a.revision,
      destinations: await check(request, paths),
      recordAudit: false,
    });
    const files = privateAssets(auth.context);
    const video = await files.readDerivedDescriptor(initial.artifact.output.video);
    const captions = initial.artifact.output.captions
      ? await files.readDerivedDescriptor(initial.artifact.output.captions)
      : null;
    const source = JSON.parse(
      (await files.readDerivedDescriptor(initial.artifact.output.manifest)).toString("utf8"),
    );
    const fresh = await access(request, "content.publish");
    if (!fresh.ok) return fresh.response;
    if (
      fresh.context.userId !== auth.context.userId ||
      fresh.context.isTest !== auth.context.isTest
    )
      throw new Error("FORBIDDEN");
    await requireNativeRenderPolicy(request, fresh.context, { artifactId: a.derivativeId });
    const current = await repo.getExport(fresh.context, id, {
      expectedRevision: a.revision,
      destinations: await check(request, paths),
      recordAudit: true,
    });
    if (!sameRenderArtifact(initial.artifact, current.artifact))
      throw new Error("REVISION_CONFLICT");
    const intendedChannel = current.activation.reviewPackage?.channel ?? current.activation.channel;
    const naming = renderArtifactNaming(current.artifact, current.renderContext, intendedChannel);
    const names = buildDerivedAssetNames(naming);
    const manifest = Buffer.from(
      JSON.stringify(
        {
          schemaVersion: 1,
          isTest: true,
          channel: intendedChannel,
          intendedChannel,
          transport: "manual_export",
          channelAccountId: null,
          exportedAt: new Date().toISOString(),
          campaign: { id: a.campaignId, revision: a.campaignRevision },
          activation: { id: a.id, revision: a.revision },
          invitation: a.linkBinding?.cta,
          trackedPath: a.reviewPackage ? `/s/${a.token}` : `/outreach/${a.token}`,
          ...(a.reviewPackage
            ? { reviewPackage: a.reviewPackage, approvalPackageSha256: a.approvalPackageSha256 }
            : {}),
          sourceVersionId: a.sourceVersionId,
          masterId: current.activation.masterId,
          artifact: publicRenderArtifact(current.artifact, naming),
          recipe: current.renderContext.recipe,
          renderer: source.renderer,
        },
        null,
        2,
      ),
    );
    return new Response(new Uint8Array(derivativeArchive({ naming, video, captions, manifest })), {
      headers: {
        "Content-Type": "application/x-tar",
        "Content-Disposition": `attachment; filename="${names.archive}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return safeProblem(error);
  }
}
