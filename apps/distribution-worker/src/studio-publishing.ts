import { createHash } from "node:crypto";
import { type PrivateAssetStore, signStudioMediaUrl } from "@satsang/distribution-assets";
import {
  type StudioPublicationClaim,
  type createIntelligentContentRepository,
  loadStudioProviderConfig,
  studioProviderAccountBlock,
  studioSettingsPath,
  studioYoutubeHistory,
} from "@satsang/distribution-db";
import {
  type PostingCheck,
  type StudioOutput,
  type StudioPackage,
  studioChannelPostingMatches,
  studioFileApproval,
  studioPublicationMatchesFile,
  studioPublishingFormatBlock,
} from "@satsang/distribution-domain";
import {
  type StudioProviderCheckpoint,
  type StudioProviderOutcome,
  type StudioPublicationInput,
  createSocialPlatformAdapter,
} from "./social-platform-adapters.js";

type Repository = Pick<
  ReturnType<typeof createIntelligentContentRepository>,
  | "claimPublication"
  | "revalidatePublication"
  | "completePublication"
  | "reservePublicationDestination"
  | "pausePublicationsAfterRejections"
>;
export type StudioPublishingPorts = {
  repository: Repository;
  store: Pick<PrivateAssetStore, "readDerivedDescriptor">;
  isTest: boolean;
  workerId: string;
  env: Record<string, string | undefined>;
  fetcher?: typeof fetch;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function approvalRecord(pkg: StudioPackage, output: StudioOutput) {
  if (!output.workflow) return pkg.approval;
  if (!output.workflow.approval) return null;
  // Keep the persisted approval field order for existing provider checkpoints.
  const { fingerprint: _fingerprint, ...approval } = output.workflow.approval;
  return approval;
}
function approvalId(pkg: StudioPackage, output: StudioOutput): string {
  const approval = approvalRecord(pkg, output);
  return hash({ packageId: pkg.id, revision: approval?.revision ?? pkg.revision, approval });
}
function fileContent(output: StudioOutput) {
  const { workflow: _workflow, ...content } = output;
  return content;
}
function payloadSha256(claim: StudioPublicationClaim): string {
  return hash({
    packageId: claim.package.id,
    revision: claim.publication.packageRevision,
    source: claim.package.source,
    output: fileContent(claim.output),
    approval: approvalRecord(claim.package, claim.output),
  });
}
function publicOrigin(value: string | undefined): string {
  try {
    const url = new URL(value ?? "");
    if (url.protocol === "https:" && url.origin === value && !url.username && !url.password)
      return url.origin;
  } catch {}
  throw new Error("STUDIO_PUBLIC_ORIGIN_REQUIRED");
}
function checkpoint(value: Record<string, unknown> | null): StudioProviderCheckpoint | null {
  if (value === null) return null;
  if (
    value.version !== 1 ||
    !["buffer", "reddit", "telegram"].includes(String(value.transport)) ||
    [
      value.accountId,
      value.platform,
      value.providerAccountId,
      value.publicationId,
      value.approvalId,
      value.payloadSha256,
      value.requestSha256,
      value.providerPostId,
    ].some((field) => typeof field !== "string" || !field)
  )
    throw new Error("CHECKPOINT_INVALID");
  return value as StudioProviderCheckpoint;
}

/** Claims are committed RUNNING before dispatch. Lost completion acknowledgements never cause a second send. */
export async function runStudioPublicationOnce(ports: StudioPublishingPorts): Promise<boolean> {
  const candidate = await ports.repository.claimPublication({
    isTest: ports.isTest,
    workerId: ports.workerId,
    leaseMs: 240_000,
  });
  if (!candidate) return false;
  const claim: StudioPublicationClaim = candidate;
  const deadline = Date.now() + 160_000;
  let eligibilityLost = false;
  let externalAttempted = false;
  const checkBudget = () => {
    if (Date.now() > deadline) throw new Error("PUBLICATION_TIMEOUT");
  };
  const finish = async (result: Parameters<Repository["completePublication"]>[1]) => {
    if (eligibilityLost) return;
    // A failed/lost COMMIT is itself uncertain. The lease recovery path preserves that uncertainty.
    try {
      await ports.repository.completePublication(claim, result);
    } catch {}
  };
  async function fresh(): Promise<boolean> {
    checkBudget();
    const result = await ports.repository.revalidatePublication(claim);
    if (!result.accepted) {
      eligibilityLost = true;
      return false;
    }
    const output = result.package.outputs.find(
      (entry) => entry.id === claim.output.id && entry.included,
    );
    if (
      !output ||
      result.package.isTest !== ports.isTest ||
      approvalId(result.package, output) !== approvalId(claim.package, claim.output) ||
      hash(fileContent(output)) !== hash(fileContent(claim.output)) ||
      hash(result.package.source) !== hash(claim.package.source)
    )
      throw new Error("APPROVED_PUBLICATION_CHANGED");
    return true;
  }
  try {
    if (
      claim.publication.isTest !== ports.isTest ||
      claim.package.isTest !== ports.isTest ||
      claim.publication.packageId !== claim.package.id ||
      !studioPublicationMatchesFile(claim.package, claim.output, claim.publication) ||
      claim.publication.outputId !== claim.output.id ||
      claim.publication.channel !== claim.output.channel ||
      !studioFileApproval(claim.package, claim.output) ||
      !claim.output.included
    )
      throw new Error("APPROVED_PUBLICATION_CHANGED");
    if (!(await fresh())) return true;
    if (!claim.output.asset) throw new Error("STUDIO_ASSET_REQUIRED");
    for (const asset of [
      claim.output.asset,
      ...claim.output.captions.map((caption) => caption.asset),
    ]) {
      checkBudget();
      const bytes = await ports.store.readDerivedDescriptor(asset);
      if (
        bytes.byteLength !== asset.byteSize ||
        createHash("sha256").update(bytes).digest("hex") !== asset.sha256
      )
        throw new Error("ASSET_INTEGRITY_FAILED");
      checkBudget();
    }
    if (!(await fresh())) return true;
    if (ports.isTest) {
      await finish({ status: "SIMULATED", error: "TEST_PUBLICATION_NO_EXTERNAL_SEND" });
      return true;
    }
    if (ports.env.STUDIO_PUBLISHING_ENABLED !== "true") throw new Error("PUBLISHING_DISABLED");
    if (claim.output.channel === "website") {
      if (
        claim.output.format !== "blog" ||
        claim.output.asset.mimeType !== "text/markdown" ||
        claim.checkpoint
      )
        throw new Error("INVALID_WEBSITE_PUBLICATION");
      const origin = publicOrigin(ports.env.STUDIO_PUBLIC_ORIGIN);
      if (!(await fresh())) return true;
      await finish({
        status: "PUBLISHED",
        accountId: "ashrama-website",
        remoteId: claim.publication.id,
        remoteUrl: `${origin}/distribution/blog/${claim.publication.id}`,
      });
      return true;
    }
    const formatBlock = studioPublishingFormatBlock(claim.output);
    if (formatBlock) {
      await finish({ status: "BLOCKED", error: formatBlock });
      return true;
    }
    const config = await loadStudioProviderConfig(studioSettingsPath(ports.env, false));
    const candidates = config.accounts.filter((entry) => entry.platform === claim.output.channel);
    // A queued choice is immutable. Legacy unbound jobs are safe only with one destination.
    const account = claim.publication.accountId
      ? candidates.find((entry) => entry.id === claim.publication.accountId)
      : candidates.length === 1
        ? candidates[0]
        : undefined;
    if (!account)
      throw new Error(
        claim.publication.accountId
          ? "PUBLISHING_ACCOUNT_CHANGED"
          : candidates.length > 1
            ? "STUDIO_PUBLISH_ACCOUNT_REQUIRED"
            : "CHANNEL_NOT_CONNECTED",
      );
    const accountBlock = studioProviderAccountBlock(account);
    if (accountBlock) {
      await finish({ status: "BLOCKED", accountId: account.id, error: accountBlock });
      return true;
    }
    if (claim.publication.accountId && claim.publication.accountId !== account.id)
      throw new Error("PUBLISHING_ACCOUNT_CHANGED");
    const savedCheckpoint = checkpoint(claim.checkpoint);
    if (
      savedCheckpoint &&
      (savedCheckpoint.accountId !== account.id ||
        savedCheckpoint.providerAccountId !== account.providerAccountId ||
        savedCheckpoint.platform !== account.platform ||
        savedCheckpoint.transport !== account.transport ||
        savedCheckpoint.providerPostId !== claim.publication.remoteId)
    )
      throw new Error("PUBLISHING_ACCOUNT_CHANGED");
    const kind = ["short", "reel", "video"].includes(claim.output.format)
      ? "video"
      : claim.output.asset.mimeType.startsWith("image/")
        ? "image"
        : "text";
    let media: StudioPublicationInput["media"];
    if (kind === "video" || kind === "image") {
      const expiresAt = Date.parse(claim.publication.createdAt) + 24 * 60 * 60 * 1000;
      if (
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= Date.now() ||
        expiresAt > Date.now() + 48 * 60 * 60 * 1000
      )
        throw new Error("STUDIO_MEDIA_ACCESS_EXPIRED");
      const url = signStudioMediaUrl({
        origin: publicOrigin(ports.env.STUDIO_PUBLIC_ORIGIN),
        secret: ports.env.STUDIO_MEDIA_SIGNING_SECRET ?? "",
        publicationId: claim.publication.id,
        packageId: claim.package.id,
        revision: claim.publication.packageRevision,
        outputId: claim.output.id,
        sha256: claim.output.asset.sha256,
        expiresAt,
      });
      media = { url, sha256: claim.output.asset.sha256, mimeType: claim.output.asset.mimeType };
    }
    const input: StudioPublicationInput = {
      publicationId: claim.publication.id,
      approvalId: approvalId(claim.package, claim.output),
      payloadSha256: payloadSha256(claim),
      kind,
      title: claim.output.title,
      text: claim.output.body,
      ...(media ? { media } : {}),
    };
    if (!savedCheckpoint) {
      let check: PostingCheck = {
        checkedAt: new Date().toISOString(),
        destination: `${account.platform}:${account.transport}:${account.providerAccountId}`,
        scanned: 0,
        error: null,
        matches: [],
      };
      if (account.platform === "youtube") {
        try {
          const inventory = await studioYoutubeHistory(account, ports.fetcher ?? fetch);
          check = {
            ...check,
            checkedAt: inventory.checkedAt,
            destination: inventory.destination,
            scanned: inventory.posts.length,
            matches: studioChannelPostingMatches(claim.output, inventory.posts),
          };
        } catch (error) {
          check.error =
            error instanceof Error && error.message === "STUDIO_POSTING_CHECK_INCOMPLETE"
              ? error.message
              : "STUDIO_POSTING_CHECK_UNAVAILABLE";
        }
      }
      if (!(await fresh())) return true;
      const reservation = await ports.repository.reservePublicationDestination(
        claim,
        account.id,
        check,
      );
      if (!reservation.allowed) return true;
    }
    const adapter = createSocialPlatformAdapter({
      account,
      accessToken: account.accessToken,
      fetcher: ports.fetcher ?? fetch,
      trustedMediaOrigins: config.trustedMediaOrigins,
      authorize: async () => {
        const accepted = await fresh();
        const current = await loadStudioProviderConfig(studioSettingsPath(ports.env, false));
        const currentAccount = current.accounts.find((entry) => entry.id === account.id);
        const allowed =
          accepted &&
          ports.env.STUDIO_PUBLISHING_ENABLED === "true" &&
          hash(currentAccount) === hash(account) &&
          hash(current.trustedMediaOrigins) === hash(config.trustedMediaOrigins);
        return {
          allowed,
          accountId: account.id,
          world: "PRODUCTION",
          approvalId: input.approvalId,
          payloadSha256: input.payloadSha256,
          checkedAt: new Date().toISOString(),
        };
      },
    });
    // Conservative before entering adapter: it may dispatch a mutation before a network error surfaces.
    externalAttempted = true;
    const result: StudioProviderOutcome = await adapter.advance(input, savedCheckpoint);
    if (result.kind === "PUBLISHED")
      await finish({
        status: "PUBLISHED",
        accountId: account.id,
        remoteId: result.remoteId,
        remoteUrl: result.destination,
      });
    else if (result.kind === "PROGRESS")
      await finish({
        status: "PROCESSING",
        accountId: account.id,
        remoteId: result.checkpoint.providerPostId,
        checkpoint: { ...result.checkpoint },
        retryAfterSeconds: result.retryAfterSeconds,
      });
    else if (
      result.kind === "UNKNOWN" &&
      savedCheckpoint &&
      result.checkpoint &&
      ["BUFFER_RECEIPT_UNAVAILABLE", "REDDIT_RECEIPT_UNAVAILABLE", "RECEIPT_QUERY_FAILED"].includes(
        result.code,
      )
    )
      await finish({
        status: claim.publication.attempt <= 20 ? "PROCESSING" : "UNCERTAIN",
        accountId: account.id,
        remoteId: savedCheckpoint.providerPostId,
        checkpoint: { ...savedCheckpoint },
        error: claim.publication.attempt <= 20 ? result.code : "RECEIPT_RETRY_EXHAUSTED",
        retryAfterSeconds: 30,
      });
    else {
      await finish({
        status:
          result.kind === "UNKNOWN"
            ? "UNCERTAIN"
            : result.kind === "REJECTED"
              ? "FAILED"
              : "BLOCKED",
        accountId: account.id,
        error: result.code,
        ...(result.checkpoint
          ? { checkpoint: { ...result.checkpoint }, remoteId: result.checkpoint.providerPostId }
          : {}),
      });
      // Repeated channel rejections pause the rest of this account's queue, so a
      // plan or daily upload limit is not discovered one failed post at a time.
      if (result.kind === "REJECTED" && !eligibilityLost)
        await ports.repository.pausePublicationsAfterRejections(claim, account.id).catch(() => 0);
    }
  } catch (error) {
    const known = new Set([
      "APPROVED_PUBLICATION_CHANGED",
      "STUDIO_ASSET_REQUIRED",
      "ASSET_INTEGRITY_FAILED",
      "PUBLISHING_DISABLED",
      "STUDIO_PUBLIC_ORIGIN_REQUIRED",
      "STUDIO_MEDIA_ACCESS_EXPIRED",
      "STUDIO_MEDIA_ACCESS_NOT_CONFIGURED",
      "INVALID_WEBSITE_PUBLICATION",
      "CHANNEL_NOT_CONNECTED",
      "PUBLISHING_ACCOUNT_CHANGED",
      "STUDIO_PUBLISH_ACCOUNT_REQUIRED",
      "CHECKPOINT_INVALID",
      "STUDIO_POSTING_CHECK_STALE",
      "PUBLICATION_TIMEOUT",
      "STUDIO_PROVIDER_CONFIG_INVALID",
    ]);
    const code =
      error instanceof Error && known.has(error.message)
        ? error.message
        : externalAttempted
          ? "PUBLICATION_OUTCOME_UNKNOWN"
          : "PUBLICATION_VALIDATION_FAILED";
    await finish({ status: externalAttempted ? "UNCERTAIN" : "BLOCKED", error: code });
  }
  return true;
}
