/** Source-language assignments are separate from the Content Approver role. */
export const REVIEWER_LANGUAGES = {
  en: "English",
  hi: "Hindi",
  te: "Telugu",
  kn: "Kannada",
  ta: "Tamil",
  ml: "Malayalam",
  gu: "Gujarati",
  sa: "Sanskrit",
} as const;
export type ReviewerLanguage = keyof typeof REVIEWER_LANGUAGES;

/** Existing native-source policy; adding account settings does not change that policy. */
export function sourceRequiresLanguageAssignment(language: string) {
  return ["te", "kn", "ta"].includes(language);
}
export function reviewerLanguageBlocker(language: string, assigned: readonly string[]) {
  if (!sourceRequiresLanguageAssignment(language) || assigned.includes(language)) return null;
  const label = REVIEWER_LANGUAGES[language as ReviewerLanguage] ?? language;
  return `Your Approver account is not assigned to review ${label}. Ask an Admin to open Settings → Reviewer languages and assign ${label} after confirming your proficiency.`;
}
