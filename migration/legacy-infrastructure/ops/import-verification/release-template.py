#!/usr/bin/env python3
"""Change only the two Hub task definitions and verification-secret read permission."""
import copy
import json
import pathlib
import sys


def patch(template, release):
    result = copy.deepcopy(template)
    changed = set()
    for key, resource in result['Resources'].items():
        if resource['Type'] != 'AWS::ECS::TaskDefinition':
            continue
        for container in resource['Properties']['ContainerDefinitions']:
            name = container['Name']
            if name not in ('hub-web', 'hub-studio'):
                continue
            image = release['webImage' if name == 'hub-web' else 'studioImage']
            if not image.startswith('510724490093.dkr.ecr.ap-south-1.amazonaws.com/sgsdattasannidhi@sha256:'):
                raise ValueError('Immutable release digest required')
            container['Image'] = image
            environment = {row['Name']: row['Value'] for row in container.get('Environment', [])}
            if name == 'hub-studio':
                environment['STUDIO_WORKER_MODE'] = 'generation'
            else:
                if not release['origin'].startswith('https://'):
                    raise ValueError('Private TLS origin required')
                environment['STUDIO_IMPORT_VERIFICATION_ORIGIN'] = release['origin']
                environment['STUDIO_IMPORT_VERIFICATION_CA'] = release['certificate']
                secrets = {row['Name']: row['ValueFrom'] for row in container.get('Secrets', [])}
                secrets['STUDIO_IMPORT_VERIFICATION_KEY'] = release['configSecret'] + ':key::'
                container['Secrets'] = [{'Name': name, 'ValueFrom': value} for name, value in secrets.items()]
            container['Environment'] = [{'Name': name, 'Value': value} for name, value in environment.items()]
            changed.add(key)
    policy = result['Resources']['HubhubwebTaskExecutionRoleDefaultPolicy1AFC641E']['Properties']['PolicyDocument']
    statement = {'Effect': 'Allow', 'Action': ['secretsmanager:GetSecretValue'], 'Resource': release['configSecret']}
    if statement not in policy['Statement']:
        policy['Statement'].append(statement)
    changed.add('HubhubwebTaskExecutionRoleDefaultPolicy1AFC641E')
    expected = {'HubhubwebTaskD2B5524A', 'HubhubstudioTaskF6B70CF4', 'HubhubwebTaskExecutionRoleDefaultPolicy1AFC641E'}
    if changed != expected:
        raise ValueError('Unexpected Hub resource layout')
    actual = {key for key, value in template['Resources'].items() if value != result['Resources'][key]}
    if not actual <= expected:
        raise ValueError('Unrelated infrastructure must not change')
    return result


if __name__ == '__main__':
    print(json.dumps(patch(json.loads(pathlib.Path(sys.argv[1]).read_text()),
                           json.loads(pathlib.Path(sys.argv[2]).read_text())), indent=2))
