export const STUDIO_PRODUCT_NAME = "Datta Media Studio";

const identities = {
  gbadpt: {
    organization: "Guru Bhavana",
    logo: "/distribution/brand/sri-bala-swamiji-portrait.jpg",
    logoAlt: "Sri Datta Vijayananda Teertha Swamiji",
  },
  dp: {
    organization: "Datta Peetham",
    logo: "/distribution/brand/sgsswamiji-channel-avatar.jpg",
    logoAlt: "Sri Ganapathy Sachchidananda Swamiji",
  },
} as const;

/** Deployment branding only. Each studio must still have its own database and storage. */
export function studioIdentity(env: Record<string, string | undefined> = process.env) {
  const configured = env.STUDIO_IDENTITY?.trim();
  let hostname: string | undefined;
  try {
    hostname = new URL(env.DISTRIBUTION_APP_ORIGIN ?? "").hostname;
  } catch {
    // Origin validation and authentication remain the responsibility of the auth boundary.
  }
  const hostedIdentity =
    hostname === "gbadpt.sgsdattasannidhi.org"
      ? "gbadpt"
      : hostname === "dp.sgsdattasannidhi.org"
        ? "dp"
        : undefined;
  if (configured && configured !== "gbadpt" && configured !== "dp")
    throw Error("STUDIO_IDENTITY must be gbadpt or dp.");
  if (configured && hostedIdentity && configured !== hostedIdentity)
    throw Error("STUDIO_IDENTITY does not match the configured studio origin.");
  const id = configured === "gbadpt" || configured === "dp" ? configured : hostedIdentity;
  return id ? { id, ...identities[id] } : { id: null, organization: null, logo: null, logoAlt: "" };
}
