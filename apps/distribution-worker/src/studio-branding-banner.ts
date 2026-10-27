import sharp from "sharp";

/** Facebook destination listed by Datta Peetham's official social-media directory. */
export const STUDIO_BALA_FACEBOOK_URL = "https://www.facebook.com/gurubhavana.adpt";

/** Shared channel branding; this identifies the destination channel, not a quotation's speaker. */
export async function studioBalaChannelBanner(height = 64): Promise<Buffer> {
  if (!Number.isSafeInteger(height) || height < 56 || height > 200)
    throw Error("STUDIO_BRANDING_BANNER_INVALID");
  // Keep this persistent strip quiet. The full name, portrait and calls to action
  // belong on the closing card; the footage and English captions keep priority.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="64">
    <rect width="1080" height="64" fill="#163a32"/>
    <path d="M0 0.5H1080" stroke="#acc1b0" stroke-opacity=".35"/>
    <g fill="#f3f2e9">
      <path transform="translate(95 18) scale(1.15)" d="M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073C0 18.1 4.388 23.094 10.125 24v-8.437H7.078v-3.49h3.047V9.413c0-3.025 1.792-4.697 4.533-4.697 1.312 0 2.686.235 2.686.235v2.971h-1.513c-1.49 0-1.956.93-1.956 1.885v2.266h3.328l-.532 3.49h-2.796V24C19.612 23.094 24 18.1 24 12.073z"/>
      <text x="138" y="42" font-family="sans-serif" font-size="28" font-weight="400">gurubhavana.adpt</text>
      <rect x="492" y="21" width="32" height="23" rx="6"/>
    </g>
    <path d="M438 19V45" stroke="#acc1b0" stroke-opacity=".4"/>
    <path d="M505 27L514 32.5L505 38Z" fill="#163a32"/>
    <text x="540" y="42" font-family="sans-serif" font-size="28" font-weight="400" fill="#f3f2e9">@SriDattaVijayanandaTeertha</text>
  </svg>`;
  return sharp(Buffer.from(svg)).resize(1080, height).png().toBuffer();
}
