/** Match the owner-approved speech level while retaining headroom for AAC encoding. */
export const STUDIO_AUDIO_POLICY = {
  id: "measured-speech-v1",
  integratedLufs: -22,
  truePeakDbtp: -2,
  loudnessRange: 11,
  toleranceLufs: 1,
  maximumTruePeakDbtp: -1,
} as const;

export function validateStudioAudioLevel(integratedLufs: number, truePeakDbtp: number): void {
  if (
    !Number.isFinite(integratedLufs) ||
    !Number.isFinite(truePeakDbtp) ||
    Math.abs(integratedLufs - STUDIO_AUDIO_POLICY.integratedLufs) >
      STUDIO_AUDIO_POLICY.toleranceLufs ||
    truePeakDbtp > STUDIO_AUDIO_POLICY.maximumTruePeakDbtp
  )
    throw Error("STUDIO_AUDIO_QUALITY_FAILED");
}
