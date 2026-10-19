import { STUDIO_SINGLE_TRANSCRIPTION_MS } from "@satsang/distribution-domain";
import { type SarvamJobCheckpoint, transcribeSarvamStudioAudio } from "./studio-sarvam";
import { transcribeStudioSections } from "./studio-transcription-sections";

/** Only a confirmed terminal capacity failure permits new, smaller paid jobs. */
export async function transcribeAdaptiveSarvam(
  input: Parameters<typeof transcribeStudioSections>[0] & {
    audio: () => Promise<Uint8Array>;
  },
) {
  const { checkpoints, fingerprint } = input;
  const capacityLimited = checkpoints?.get<boolean>("sarvam-capacity-fallback", fingerprint);
  if (input.durationMs > STUDIO_SINGLE_TRANSCRIPTION_MS || capacityLimited)
    return transcribeStudioSections({ ...input, capacityLimited });
  try {
    return await transcribeSarvamStudioAudio({
      ...input.provider,
      durationMs: input.durationMs,
      bytes: await input.audio(),
      ...(checkpoints
        ? {
            recovery: {
              saved: checkpoints.get<SarvamJobCheckpoint>("sarvam-job", fingerprint),
              save: (value: SarvamJobCheckpoint) =>
                checkpoints.set("sarvam-job", fingerprint, value),
            },
          }
        : {}),
    });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "STUDIO_TRANSCRIPTION_CONTEXT_LIMIT" ||
      input.durationMs <= 30000
    )
      throw error;
    await checkpoints?.set("sarvam-capacity-fallback", fingerprint, true);
    return transcribeStudioSections({ ...input, capacityLimited: true });
  }
}
