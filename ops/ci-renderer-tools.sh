#!/usr/bin/env bash
set -euo pipefail
# Ubuntu's bundled FFmpeg predates the seekable fd: protocol used by the renderer.
# Build a pinned, checksummed release; never weaken the renderer's file boundary.
renderer_root="${RUNNER_TEMP:?}/sgs-ffmpeg"
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends build-essential pkg-config nasm libx264-dev libmp3lame-dev libfreetype6-dev libharfbuzz-dev libfontconfig1-dev libass-dev libwebp-dev fonts-noto-core
mkdir -p "$renderer_root"
if [ ! -x "$renderer_root/install/bin/ffmpeg" ]; then
curl --fail --location --retry 3 https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz -o "$renderer_root/source.tar.xz"
printf '%s  %s\n' 733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1 "$renderer_root/source.tar.xz" | sha256sum --check -
tar -xJf "$renderer_root/source.tar.xz" -C "$renderer_root"
cd "$renderer_root/ffmpeg-7.1.1"
./configure --prefix="$renderer_root/install" --disable-doc --disable-debug --enable-gpl --enable-libx264 --enable-libmp3lame --enable-libfreetype --enable-libfontconfig --enable-libass --enable-libwebp > "$renderer_root/configure.log"
make -j2 > "$renderer_root/build.log" 2>&1
make install > "$renderer_root/install.log" 2>&1
fi
"$renderer_root/install/bin/ffmpeg" -hide_banner -protocols 2>&1 | grep -q ' fd'
{
  echo "DISTRIBUTION_TEST_FFMPEG=$renderer_root/install/bin/ffmpeg"
  echo "DISTRIBUTION_TEST_FFPROBE=$renderer_root/install/bin/ffprobe"
} >> "${GITHUB_ENV:?}"
