#!/bin/bash
# Run through SSM on this application's dedicated staging host only.
set -euo pipefail
umask 077
: "${STUDIO_DATA_VOLUME:?Required retained Content Studio volume ID}"
test -f /opt/content-studio/bootstrap-complete
serial="${STUDIO_DATA_VOLUME//-/}"
device=""
for candidate in /dev/nvme*n1; do
  found=$(lsblk -dn -o SERIAL "$candidate" | tr -d ' ')
  if [ "$found" = "$serial" ]; then device="$candidate"; fi
done
test -n "$device"
mkdir -p /srv/content-studio
if ! blkid "$device" >/dev/null; then mkfs.xfs "$device"; fi
test "$(blkid -s TYPE -o value "$device")" = xfs
uuid=$(blkid -s UUID -o value "$device")
if ! grep -q "UUID=$uuid " /etc/fstab; then
  printf 'UUID=%s /srv/content-studio xfs defaults,nofail 0 2\n' "$uuid" >> /etc/fstab
fi
mountpoint -q /srv/content-studio || mount /srv/content-studio
mkdir -p /srv/content-studio/{postgres,config,scratch,transcripts,caddy,backups}
chown 1000:1000 /srv/content-studio/{scratch,transcripts}
chmod 700 /srv/content-studio/config
# Swap is bounded insurance for a one-time image build, never a database resize.
if [ ! -e /srv/content-studio/build.swap ]; then
  dd if=/dev/zero of=/srv/content-studio/build.swap bs=1M count=4096 status=none
  chmod 600 /srv/content-studio/build.swap
  mkswap /srv/content-studio/build.swap >/dev/null
fi
swapon --show=NAME --noheadings | grep -q '/srv/content-studio/build.swap' || swapon /srv/content-studio/build.swap
grep -q '/srv/content-studio/build.swap ' /etc/fstab || printf '/srv/content-studio/build.swap none swap sw 0 0\n' >> /etc/fstab
