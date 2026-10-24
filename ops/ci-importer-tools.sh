#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
importer_env="${RUNNER_TEMP:?Required CI temporary directory}/studio-importer"
python3 -m venv "$importer_env"
python3 - "$root/apps/distribution-worker/src/online-import-runtime.json" "$importer_env/bin/pip" <<'PY'
import json, subprocess, sys
runtime = json.load(open(sys.argv[1]))
subprocess.check_call([sys.argv[2], "install", "--disable-pip-version-check",
    "yt-dlp[default]==" + runtime["ytDlpVersion"], "yt-dlp-ejs==" + runtime["ejsVersion"]])
PY
printf 'STUDIO_YTDLP_PATH=%s/bin/yt-dlp\n' "$importer_env" >> "${GITHUB_ENV:?}"
STUDIO_YTDLP_PATH="$importer_env/bin/yt-dlp" node --import tsx "$root/ops/check-online-import-runtime.mts"
