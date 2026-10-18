#!/usr/bin/env python3
"""Render an additive CloudFormation stack from observed environment metadata."""
import base64
import gzip
import json
import pathlib
import sys


def render(config):
    env = config["environment"]
    if env not in ("staging", "production"):
        raise ValueError("Unknown environment")
    prefix = f"sgsdattasannidhi-{env}-hub-importer"
    if config.get("instanceType", "t4g.medium") not in ("t4g.medium", "t4g.large"):
        raise ValueError("Unreviewed importer instance size")
    if config.get("existingConfigSecret") and not config["existingConfigSecret"].startswith(
        "arn:aws:secretsmanager:ap-south-1:510724490093:secret:" + prefix + "-"
    ):
        raise ValueError("Configuration secret belongs to another environment")
    path = pathlib.Path(__file__).resolve().parent
    encode = lambda value: base64.b64encode(gzip.compress(value, mtime=0)).decode()
    host = encode((path / "host.py").read_bytes())
    sandbox = encode((path.parent / "import-verification-seccomp.json").read_bytes())
    settings = {"configSecret": "${Config}", "databaseSecret": config["databaseSecret"],
                "authoritySecret": config["authoritySecret"], "logGroup": "/sgsdattasannidhi/" + env + "/hub-importer"}
    user_data = f'''#!/bin/bash
set -euo pipefail
dnf install -y docker python3 awscli
systemctl enable --now docker
install -d -m 0700 /opt/sgs-hub-importer
printf '%s' '{host}' | base64 -d | gzip -d > /opt/sgs-hub-importer/host.py
printf '%s' '{sandbox}' | base64 -d | gzip -d > /opt/sgs-hub-importer/seccomp.json
cat > /opt/sgs-hub-importer/host.json <<'CONFIG'
{json.dumps(settings)}
CONFIG
chmod 0600 /opt/sgs-hub-importer/host.json
cat > /etc/systemd/system/sgs-hub-importer.service <<'UNIT'
[Unit]
Description=SGS private YouTube verification and importer
Requires=docker.service
After=docker.service network-online.target
[Service]
Type=simple
ExecStart=/usr/bin/python3 /opt/sgs-hub-importer/host.py
ExecStop=-/usr/bin/docker stop -t 45 sgs-hub-importer
Restart=always
RestartSec=30
TimeoutStopSec=60
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now sgs-hub-importer
'''
    ref = lambda name: {"Ref": name}
    get = lambda name, attr: {"Fn::GetAtt": [name, attr]}
    resources = {
        "Config": {"Type": "AWS::SecretsManager::Secret", "DeletionPolicy": "Retain", "UpdateReplacePolicy": "Retain",
                   "Properties": {"Name": prefix, "Description": "Private importer TLS and control configuration; environment isolated",
                    "GenerateSecretString": {"SecretStringTemplate": '{"ready":false}', "GenerateStringKey": "bootstrap", "PasswordLength": 32}}},
        "Logs": {"Type": "AWS::Logs::LogGroup", "DeletionPolicy": "Retain", "Properties": {
            "LogGroupName": settings["logGroup"], "RetentionInDays": 30}},
        "SecurityGroup": {"Type": "AWS::EC2::SecurityGroup", "Properties": {"GroupDescription": "Private Hub verification TLS only",
            "VpcId": config["vpcId"], "SecurityGroupIngress": [{"IpProtocol": "tcp", "FromPort": 3073, "ToPort": 3073,
                "SourceSecurityGroupId": config["serviceSecurityGroup"]}],
            "Tags": [{"Key": "Name", "Value": prefix}]}},
        "Role": {"Type": "AWS::IAM::Role", "Properties": {
            "AssumeRolePolicyDocument": {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Principal": {"Service": "ec2.amazonaws.com"}, "Action": "sts:AssumeRole"}]},
            "ManagedPolicyArns": ["arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"],
            "Policies": [{"PolicyName": "PrivateImporter", "PolicyDocument": {"Version": "2012-10-17", "Statement": [
                {"Effect": "Allow", "Action": ["secretsmanager:GetSecretValue"], "Resource": [ref("Config"), config["databaseSecret"], config["authoritySecret"]]},
                {"Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*"},
                {"Effect": "Allow", "Action": ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"], "Resource": "arn:aws:ecr:ap-south-1:510724490093:repository/sgsdattasannidhi"},
                {"Effect": "Allow", "Action": ["s3:GetBucketLocation", "s3:ListBucket"], "Resource": "arn:aws:s3:::" + config["bucket"]},
                {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"], "Resource": "arn:aws:s3:::" + config["bucket"] + "/" + config["assetPrefix"] + "*"},
                {"Effect": "Allow", "Action": ["logs:CreateLogStream", "logs:PutLogEvents"], "Resource": get("Logs", "Arn")}
            ]}}]}},
        "Profile": {"Type": "AWS::IAM::InstanceProfile", "Properties": {"Roles": [ref("Role")]}},
        "Host": {"Type": "AWS::EC2::Instance", "Properties": {
            "ImageId": ref("Ami"), "InstanceType": config.get("instanceType", "t4g.medium"), "IamInstanceProfile": ref("Profile"),
            "SubnetId": config["subnetId"], "SecurityGroupIds": [config["serviceSecurityGroup"], ref("SecurityGroup")],
            "MetadataOptions": {"HttpTokens": "required", "HttpPutResponseHopLimit": 2},
            "BlockDeviceMappings": [{"DeviceName": "/dev/xvda", "Ebs": {"VolumeSize": 30, "VolumeType": "gp3", "Encrypted": True, "DeleteOnTermination": True}}],
            "Tags": [{"Key": "Name", "Value": prefix}], "UserData": {"Fn::Base64": {"Fn::Sub": user_data}}}}
    }
    resources["OperatorRole"] = {
        "Type": "AWS::IAM::Role",
        "Properties": {
            "MaxSessionDuration": 3600,
            "AssumeRolePolicyDocument": {"Version": "2012-10-17", "Statement": [{
                "Effect": "Allow", "Principal": {"AWS": "arn:aws:iam::510724490093:user/shree-admin"},
                "Action": "sts:AssumeRole", "Condition": {"Bool": {"aws:MultiFactorAuthPresent": "true"}}
            }]},
            "Policies": [{"PolicyName": "ThisImporterOnly", "PolicyDocument": {"Version": "2012-10-17", "Statement": [
                {"Effect": "Allow", "Action": "ssm:SendCommand", "Resource": [
                    {"Fn::Sub": "arn:aws:ec2:${AWS::Region}:${AWS::AccountId}:instance/${Host}"},
                    "arn:aws:ssm:ap-south-1::document/AWS-RunShellScript"
                ]},
                {"Effect": "Allow", "Action": ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"], "Resource": "*"}
            ]}}]
        }
    }
    if config.get("existingConfigSecret"):
        # Failed/replaced stacks deliberately retain these resources. Reuse their environment's
        # identity instead of replacing keys or leaving duplicate retained resources.
        resources.pop("Config")
        resources.pop("Logs")
        resources["Role"]["Properties"]["Policies"][0]["PolicyDocument"]["Statement"][0]["Resource"][0] = config["existingConfigSecret"]
        resources["Role"]["Properties"]["Policies"][0]["PolicyDocument"]["Statement"][-1]["Resource"] = "arn:aws:logs:ap-south-1:510724490093:log-group:" + config["existingLogGroup"] + ":*"
        resources["Host"]["Properties"]["UserData"]["Fn::Base64"]["Fn::Sub"] = user_data.replace("${Config}", config["existingConfigSecret"])
    return {"AWSTemplateFormatVersion": "2010-09-09", "Description": f"Isolated {env} Hub import verification runtime",
            "Parameters": {"Ami": {"Type": "String", "AllowedPattern": "ami-[0-9a-f]+", "Default": config["amiId"]}},
            "Resources": resources, "Outputs": {
                "OperatorRole": {"Value": get("OperatorRole", "Arn")},
                "InstanceId": {"Value": ref("Host")},
                "PrivateDns": {"Value": get("Host", "PrivateDnsName")},
                "PrivateIp": {"Value": get("Host", "PrivateIp")},
                "VerificationOrigin": {"Value": {"Fn::Sub": "https://${Host.PrivateDnsName}:3073"},
                    "Export": {"Name": f"sgs-{env}-hub-import-verification-origin"}},
                "ConfigSecret": {"Value": config.get("existingConfigSecret", ref("Config")),
                    "Export": {"Name": f"sgs-{env}-hub-import-verification-secret"}}
            }}


if __name__ == "__main__":
    print(json.dumps(render(json.loads(pathlib.Path(sys.argv[1]).read_text())), indent=2))
