#!/usr/bin/env python3
"""Validate the isolated GBADPT deployment; emit only its non-secret database name."""
import sys
from pathlib import Path
from urllib.parse import urlparse


def database_for_runtime(env):
    origin = env.get('DISTRIBUTION_APP_ORIGIN')
    stage = env.get('DISTRIBUTION_HUB_STAGE')
    if origin not in ('https://gbadpt.sgsdattasannidhi.org', 'https://studio-staging.sgsdattasannidhi.org'):
        raise ValueError('STUDIO_ORIGIN_MISMATCH')
    url = urlparse(env.get('DISTRIBUTION_DATABASE_URL', ''))
    if url.hostname != '127.0.0.1':
        raise ValueError('STUDIO_DATABASE_HOST_MISMATCH')
    if stage == 'TEST':
        database, prefix, publishing = 'datta_content_studio_staging', 'test/', 'false'
    elif stage == 'ON' and origin == 'https://gbadpt.sgsdattasannidhi.org' and env.get('STUDIO_IDENTITY') == 'gbadpt':
        database, prefix, publishing = 'datta_content_studio_gbadpt_live', 'production/', 'true'
    else:
        raise ValueError('STUDIO_MODE_MISMATCH')
    if url.path != '/' + database or env.get('DISTRIBUTION_S3_PREFIX') != prefix or env.get('STUDIO_PUBLISHING_ENABLED') != publishing:
        raise ValueError('STUDIO_WORLD_MISMATCH')
    if env.get('DISTRIBUTION_S3_BUCKET') != 'datta-content-studio-staging-510724490093-ap-south-1':
        raise ValueError('STUDIO_BUCKET_MISMATCH')
    return database


if __name__ == '__main__':
    try:
        env = {}
        for line in Path(sys.argv[1]).read_text().splitlines():
            if not line or line.startswith('#'):
                continue
            name, separator, value = line.partition('=')
            if not separator or name in env:
                raise ValueError('INVALID_RUNTIME_FILE')
            env[name] = value
        print(database_for_runtime(env))
    except Exception:
        sys.exit('Studio runtime validation failed; no configuration values were printed.')
