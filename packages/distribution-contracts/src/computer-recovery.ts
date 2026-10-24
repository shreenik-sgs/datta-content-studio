import { z } from "zod";

export const computerRecoveryActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }).strict(),
  z.object({ action: z.literal("stop") }).strict(),
  z
    .object({
      action: z.literal("start"),
      username: z.string().trim().min(1).max(254),
      password: z.string().min(1).max(256),
    })
    .strict(),
]);
export type ComputerRecoveryAction = z.infer<typeof computerRecoveryActionSchema>;
export const computerRecoveryEnvelopeSchema = z
  .object({
    version: z.literal(1),
    userId: z.string().min(1).max(250),
    isTest: z.boolean(),
    roles: z.array(z.string().max(80)).max(40),
    importId: z.string().uuid(),
    requestedAt: z.number().int(),
    requestId: z.string().uuid(),
    command: computerRecoveryActionSchema,
  })
  .strict();
export type ComputerRecoveryState = {
  status: "IDLE" | "RUNNING" | "STOPPING" | "PAUSED" | "COMPLETE" | "FAILED";
  title?: string;
  recordings: number;
  completed: number;
  currentTitle?: string | undefined;
  phase?: "connecting" | "checking" | "downloading" | "uploading" | undefined;
  error?: string | undefined;
};
