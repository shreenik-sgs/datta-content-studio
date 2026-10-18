import { z } from "zod";
const session = { sessionId: z.string().uuid() };
export const importVerificationActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }).strict(),
  z.object({ action: z.literal("status"), ...session }).strict(),
  z.object({ action: z.literal("check"), ...session }).strict(),
  z.object({ action: z.literal("cancel"), ...session }).strict(),
  z
    .object({
      action: z.literal("click"),
      ...session,
      x: z.number().int().min(0).max(1023),
      y: z.number().int().min(0).max(767),
    })
    .strict(),
  z
    .object({
      action: z.literal("key"),
      ...session,
      key: z.enum([
        "Enter",
        "Tab",
        "Shift+Tab",
        "Backspace",
        "Delete",
        "Escape",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "Space",
      ]),
    })
    .strict(),
  z.object({ action: z.literal("text"), ...session, text: z.string().min(1).max(256) }).strict(),
  z
    .object({ action: z.literal("scroll"), ...session, delta: z.number().int().min(-768).max(768) })
    .strict(),
]);
export type ImportVerificationAction = z.infer<typeof importVerificationActionSchema>;
export const importVerificationEnvelopeSchema = z
  .object({
    version: z.literal(1),
    userId: z.string().min(1).max(250),
    isTest: z.boolean(),
    roles: z.array(z.string().max(80)).max(40),
    importId: z.string().uuid(),
    requestedAt: z.number().int(),
    requestId: z.string().uuid(),
    command: importVerificationActionSchema,
  })
  .strict();
export type ImportVerificationEnvelope = z.infer<typeof importVerificationEnvelopeSchema>;
export type ImportVerificationState = {
  sessionId: string;
  status: "OPEN" | "CHECKING" | "VERIFIED" | "FAILED" | "CLOSED";
  expiresAt: string;
  /** Redacted location: origin only, never OAuth queries or challenge tokens. */
  origin?: string;
  image?: string;
  error?: string;
};
