import {
  createIntelligentContentRepository,
  createStudioRoleAuthority,
  loadStudioProviderConfig,
  studioProviderReadiness,
  studioSettingsPath,
} from "@satsang/distribution-db";
import {
  STUDIO_CHANNELS,
  type StudioAsset,
  type StudioPackage,
  type StudioPublication,
  type StudioReadiness,
  studioChannelLabel,
  studioGenerationReadiness,
  studioRenderedDurationMs,
} from "@satsang/distribution-domain";
import { json, readBoundedBody, safeProblem } from "./http";
import { distributionPool } from "./runtime";
import type {
  PublicStudioAsset,
  PublicStudioPackage,
  PublicStudioPublication,
} from "./studio-model";

export function studioRepository() {
  return createIntelligentContentRepository(distributionPool(), {
    authorize: createStudioRoleAuthority(process.env),
  });
}

function publicAsset(asset: StudioAsset): PublicStudioAsset {
  return {
    filename: asset.filename,
    mimeType: asset.mimeType,
    sha256: asset.sha256,
    byteSize: asset.byteSize,
  };
}
export function publicStudioPackage(
  value: StudioPackage,
  workspaceName?: string,
): PublicStudioPackage {
  return {
    ...value,
    generationPreviews: (value.generationPreviews ?? []).map((output) => ({
      ...output,
      asset: output.asset ? publicAsset(output.asset) : null,
      ...(output.thumbnail ? { thumbnail: publicAsset(output.thumbnail) } : {}),
      captions: output.captions.map((caption) => ({
        ...caption,
        asset: publicAsset(caption.asset),
      })),
    })),
    ...(workspaceName ? { workspaceName } : {}),
    failure:
      value.failure && /^[A-Z][A-Z0-9_]{0,99}$/.test(value.failure)
        ? value.failure
        : value.failure
          ? "STUDIO_GENERATION_FAILED"
          : null,
    outputs: value.outputs.map((output) => ({
      ...output,
      asset: output.asset ? publicAsset(output.asset) : null,
      ...(output.thumbnail ? { thumbnail: publicAsset(output.thumbnail) } : {}),
      captions: output.captions.map((caption) => ({
        ...caption,
        asset: publicAsset(caption.asset),
      })),
    })),
  };
}
/** Series polling must not transfer every full recording's transcript repeatedly.
 * Detail and review endpoints still read the complete, unmodified evidence. */
export function publicStudioSummary(
  value: StudioPackage,
  workspaceName?: string,
): PublicStudioPackage {
  const result = publicStudioPackage(value, workspaceName);
  const latestReview = result.feedback.findLast((item) =>
    ["APPROVED", "REJECTED", "DISCARDED"].includes(item.action),
  );
  return {
    ...result,
    summaryOnly: true,
    provenance: null,
    feedback: result.feedback.filter(
      (item) => item === latestReview || item === result.feedback.at(-1),
    ),
    outputs: result.outputs.map((output) => {
      const {
        aiReview: _ai,
        presentationReview: _presentation,
        captionCues: _cues,
        ...file
      } = output;
      return {
        ...file,
        listedDurationMs: studioRenderedDurationMs(output),
        listedClosingHoldMs: output.presentationReview?.closingCard?.cleanHoldMs ?? 0,
        ...(output.generatedAt || !value.provenance?.generatedAt
          ? {}
          : { generatedAt: value.provenance.generatedAt }),
      };
    }),
  };
}
export function publicStudioPublication(value: StudioPublication): PublicStudioPublication {
  const { accountId: _accountId, ...result } = value;
  let remoteUrl: string | null = null;
  if (value.remoteUrl) {
    try {
      const url = new URL(value.remoteUrl);
      if (url.protocol === "https:" && !url.username && !url.password) remoteUrl = url.href;
    } catch {
      /* The publisher receipt is not a usable public URL. */
    }
  }
  return {
    ...result,
    selectedAccountId: value.accountId,
    remoteUrl,
    error:
      value.error && /^[A-Z][A-Z0-9_]{0,99}$/.test(value.error)
        ? value.error
        : value.error
          ? "STUDIO_PUBLICATION_FAILED"
          : null,
  };
}

export async function studioReadiness(context: { isTest: boolean }): Promise<StudioReadiness> {
  let channels: StudioReadiness["channels"];
  let trustedMediaOrigins: string[] = [];
  try {
    const config = await loadStudioProviderConfig(studioSettingsPath(process.env, context.isTest));
    channels = studioProviderReadiness(config, context.isTest);
    trustedMediaOrigins = config.trustedMediaOrigins;
  } catch {
    channels = STUDIO_CHANNELS.filter((channel) => channel !== "website").map((channel) => ({
      channel,
      label: studioChannelLabel(channel),
      ready: false,
      reason: "STUDIO_PROVIDER_CONFIG_INVALID",
      accountId: null,
      transport: "unconfigured",
    }));
  }
  let publicOrigin = false;
  try {
    const url = new URL(process.env.STUDIO_PUBLIC_ORIGIN ?? "");
    publicOrigin =
      url.protocol === "https:" &&
      url.origin === process.env.STUDIO_PUBLIC_ORIGIN &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password;
  } catch {
    /* No public delivery origin is configured. */
  }
  const publishing = process.env.STUDIO_PUBLISHING_ENABLED === "true";
  const mediaReady = publicOrigin && (process.env.STUDIO_MEDIA_SIGNING_SECRET?.length ?? 0) >= 32;
  // Match the publisher's exact-origin allowlist before offering a Post action.
  const mediaReason = !mediaReady
    ? "STUDIO_PUBLIC_MEDIA_NOT_CONFIGURED"
    : !trustedMediaOrigins.includes(process.env.STUDIO_PUBLIC_ORIGIN ?? "")
      ? "APPROVED_MEDIA_URL_REQUIRED"
      : null;
  channels = channels.map((channel) => {
    const reason = context.isTest
      ? "TEST_NETWORK_DISABLED"
      : !publishing
        ? "STUDIO_PUBLISHING_DISABLED"
        : (channel.reason ?? (channel.channel !== "reddit" ? mediaReason : null));
    return {
      ...channel,
      ready: reason === null,
      reason,
      accounts: (channel.accounts ?? []).map((account) => {
        const reason = context.isTest
          ? "TEST_NETWORK_DISABLED"
          : !publishing
            ? "STUDIO_PUBLISHING_DISABLED"
            : (account.reason ?? (channel.channel !== "reddit" ? mediaReason : null));
        return { ...account, ready: reason === null, reason };
      }),
    };
  });
  return {
    isTest: context.isTest,
    generation: studioGenerationReadiness(process.env),
    channels: [
      ...channels,
      {
        channel: "website",
        label: "Ashrama blog",
        ready: !context.isTest && publishing && publicOrigin,
        reason: context.isTest
          ? "TEST_NETWORK_DISABLED"
          : !publishing
            ? "STUDIO_PUBLISHING_DISABLED"
            : !publicOrigin
              ? "STUDIO_BLOG_PUBLICATION_NOT_CONFIGURED"
              : null,
        accountId: null,
        transport: "website",
      },
    ],
  };
}

export async function studioJson(request: Request): Promise<unknown> {
  try {
    return JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 1024 * 1024)));
  } catch {
    throw new Error("INVALID_REQUEST");
  }
}
export function studioProblem(error: unknown): Response {
  const code = error instanceof Error ? error.message : "";
  if (/^INVALID_STUDIO_[A-Z0-9_]{1,70}$/.test(code))
    return json({ error: code }, code === "INVALID_STUDIO_TRANSITION" ? 409 : 400);
  if (
    [
      "STUDIO_FILE_LOCKED",
      "GENERATION_REQUIRED",
      "NO_INCLUDED_OUTPUTS",
      "ASSETS_REQUIRE_REGENERATION",
      "MEDIA_REQUIRES_REGENERATION",
      "REVIEWER_ROLE_REVOKED",
      "REQUESTER_ROLE_REVOKED",
      "PUBLISHER_ROLE_REVOKED",
      "PACKAGE_CHANGED",
    ].includes(code)
  )
    return json({ error: code }, 409);
  if (
    [
      "TEACHING_INTEGRITY_CONFIRMATION_REQUIRED",
      "MACHINE_TRANSCRIPT_CONFIRMATION_REQUIRED",
    ].includes(code)
  )
    return json({ error: code }, 400);
  if (/^STUDIO_[A-Z0-9_]{1,90}$/.test(code))
    return json({ error: code }, code.includes("INVALID") || code.includes("REQUIRED") ? 400 : 409);
  return safeProblem(error);
}
