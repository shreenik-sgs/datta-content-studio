/** A rule the Studio learned from one of its own rejected image reviews or a curator's rejection.
 * Active rules shape every later brief, image generation and review, so the same defect is not
 * discovered again one file at a time. Admins see, and may retire, every rule. */
export type StudioVisualLesson = {
  id: string;
  rule: string;
  scope: StudioVisualLessonScope;
  source: "IMAGE_REVIEW" | "CURATOR";
  sourceReason: string;
  packageId: string | null;
  hits: number;
  status: "ACTIVE" | "RETIRED";
  createdAt: string;
  updatedAt: string;
};
export const STUDIO_VISUAL_LESSON_SCOPES = [
  "iconography",
  "anatomy",
  "composition",
  "style",
  "continuity",
  "text",
] as const;
export type StudioVisualLessonScope = (typeof STUDIO_VISUAL_LESSON_SCOPES)[number];
export const STUDIO_VISUAL_LESSON_POLICY = "learned-visual-rules-v1" as const;
/** Bounded prompt budget: the newest and most-hit rules first. */
export const STUDIO_VISUAL_LESSON_LIMIT = 40;
export const STUDIO_VISUAL_LESSON_TEXT_LIMIT = 6000;

export function validateStudioVisualLessonRule(rule: unknown): string {
  if (
    typeof rule !== "string" ||
    rule.trim().length < 12 ||
    rule.length > 400 ||
    [...rule].some((c) => c.charCodeAt(0) < 32)
  )
    throw Error("INVALID_VISUAL_LESSON");
  return rule.trim();
}
/** The learned rules as one ordered, bounded block of prompt text; empty when there are none. */
export function studioVisualLessonsText(lessons: readonly StudioVisualLesson[]): string {
  const active = lessons
    .filter((l) => l.status === "ACTIVE")
    .sort((a, b) => b.hits - a.hits || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, STUDIO_VISUAL_LESSON_LIMIT);
  const lines: string[] = [];
  let length = 0;
  for (const [i, lesson] of active.entries()) {
    const line = `${i + 1}. [${lesson.scope}] ${lesson.rule}`;
    if (length + line.length + 1 > STUDIO_VISUAL_LESSON_TEXT_LIMIT) break;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.length
    ? `Rules this Studio learned from its own earlier rejected images (apply every one of them):\n${lines.join("\n")}`
    : "";
}
