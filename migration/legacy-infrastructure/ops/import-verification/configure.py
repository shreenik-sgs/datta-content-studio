#!/usr/bin/env python3
"""Configure a provisioned importer and write a nonsecret release manifest. Never print secrets."""
import base64
import json
import os
import pathlib
import secrets
import subprocess
import sys
import tempfile


def aws(*args):
    return json.loads(subprocess.check_output(['aws', '--profile', 'mfa', '--region', 'ap-south-1', *args, '--output', 'json']))


def configure(env, evidence):
    if env not in ('staging', 'production'):
        raise ValueError('Unknown environment')
    stack = aws('cloudformation', 'describe-stacks', '--stack-name', 'SgsDattaSannidhiImportRecovery-' + env)['Stacks'][0]
    if stack['StackStatus'] not in ('CREATE_COMPLETE', 'UPDATE_COMPLETE'):
        raise ValueError('Host stack must complete first')
    outputs = {row['OutputKey']: row['OutputValue'] for row in stack['Outputs']}
    secret_arn = outputs['ConfigSecret']
    prior = json.loads(aws('secretsmanager', 'get-secret-value', '--secret-id', secret_arn)['SecretString'])
    images = json.loads((evidence / 'release-images.json').read_text())['images']
    task = json.loads((evidence / (env + '-hub-studio-task.json')).read_text())
    source = {row['name']: row['value'] for row in task['containerDefinitions'][0]['environment']}
    keys = ['NODE_ENV', 'DEPLOY_ENV', 'DISTRIBUTION_HUB_ENABLED', 'DISTRIBUTION_HUB_STAGE', 'STUDIO_DESTINATION_ORIGIN', 'STUDIO_CORE_ORIGIN', 'STUDIO_WORKER_ENABLED', 'STUDIO_WORKER_AUTHORIZATION_ENABLED', 'DISTRIBUTION_ASSET_BACKEND', 'DISTRIBUTION_S3_BUCKET', 'DISTRIBUTION_S3_REGION', 'DISTRIBUTION_S3_EXPECTED_BUCKET_OWNER', 'DISTRIBUTION_S3_PREFIX']
    environment = {key: source[key] for key in keys}
    environment.update({'STUDIO_WORKER_MODE': 'imports', 'STUDIO_PUBLISHING_ENABLED': 'false',
                        'STUDIO_IMPORT_VERIFICATION_ENABLED': 'true', 'STUDIO_IMPORT_VERIFICATION_HOST': '0.0.0.0',
                        'STUDIO_IMPORT_VERIFICATION_PORT': '3073', 'STUDIO_HEALTH_PORT': '3072'})
    host = outputs['PrivateDns']
    if not host.endswith('.compute.internal'):
        raise ValueError('Private AWS hostname required')
    if prior.get('hostname') == host and prior.get('certificate') and prior.get('privateKey'):
        certificate, private_key = prior['certificate'], prior['privateKey']
    else:
        with tempfile.TemporaryDirectory(prefix='sgs-importer-tls-') as directory:
            key_path = pathlib.Path(directory) / 'key.pem'
            cert_path = pathlib.Path(directory) / 'cert.pem'
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
                            '-keyout', str(key_path), '-out', str(cert_path), '-subj', '/CN=' + host,
                            '-addext', 'subjectAltName=DNS:' + host + ',IP:' + outputs['PrivateIp']],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            certificate = base64.b64encode(cert_path.read_bytes()).decode()
            private_key = base64.b64encode(key_path.read_bytes()).decode()
    config = {'ready': False, 'hostname': host, 'image': images['distribution-studio-verification'],
              'environment': environment, 'key': prior.get('key') or secrets.token_hex(32),
              'certificate': certificate, 'privateKey': private_key}
    # Activation is a separate explicit step after the previous downloader has stopped.
    with tempfile.NamedTemporaryFile(mode='w', prefix='sgs-importer-config-', delete=False) as handle:
        os.chmod(handle.name, 0o600)
        json.dump(config, handle)
        name = handle.name
    try:
        aws('secretsmanager', 'put-secret-value', '--secret-id', secret_arn, '--secret-string', 'file://' + name)
    finally:
        pathlib.Path(name).unlink(missing_ok=True)
    manifest = {'environment': env, 'instanceId': outputs['InstanceId'], 'configSecret': secret_arn,
                'origin': 'https://' + host + ':3073', 'certificate': certificate,
                'webImage': images['distribution-web'], 'studioImage': images['distribution-studio'],
                'importerImage': images['distribution-studio-verification']}
    (evidence / (env + '-release.json')).write_text(json.dumps(manifest, indent=2))
    print(env + ': private TLS configured; importer remains inactive pending application rollout.')


if __name__ == '__main__':
    configure(sys.argv[1], pathlib.Path(sys.argv[2]))
