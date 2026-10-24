"""Check official package metadata; never install or deploy from the scheduled check."""
import json
import pathlib
import urllib.request

root = pathlib.Path(__file__).resolve().parent.parent
runtime = json.loads((root / "apps/distribution-worker/src/online-import-runtime.json").read_text())
outdated = False
for package, key in [("yt-dlp", "ytDlpVersion"), ("yt-dlp-ejs", "ejsVersion")]:
    request = urllib.request.Request(f"https://pypi.org/pypi/{package}/json")
    with urllib.request.urlopen(request, timeout=30) as response:
        latest = json.load(response)["info"]["version"]
    pinned = runtime[key]
    newer = tuple(map(int, latest.split("."))) > tuple(map(int, pinned.split(".")))
    print(f"{package}: pinned {pinned}, latest {latest}")
    if newer:
        outdated = True
        print(f"::error::{package} update available. Review release notes, update the runtime manifest, run CI and staging import checks before deploying.")
raise SystemExit(1 if outdated else 0)
