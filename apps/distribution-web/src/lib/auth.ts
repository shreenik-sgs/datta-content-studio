import { readStudioSession } from "@satsang/distribution-db";
import {
  distributionGate,
  isDistributionOperator,
  normalizeDistributionStage,
} from "@satsang/distribution-domain";
export function trustedDistributionOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      url.origin !== value ||
      url.username ||
      url.password ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}
export const STUDIO_SESSION_COOKIE = "dcs_session";
export function studioSessionToken(request: Request): string | null {
  const cookies = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((x) => x.trim())
    .filter((x) => x.startsWith(`${STUDIO_SESSION_COOKIE}=`));
  if (cookies.length !== 1) return null;
  const token = (cookies[0] ?? "").slice(STUDIO_SESSION_COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}
export function validStudioMutationOrigin(
  request: Request,
  appOrigin = process.env.DISTRIBUTION_APP_ORIGIN,
) {
  return !!trustedDistributionOrigin(appOrigin) && request.headers.get("origin") === appOrigin;
}
export async function distributionHubPolicyEnabled(_options: unknown = {}) {
  return (
    process.env.DISTRIBUTION_HUB_ENABLED === "true" &&
    normalizeDistributionStage(process.env.DISTRIBUTION_HUB_STAGE) !== "OFF"
  );
}
export async function verifyDistributionOperator(
  request: Request,
  options: { featureEnabled: boolean; stage: string | undefined; appOrigin: string | undefined },
) {
  const fail = (status: 401 | 403 | 404 | 503, error: string) => ({
    ok: false as const,
    status,
    error,
  });
  if (!options.featureEnabled || normalizeDistributionStage(options.stage) === "OFF")
    return fail(404, "feature_unavailable");
  const token = studioSessionToken(request);
  if (!token) return fail(401, "sign_in_required");
  if (
    !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
    !validStudioMutationOrigin(request, options.appOrigin)
  )
    return fail(403, "invalid_origin");
  try {
    const identity = await readStudioSession(token);
    if (!identity) return fail(401, "sign_in_required");
    if (
      identity.isTest !== (normalizeDistributionStage(options.stage) === "TEST") ||
      !distributionGate({
        featureEnabled: options.featureEnabled,
        stage: options.stage,
        audience: { isOperator: isDistributionOperator(identity.roles), isTest: identity.isTest },
      })
    )
      return fail(403, "operator_required");
    return { ok: true as const, identity };
  } catch {
    return fail(503, "identity_unavailable");
  }
}
