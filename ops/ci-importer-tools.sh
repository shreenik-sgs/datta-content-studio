#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
importer_env="${RUNNER_TEMP:?Required CI temporary directory}/studio-importer"
# The renderer step installs into a private cache, not the runner's global PATH.
# yt-dlp must see that same tested FFmpeg for its own merge/preflight operations.
renderer_bin="$(dirname "${DISTRIBUTION_TEST_FFMPEG:?Run ci-renderer-tools.sh first}")"
test -x "$renderer_bin/ffmpeg"
test -x "$renderer_bin/ffprobe"
export PATH="$renderer_bin:$PATH"
printf '%s\n' "$renderer_bin" >> "${GITHUB_PATH:?}"
python3 -m venv "$importer_env"
python3 - "$root/apps/distribution-worker/src/online-import-runtime.json" "$importer_env/bin/pip" <<'PY'
import json, subprocess, sys
runtime = json.load(open(sys.argv[1]))
subprocess.check_call([sys.argv[2], "install", "--disable-pip-version-check",
    "yt-dlp[default]==" + runtime["ytDlpVersion"], "yt-dlp-ejs==" + runtime["ejsVersion"]])
PY
printf 'STUDIO_YTDLP_PATH=%s/bin/yt-dlp\n' "$importer_env" >> "${GITHUB_ENV:?}"
STUDIO_YTDLP_PATH="$importer_env/bin/yt-dlp" node --import tsx "$root/ops/check-online-import-runtime.mts"
