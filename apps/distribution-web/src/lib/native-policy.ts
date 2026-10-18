export async function nativePolicy(_request: Request): Promise<Record<string, boolean>> {
  const enabled = process.env.STUDIO_NATIVE_ANALYSIS_ENABLED === "true";
  return Object.fromEntries(
    [
      "native_language_intelligence",
      "teaching_integrity_engine",
      "native_semantic_shadow",
      "native_clip_candidates",
      "native_glossary",
      "native_language_review",
    ].map((key) => [key, enabled]),
  );
}
export function nativeFeature(flags: Record<string, boolean>, key: string) {
  return flags.native_language_intelligence === true && flags[key] === true;
}
