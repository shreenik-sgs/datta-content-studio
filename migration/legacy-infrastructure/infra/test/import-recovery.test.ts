import assert from "node:assert/strict";
import { test } from "node:test";
import {
  App,
  Stack,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_secretsmanager as sm,
} from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { HubServices } from "../lib/hub-services";
import type { Container, NamedValue, Resource, Synthesized } from "./template-types";

function synth(environment: string, enabled: boolean) {
  const app = new App({ context: { importVerification: String(enabled) } });
  const stack = new Stack(app, "ImportRecovery", {
    env: { account: "111111111111", region: "ap-south-1" },
  });
  const vpc = new ec2.Vpc(stack, "Vpc", {
    maxAzs: 2,
    natGateways: 0,
    subnetConfiguration: [{ name: "private", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
  });
  const group = new ec2.SecurityGroup(stack, "Group", { vpc });
  const alb = new elbv2.ApplicationLoadBalancer(stack, "Alb", { vpc, securityGroup: group });
  const listener = alb.addListener("Listener", {
    port: 80,
    defaultAction: elbv2.ListenerAction.fixedResponse(404),
  });
  new HubServices(stack, "Hub", {
    environment,
    hostname: `${environment}.example.test`,
    vpc,
    cluster: new ecs.Cluster(stack, "Cluster", { vpc }),
    listener,
    serviceSecurityGroup: group,
    albSecurityGroup: group,
    repository: ecr.Repository.fromRepositoryName(stack, "Images", "test-images"),
    imageTag: "tested",
    databaseHost: "db.example.test",
    databaseSecret: sm.Secret.fromSecretCompleteArn(
      stack,
      "Database",
      "arn:aws:secretsmanager:ap-south-1:111111111111:secret:database-abcdef",
    ),
    ready: true,
    productionAuthorized: true,
    originVerifyHeader: "fixture-header",
  });
  return Template.fromStack(stack).toJSON() as Synthesized;
}

for (const environment of ["staging", "production"]) {
  test(`${environment}: later releases preserve private browser trust and single importer ownership`, () => {
    const template = synth(environment, true);
    const containers = Object.values(template.Resources)
      .filter((r: Resource) => r.Type === "AWS::ECS::TaskDefinition")
      .flatMap((r: Resource) => r.Properties.ContainerDefinitions);
    const web = containers.find((c: Container) => c.Name === "hub-web");
    const studio = containers.find((c: Container) => c.Name === "hub-studio");
    assert.deepEqual(
      studio.Environment.find((e: NamedValue) => e.Name === "STUDIO_WORKER_MODE"),
      { Name: "STUDIO_WORKER_MODE", Value: "generation" },
    );
    assert.deepEqual(
      web.Environment.find((e: NamedValue) => e.Name === "STUDIO_IMPORT_VERIFICATION_ORIGIN").Value,
      { "Fn::ImportValue": `sgs-${environment}-hub-import-verification-origin` },
    );
    for (const name of ["STUDIO_IMPORT_VERIFICATION_KEY", "STUDIO_IMPORT_VERIFICATION_CA"]) {
      const secret = web.Secrets.find((s: NamedValue) => s.Name === name);
      assert.ok(
        JSON.stringify(secret).includes(`sgs-${environment}-hub-import-verification-secret`),
      );
      assert.ok(!studio.Secrets.some((s: NamedValue) => s.Name === name));
    }
    assert.ok(!JSON.stringify(template).includes("STUDIO_IMPORT_VERIFICATION_TLS_KEY"));
  });
  test(`${environment}: initial Hub bootstrap does not depend on the later importer stack`, () => {
    assert.ok(!JSON.stringify(synth(environment, false)).includes("hub-import-verification"));
  });
}
