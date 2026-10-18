export const STUDIO_BRAND_NAME = "Sri Ganapathy Sachchidananda Swamiji";
export const STUDIO_BRAND_SIGNATURE = "@sgsswamiji";
/** Explicit curator-selected identity; neither transcript nor AI may choose a different speaker. */
export type StudioSourceBranding = "bala-swamiji";
export function studioSourceBranding(profile?: StudioSourceBranding): {
  name: string;
  signature: string;
  portrait: boolean;
} {
  if (profile === undefined)
    return { name: STUDIO_BRAND_NAME, signature: STUDIO_BRAND_SIGNATURE, portrait: true };
  if (profile === "bala-swamiji")
    return {
      name: "Sri Datta Vijayananda Teertha Swamiji",
      signature: "@gurubhavanaadpt",
      portrait: false,
    };
  throw Error("INVALID_STUDIO_SOURCE_BRANDING");
}
