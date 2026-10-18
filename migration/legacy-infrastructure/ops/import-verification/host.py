#!/usr/bin/env python3
"""Private EC2 importer launcher. Values are read from Secrets Manager, never logged."""
import json
import os
import pathlib
import subprocess
import sys

REGION = "ap-south-1"
ROOT = pathlib.Path("/opt/sgs-hub-importer")
RUNTIME = pathlib.Path("/run/sgs-hub-importer")


def aws(*args):
    return subprocess.check_output(["aws", "--region", REGION, *args], stderr=subprocess.DEVNULL)


def secret(arn):
    return json.loads(aws("secretsmanager", "get-secret-value", "--secret-id", arn))["SecretString"]


def main():
    settings = json.loads((ROOT / "host.json").read_text())
    config = json.loads(secret(settings["configSecret"]))
    if not config.get("ready"):
        raise RuntimeError("Configuration not yet activated")
    image = config["image"]
    registry = "510724490093.dkr.ecr.ap-south-1.amazonaws.com"
    if not image.startswith(registry + "/sgsdattasannidhi@sha256:"):
        raise RuntimeError("Immutable importer image required")
    env = dict(config["environment"])
    env.update({"STUDIO_IMPORT_VERIFICATION_KEY": config["key"],
                "STUDIO_IMPORT_VERIFICATION_TLS_CERT": config["certificate"],
                "STUDIO_IMPORT_VERIFICATION_TLS_KEY": config["privateKey"],
                "DISTRIBUTION_DATABASE_URL": secret(settings["databaseSecret"]),
                "STUDIO_WORKER_AUTHORIZATION_KEY": secret(settings["authoritySecret"])})
    if env.get("STUDIO_WORKER_MODE") != "imports" or env.get("STUDIO_PUBLISHING_ENABLED") != "false":
        raise RuntimeError("Importer must not generate or publish content")
    RUNTIME.mkdir(mode=0o700, exist_ok=True)
    os.chmod(RUNTIME, 0o700)
    env_file = RUNTIME / "container.env"
    for key, value in env.items():
        if "\n" in value or "\r" in value or "=" in key:
            raise RuntimeError("Invalid environment encoding")
    env_file.write_text("".join(f"{key}={value}\n" for key, value in env.items()))
    os.chmod(env_file, 0o600)
    docker_config = RUNTIME / "docker"
    docker_config.mkdir(mode=0o700, exist_ok=True)
    process_env = {**os.environ, "DOCKER_CONFIG": str(docker_config)}
    token = aws("ecr", "get-login-password")
    subprocess.run(["docker", "login", "--username", "AWS", "--password-stdin", registry],
                   input=token, env=process_env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["docker", "pull", image], env=process_env, check=True, stdout=subprocess.DEVNULL)
    subprocess.run(["docker", "rm", "-f", "sgs-hub-importer"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    args = ["docker", "run", "--rm", "--name", "sgs-hub-importer", "--init", "--shm-size=256m",
            "--memory=3g", "--cpus=2", "--security-opt", f"seccomp={ROOT}/seccomp.json",
            "--env-file", str(env_file), "-p", "3073:3073",
            "--log-driver", "awslogs", "--log-opt", f"awslogs-region={REGION}",
            "--log-opt", f"awslogs-group={settings['logGroup']}",
            "--log-opt", "awslogs-stream=importer", image]
    raise SystemExit(subprocess.call(args, env=process_env))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Importer startup is waiting for valid private configuration.", file=sys.stderr)
        raise SystemExit(1)
