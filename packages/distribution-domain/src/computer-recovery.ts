/** Only the independent GBADPT staging workspace accepts this local recovery path. */
export const COMPUTER_RECOVERY_ORIGIN = "https://gbadpt.sgsdattasannidhi.org";

export function computerRecoveryEnabled(env: Record<string, string | undefined>) {
  return (
    env.STUDIO_IDENTITY === "gbadpt" &&
    env.DISTRIBUTION_HUB_STAGE === "TEST" &&
    env.DISTRIBUTION_HUB_ENABLED === "true" &&
    env.STUDIO_COMPUTER_RECOVERY_ENABLED === "true" &&
    ["http://localhost:3070", "http://127.0.0.1:3070"].includes(env.DISTRIBUTION_APP_ORIGIN ?? "")
  );
}

/** Never accept an arbitrary URL, remote host, userinfo, port or redirect destination. */
export function computerRecoveryBundle(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.origin !== COMPUTER_RECOVERY_ORIGIN ||
      url.username ||
      url.password ||
      url.pathname !== "/distribution" ||
      url.searchParams.getAll("bundle").length !== 1
    )
      return null;
    const id = url.searchParams.get("bundle") ?? "";
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
      ? id
      : null;
  } catch {
    return null;
  }
}

export const COMPUTER_RECOVERY_ERRORS: Record<string, string> = {
  RECOVERY_LOCAL_REQUIRED:
    "Open Studio on this computer at localhost:3070. Recovery must run on your computer, not on the staging server.",
  RECOVERY_NOT_CONFIGURED:
    "Local recovery is not enabled. Ask your Studio administrator to enable the local recovery service once.",
  RECOVERY_LOGIN_FAILED:
    "Staging sign-in failed. Enter your staging Studio Curator username and password, not your Google password. Repeated failed attempts may require waiting 15 minutes.",
  RECOVERY_SESSION_EXPIRED:
    "Your staging session expired. Sign in again to resume. Completed recordings will be skipped.",
  RECOVERY_FORBIDDEN:
    "A current Curator account is required in both local Studio and GBADPT staging. No content was approved or posted.",
  RECOVERY_INVALID_PLAYLIST:
    "Paste the GBADPT staging playlist workspace link, including its bundle ID. Open the playlist in staging to copy that link.",
  RECOVERY_SAVED_PLAYLIST_REQUIRED:
    "Save this playlist’s shared permissions and output settings on staging first.",
  RECOVERY_BUSY:
    "Another recovery is running on this computer. Wait for it to finish or stop it first.",
  RECOVERY_CHECKPOINT_INVALID:
    "A saved local download failed its integrity check. It has not been uploaded. Ask your administrator to inspect the recovery cache.",
  RECOVERY_INTERRUPTED:
    "Recovery was interrupted. Check your connection and resume; completed downloads and imports are retained.",
  RECOVERY_UPLOAD_FAILED:
    "Staging could not accept this recording. Your local copy is saved. Resume to retry the unfinished transfer.",
  RECOVERY_DESTINATION_MISMATCH:
    "This destination is not the GBADPT test workspace. Recovery has stopped without transferring media.",
  ONLINE_PROVIDER_VERIFICATION_REQUIRED:
    "YouTube also requires verification on this computer. Recovery cannot bypass it. Your progress is saved; upload authorized recordings if available.",
  ONLINE_SOURCE_RESTRICTED:
    "YouTube refused this recording on this computer. Recovery cannot unlock restricted media. Your other completed recordings are saved.",
  ONLINE_PROVIDER_RATE_LIMITED:
    "YouTube asked this computer to wait. Try resuming later; completed recordings will be skipped.",
  ONLINE_IMPORT_RUNTIME_OUTDATED:
    "The local downloader needs an update. Ask your Studio administrator to update it, then resume.",
  ONLINE_IMPORT_RUNTIME_INCOMPLETE:
    "The local downloader or one of its required components is unavailable. Ask your Studio administrator to repair the local service.",
  RECOVERY_STORAGE_UNAVAILABLE:
    "This computer could not save the recording. Check available disk space and the recovery folder’s permissions, then resume.",
};
