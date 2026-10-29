#!/bin/bash
set -euo pipefail
umask 077
database=$(python3 /opt/content-studio/runtime-database.py /srv/content-studio/config/runtime.env)
# runtime-database.py has just proved the bucket belongs to this installation.
bucket=$(grep -x 'DISTRIBUTION_S3_BUCKET=datta-content-studio-[a-z]*-510724490093-ap-south-1' /srv/content-studio/config/runtime.env | cut -d= -f2)
test -n "$bucket"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="/srv/content-studio/backups/$database-$stamp.dump"
docker exec dcs-staging-db pg_dump -U studio_owner -d "$database" -Fc > "$target"
test -s "$target"
aws s3 cp "$target" "s3://$bucket/backups/$database-$stamp.dump" --region ap-south-1 --sse AES256 --only-show-errors
# Keep a week locally; versioned S3 backups remain retained.
find /srv/content-studio/backups -name '*.dump' -mtime +7 -delete
