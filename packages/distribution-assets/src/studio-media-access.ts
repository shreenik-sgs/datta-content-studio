import { createHmac, timingSafeEqual } from "node:crypto";
export type StudioMediaClaims = {
  publicationId: string;
  packageId: string;
  revision: number;
  outputId: string;
  sha256: string;
  expiresAt: number;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function valid(c: StudioMediaClaims) {
  return (
    [c.publicationId, c.packageId, c.outputId].every(
      (v) => typeof v === "string" && uuid.test(v),
    ) &&
    Number.isSafeInteger(c.revision) &&
    c.revision > 0 &&
    /^[a-f0-9]{64}$/.test(c.sha256) &&
    Number.isSafeInteger(c.expiresAt)
  );
}
export function signStudioMediaUrl(
  input: StudioMediaClaims & { origin: string; secret: string },
): string {
  const origin = new URL(input.origin);
  if (
    input.secret.length < 32 ||
    origin.protocol !== "https:" ||
    origin.origin !== input.origin ||
    origin.username ||
    origin.password ||
    !valid(input)
  )
    throw new Error("STUDIO_MEDIA_ACCESS_NOT_CONFIGURED");
  const claims: StudioMediaClaims = {
    publicationId: input.publicationId,
    packageId: input.packageId,
    revision: input.revision,
    outputId: input.outputId,
    sha256: input.sha256,
    expiresAt: input.expiresAt,
  };
  const value = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = createHmac("sha256", input.secret).update(value).digest("base64url");
  return `${origin.origin}/distribution/api/studio/publications/${input.publicationId}/media?token=${value}.${sig}`;
}
export function verifyStudioMediaToken(
  token: string,
  secret: string,
  now = Date.now(),
): StudioMediaClaims | null {
  if (secret.length < 32 || token.length > 2000) return null;
  const parts = token.split(".");
  if (
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))
  )
    return null;
  const signature = Buffer.from(parts[1], "base64url");
  const expected = createHmac("sha256", secret).update(parts[0]).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
  try {
    const claims = JSON.parse(
      Buffer.from(parts[0], "base64url").toString("utf8"),
    ) as StudioMediaClaims;
    return valid(claims) && claims.expiresAt > now && claims.expiresAt <= now + 48 * 3600000
      ? claims
      : null;
  } catch {
    return null;
  }
}
