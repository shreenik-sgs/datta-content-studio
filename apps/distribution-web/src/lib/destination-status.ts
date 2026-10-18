import {
  canonicalDestinationEvidenceSchema,
  destinationEvidenceSchema,
} from "@satsang/distribution-contracts";
import { trustedDistributionOrigin } from "./auth";
import { access } from "./runtime";
async function check(request: Request, paths: readonly string[], version: 1 | 2) {
  const auth = await access(request);
  if (!auth.ok || !auth.context.isTest) throw new Error("FORBIDDEN");
  const origin = trustedDistributionOrigin(process.env.STUDIO_DESTINATION_ORIGIN);
  const key = process.env.DISTRIBUTION_DESTINATION_KEY;
  if (
    !origin ||
    !key ||
    paths.length < 1 ||
    paths.length > 2 ||
    new Set(paths).size !== paths.length
  )
    throw new Error("DESTINATION_UNAVAILABLE");
  const response = await fetch(`${origin}/api/v1/destination-status`, {
    method: "POST",
    redirect: "error",
    cache: "no-store",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(version === 1 ? { paths } : { version, paths }),
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error("DESTINATION_UNAVAILABLE");
  const body = await response.text();
  if (body.length > 8192) throw new Error("DESTINATION_UNAVAILABLE");
  const result =
    version === 1
      ? destinationEvidenceSchema.parse(JSON.parse(body))
      : canonicalDestinationEvidenceSchema.parse(JSON.parse(body));
  if (
    result.results.length !== paths.length ||
    result.results.some((item) => !paths.includes(item.path)) ||
    Math.abs(Date.now() - Date.parse(result.checkedAt)) > 10000
  )
    throw new Error("DESTINATION_UNAVAILABLE");
  return result;
}
export async function checkDistributionDestinations(request: Request, paths: readonly string[]) {
  const result = await check(request, paths, 1);
  if (result.version !== 1) throw new Error("DESTINATION_UNAVAILABLE");
  return result;
}
export async function checkDistributionCanonicalDestinations(
  request: Request,
  paths: readonly string[],
) {
  const result = await check(request, paths, 2);
  if (result.version !== 2) throw new Error("DESTINATION_UNAVAILABLE");
  return result;
}
export async function socialPackageEnabled(request: Request): Promise<boolean> {
  try {
    const evidence = await checkDistributionCanonicalDestinations(request, ["/explore"]);
    return evidence.flags.tracked_social_deep_links && evidence.flags.universal_content_landing;
  } catch {
    return false;
  }
}
