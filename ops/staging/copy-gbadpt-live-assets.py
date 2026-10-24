#!/usr/bin/env python3
"""Copy immutable GBADPT TEST media to its isolated LIVE prefix, retaining SHA-256.

Rehearsal by default. --apply repairs missing objects/checksums, never deletes data.
AWS CLI multipart copy otherwise defaults to a different checksum algorithm, which
Studio's stricter asset reader correctly rejects even when the bytes are unchanged.
"""
import base64
import concurrent.futures
import json
import re
import subprocess
import sys

BUCKET = 'datta-content-studio-staging-510724490093-ap-south-1'
REGION = 'ap-south-1'
OWNER = '510724490093'


def identity(head):
    sha = head.get('Metadata', {}).get('sha256', '')
    if not re.fullmatch(r'[0-9a-f]{64}', sha):
        raise ValueError('ASSET_DIGEST_REQUIRED')
    if head.get('ServerSideEncryption') != 'AES256' or head.get('ContentEncoding') not in (None, 'identity'):
        raise ValueError('ASSET_HEADERS_INVALID')
    return (head['ContentLength'], head['ContentType'], sha, head.get('Metadata', {}))


def valid_checksum(head):
    _, _, sha, _ = identity(head)
    value = head.get('ChecksumSHA256', '')
    if head.get('ChecksumType') == 'COMPOSITE':
        return bool(re.fullmatch(r'[A-Za-z0-9+/]{43}=-(?:[1-9][0-9]{0,3}|10000)', value))
    return head.get('ChecksumType') in (None, 'FULL_OBJECT') and value == base64.b64encode(bytes.fromhex(sha)).decode()


def repair_needed(source, destination):
    if not valid_checksum(source):
        raise ValueError('SOURCE_CHECKSUM_INVALID')
    if destination is None:
        return True
    if identity(source) != identity(destination):
        raise ValueError('DESTINATION_CONTENT_CONFLICT')
    if destination.get('ChecksumSHA256') and not valid_checksum(destination):
        raise ValueError('DESTINATION_CHECKSUM_CONFLICT')
    return not valid_checksum(destination)


def aws(*args):
    result = subprocess.run(['aws', '--region', REGION, '--no-cli-pager', *args], capture_output=True, text=True)
    if result.returncode:
        # Never expose environment configuration or raw SDK responses to logs.
        if args[0:2] == ('s3api', 'head-object') and '(404)' in result.stderr:
            return None
        raise RuntimeError('AWS_ASSET_OPERATION_FAILED')
    return json.loads(result.stdout) if result.stdout.strip() else None


def head(key):
    return aws('s3api', 'head-object', '--bucket', BUCKET, '--expected-bucket-owner', OWNER,
               '--key', key, '--checksum-mode', 'ENABLED')


def inventory():
    keys = []
    token = None
    while True:
        args = ['s3api', 'list-objects-v2', '--bucket', BUCKET, '--expected-bucket-owner', OWNER,
                '--prefix', 'test/distribution/', '--no-paginate']
        if token:
            args += ['--continuation-token', token]
        page = aws(*args)
        keys.extend(row['Key'] for row in page.get('Contents', []))
        token = page.get('NextContinuationToken')
        if not token:
            return keys


def copy_one(key, apply):
    if not key.startswith('test/distribution/') or '..' in key.split('/'):
        raise ValueError('ASSET_KEY_INVALID')
    destination = 'production/' + key[len('test/'):]
    source = head(key)
    needed = repair_needed(source, head(destination))
    if needed and apply:
        aws('s3', 'cp', f's3://{BUCKET}/{key}', f's3://{BUCKET}/{destination}',
            '--checksum-algorithm', 'SHA256', '--copy-props', 'metadata-directive',
            '--sse', 'AES256', '--only-show-errors')
        # Recheck the source stayed immutable and the destination meets the exact
        # reader contract; a generic CLI download succeeding is not sufficient.
        if head(key)['ETag'] != source['ETag'] or repair_needed(source, head(destination)):
            raise ValueError('COPIED_ASSET_VERIFICATION_FAILED')
    return int(needed)


def main():
    if sys.argv[1:] not in ([], ['--apply']):
        raise ValueError('INVALID_ARGUMENTS')
    apply = '--apply' in sys.argv
    keys = inventory()
    if not keys:
        raise ValueError('EMPTY_SOURCE_PREFIX')
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        changed = sum(pool.map(lambda key: copy_one(key, apply), keys))
    print(json.dumps({'mode': 'applied' if apply else 'rehearsal', 'objects': len(keys),
                      'checksumCopies': changed, 'deleted': 0}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        code = str(error)
        sys.exit(code if re.fullmatch(r'[A-Z_]{1,80}', code) else 'ASSET_COPY_FAILED')
