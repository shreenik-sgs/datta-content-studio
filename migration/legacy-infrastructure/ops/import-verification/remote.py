#!/usr/bin/env python3
"""Run a reviewed script on this environment's importer through an MFA-protected role."""
import json
import os
import pathlib
import subprocess
import sys
import tempfile


def send(environment, script):
    if environment not in ('staging', 'production'):
        raise ValueError('Unknown environment')
    base = ['aws', '--profile', 'mfa', '--region', 'ap-south-1']
    stack = json.loads(subprocess.check_output(base + ['cloudformation', 'describe-stacks', '--stack-name', 'SgsDattaSannidhiImportRecovery-' + environment, '--output', 'json']))['Stacks'][0]
    outputs = {item['OutputKey']: item['OutputValue'] for item in stack['Outputs']}
    result = json.loads(subprocess.check_output(base + ['sts', 'assume-role', '--role-arn', outputs['OperatorRole'], '--role-session-name', 'hub-importer-' + environment, '--duration-seconds', '900', '--output', 'json']))
    credentials = result['Credentials']
    env = {key: value for key, value in os.environ.items() if not key.startswith('AWS_')}
    env.update({'AWS_ACCESS_KEY_ID': credentials['AccessKeyId'], 'AWS_SECRET_ACCESS_KEY': credentials['SecretAccessKey'], 'AWS_SESSION_TOKEN': credentials['SessionToken'], 'AWS_DEFAULT_REGION': 'ap-south-1'})
    with tempfile.NamedTemporaryFile(mode='w', prefix='sgs-importer-command-', delete=False) as handle:
        json.dump({'commands': [script], 'executionTimeout': ['900']}, handle)
        name = handle.name
    try:
        response = json.loads(subprocess.check_output(['aws', '--region', 'ap-south-1', 'ssm', 'send-command', '--instance-ids', outputs['InstanceId'], '--document-name', 'AWS-RunShellScript', '--parameters', 'file://' + name, '--output', 'json'], env=env))
    finally:
        pathlib.Path(name).unlink(missing_ok=True)
    return {'environment': environment, 'instanceId': outputs['InstanceId'], 'commandId': response['Command']['CommandId']}


if __name__ == '__main__':
    print(json.dumps(send(sys.argv[1], pathlib.Path(sys.argv[2]).read_text())))
