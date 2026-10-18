import {
  type RenderArtifact,
  type RenderFile,
  createDistributionRenderRepository,
  createDistributionRoleAuthority,
} from "@satsang/distribution-db";
import {
  type DerivedAssetNamingInput,
  type RenderRecipe,
  buildDerivedAssetNames,
  parseDerivedAssetKey,
} from "@satsang/distribution-domain";
import { distributionPool } from "./runtime";

export function renderRepository() {
  // This callback is solely for the existing local TEST preview. Production
  // keeps its prior unconfigured, fail-closed repository behavior and never
  // constructs or contacts this loopback authority.
  return createDistributionRenderRepository(
    distributionPool(),
    process.env.DISTRIBUTION_HUB_STAGE === "TEST"
      ? { authorize: createDistributionRoleAuthority(process.env) }
      : {},
  );
}
const publicFailures = new Set([
  "RENDER_TIMEOUT",
  "RENDER_PROCESS_FAILED",
  "RENDER_PROCESS_UNAVAILABLE",
  "RENDER_CANCELLED",
  "RENDER_VALIDATION_FAILED",
  "SOURCE_INTEGRITY_FAILED",
  "SOURCE_SPAN_UNAVAILABLE",
  "RENDER_FAILED",
  "RETRY_EXHAUSTED",
  "REQUESTER_GRANT_REVOKED",
  "SOURCE_VERSION_STALE",
  "SOURCE_DEPENDENCY_CHANGED",
  "TRANSCRIPT_SUPERSEDED",
  "TRANSCRIPT_NOT_APPROVED",
  "QUOTE_NOT_APPROVED",
  "WITHDRAWN",
  "NOT_APPROVED",
  "APPROVAL_STALE",
  "RIGHTS_MISSING",
  "RELEASE_PENDING",
  "RIGHTS_EXPIRED",
  "RESTRICTED_CONTENT",
  "REVISION_CONFLICT",
]);
export function publicRenderJob(
  job: Awaited<ReturnType<ReturnType<typeof createDistributionRenderRepository>["enqueue"]>>,
) {
  return {
    id: job.id,
    masterId: job.masterId,
    sourceVersionId: job.sourceVersionId,
    recipeSha256: job.recipeSha256,
    recipe: job.recipe,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    availableAt: job.availableAt,
    lastError:
      job.lastError === null
        ? null
        : publicFailures.has(job.lastError)
          ? job.lastError
          : "RENDER_FAILED",
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
/** Canonical job context supplies identity; a stored key may supply only its immutable run id. */
export function renderArtifactNaming(
  artifact: RenderArtifact,
  context: { masterId: string; sourceVersionId: string; recipe: RenderRecipe },
  destination?: DerivedAssetNamingInput["destination"],
): DerivedAssetNamingInput {
  const stored = parseDerivedAssetKey(artifact.output.video.storageKey)?.naming;
  if (
    stored &&
    (stored.masterId !== context.masterId || stored.sourceVersionId !== context.sourceVersionId)
  )
    throw new Error("ARTIFACT_MISMATCH");
  return {
    masterId: context.masterId,
    sourceVersionId: context.sourceVersionId,
    derivationId: stored?.derivationId ?? artifact.id,
    destination: destination ?? context.recipe.placement ?? context.recipe.channel,
    language: context.recipe.language,
    aspect: context.recipe.aspect,
    ...(stored?.format && (destination === undefined || destination === stored.destination)
      ? { format: stored.format }
      : {}),
  };
}
function publicFile(file: RenderFile, filename?: string) {
  return {
    sha256: file.sha256,
    byteSize: file.byteSize,
    mimeType: file.mimeType,
    filename: filename ?? parseDerivedAssetKey(file.storageKey)?.filename ?? null,
  };
}
export function publicRenderArtifact(artifact: RenderArtifact, naming?: DerivedAssetNamingInput) {
  const names = naming ? buildDerivedAssetNames(naming) : null;
  return {
    id: artifact.id,
    jobId: artifact.jobId,
    revision: artifact.revision,
    recipeSha256: artifact.recipeSha256,
    approval: artifact.approval,
    createdAt: artifact.createdAt,
    output: {
      recipeSha256: artifact.output.recipeSha256,
      sourceSha256: artifact.output.sourceSha256,
      encoderVersion: artifact.output.encoderVersion,
      video: publicFile(artifact.output.video, names?.video),
      captions: artifact.output.captions
        ? publicFile(artifact.output.captions, names?.captions)
        : null,
      manifest: publicFile(artifact.output.manifest, names?.manifest),
    },
  };
}
export function sameRenderArtifact(first: RenderArtifact, second: RenderArtifact): boolean {
  return (
    first.id === second.id &&
    first.revision === second.revision &&
    first.recipeSha256 === second.recipeSha256 &&
    JSON.stringify(first.output) === JSON.stringify(second.output)
  );
}
