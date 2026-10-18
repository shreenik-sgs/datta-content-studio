#!/usr/bin/env python3
"""Activate the private importer only after the previous downloader has drained."""
import json
import os
import pathlib
import subprocess
import sys
import tempfile


def aws(*args):
    result = subprocess.run(
        ['aws', '--profile', 'mfa', '--region', 'ap-south-1', *args, '--output', 'json'],
        capture_output=True, text=True,
    )
    if result.returncode:
        raise RuntimeError('AWS operation failed: ' + args[0] + '/' + args[1])
    return json.loads(result.stdout)


def activate(environment, evidence):
    if environment not in ('staging', 'production'):
        raise ValueError('Unknown environment')
    release = json.loads((evidence / (environment + '-release.json')).read_text())
    if release['environment'] != environment:
        raise ValueError('Release belongs to another environment')
    cluster = 'sgsdattasannidhi-' + environment
    service = aws('ecs', 'describe-services', '--cluster', cluster, '--services', 'hub-studio')['services'][0]
    deployments = service['deployments']
    if (len(deployments) != 1 or deployments[0]['rolloutState'] != 'COMPLETED'
            or service['runningCount'] != service['desiredCount'] or service['pendingCount']):
        raise ValueError('Studio must finish rolling out before importer activation')
    definition = aws('ecs', 'describe-task-definition', '--task-definition', service['taskDefinition'])['taskDefinition']
    studio = next(c for c in definition['containerDefinitions'] if c['name'] == 'hub-studio')
    settings = {row['name']: row['value'] for row in studio['environment']}
    if studio['image'] != release['studioImage'] or settings.get('STUDIO_WORKER_MODE') != 'generation':
        raise ValueError('Studio must use the tested generation-only release')
    tasks = aws('ecs', 'list-tasks', '--cluster', cluster, '--service-name', 'hub-studio')['taskArns']
    if not tasks:
        raise ValueError('Studio is not running')
    running = aws('ecs', 'describe-tasks', '--cluster', cluster, '--tasks', *tasks)['tasks']
    if any(t['taskDefinitionArn'] != service['taskDefinition'] for t in running):
        raise ValueError('The previous importer must drain first')
    stack = aws('cloudformation', 'describe-stacks', '--stack-name', 'SgsDattaSannidhiImportRecovery-' + environment)['Stacks'][0]
    if stack['StackStatus'] not in ('CREATE_COMPLETE', 'UPDATE_COMPLETE'):
        raise ValueError('Importer infrastructure is not stable')
    outputs = {row['OutputKey']: row['OutputValue'] for row in stack['Outputs']}
    if outputs['InstanceId'] != release['instanceId'] or release['origin'] != 'https://' + outputs['PrivateDns'] + ':3073':
        raise ValueError('Importer identity changed; refresh TLS and application configuration first')
    secret = release['configSecret']
    if secret != outputs['ConfigSecret']:
        raise ValueError('Importer configuration identity changed')
    config = json.loads(aws('secretsmanager', 'get-secret-value', '--secret-id', secret)['SecretString'])
    env = config['environment']
    if (config['image'] != release['importerImage'] or env.get('STUDIO_WORKER_MODE') != 'imports'
            or env.get('STUDIO_PUBLISHING_ENABLED') != 'false' or env.get('DEPLOY_ENV') != environment):
        raise ValueError('Importer configuration is not the isolated release')
    config['ready'] = True
    with tempfile.NamedTemporaryFile(mode='w', prefix='sgs-importer-activate-', delete=False) as handle:
        os.chmod(handle.name, 0o600)
        json.dump(config, handle)
        filename = handle.name
    try:
        aws('secretsmanager', 'put-secret-value', '--secret-id', secret, '--secret-string', 'file://' + filename)
    finally:
        pathlib.Path(filename).unlink(missing_ok=True)
    print(environment + ': importer activated after generation-only Studio drained its predecessor.')


if __name__ == '__main__':
    activate(sys.argv[1], pathlib.Path(sys.argv[2]))
