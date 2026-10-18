/** Optional analytics is controlled within this application. */
export async function analyticsEnabled(_request: Request): Promise<boolean> {
  return process.env.STUDIO_ANALYTICS_ENABLED === "true";
}
