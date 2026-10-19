#!/bin/bash
set -euo pipefail
umask 077
bucket=datta-content-studio-staging-510724490093-ap-south-1
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="/srv/content-studio/backups/$stamp.dump"
docker exec dcs-staging-db pg_dump -U studio_owner -d datta_content_studio_staging -Fc > "$target"
test -s "$target"
aws s3 cp "$target" "s3://$bucket/backups/$stamp.dump" --region ap-south-1 --sse AES256 --only-show-errors
# Keep a week locally; versioned S3 backups remain retained.
find /srv/content-studio/backups -name '*.dump' -mtime +7 -delete
