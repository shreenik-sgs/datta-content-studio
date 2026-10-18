import { describe, expect, it } from "vitest";
import { signStudioMediaUrl, verifyStudioMediaToken } from "./studio-media-access";
const now = Date.now();
const secret = "private-test-secret-".repeat(3);
const id = "11111111-1111-4111-8111-111111111111";
const claims = {
  publicationId: id,
  packageId: id,
  revision: 2,
  outputId: id,
  sha256: "a".repeat(64),
  expiresAt: now + 3600000,
};
describe("approved publication media tokens", () => {
  it("binds the exact publication, output, revision, hash and deadline", () => {
    const url = new URL(
      signStudioMediaUrl({ ...claims, origin: "https://ashrama.example", secret }),
    );
    expect(verifyStudioMediaToken(url.searchParams.get("token") ?? "", secret, now)).toEqual(
      claims,
    );
  });
  it("rejects altered signatures, wrong keys and expired media access", () => {
    const t =
      new URL(
        signStudioMediaUrl({ ...claims, origin: "https://ashrama.example", secret }),
      ).searchParams.get("token") ?? "";
    expect(verifyStudioMediaToken(`${t}x`, secret, now)).toBeNull();
    expect(verifyStudioMediaToken(t, `${secret}other`, now)).toBeNull();
    expect(verifyStudioMediaToken(t, secret, claims.expiresAt)).toBeNull();
  });
  it("refuses insecure origins and weak secrets", () => {
    expect(() =>
      signStudioMediaUrl({ ...claims, origin: "http://example.test", secret }),
    ).toThrow();
    expect(() =>
      signStudioMediaUrl({ ...claims, origin: "https://example.test", secret: "weak" }),
    ).toThrow();
  });
});
