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
import type { NamedValue, Synthesized } from "./template-types";

function fixture(environment = "staging", ready = false, productionAuthorized = false) {
  const app = new App();
  const stack = new Stack(app, "HubTest", {
    env: { account: "510724490093", region: "ap-south-1" },
  });
  const vpc = new ec2.Vpc(stack, "Vpc", { maxAzs: 2 });
  const serviceSecurityGroup = new ec2.SecurityGroup(stack, "Services", { vpc });
  const albSecurityGroup = new ec2.SecurityGroup(stack, "AlbSg", { vpc });
  const alb = new elbv2.ApplicationLoadBalancer(stack, "Alb", {
    vpc,
    securityGroup: albSecurityGroup,
  });
  const listener = alb.addListener("Http", {
    port: 80,
    defaultAction: elbv2.ListenerAction.fixedResponse(404),
  });
  new HubServices(stack, "Hub", {
    environment,
    hostname: "staging.sgsdattasannidhi.org",
    vpc,
    cluster: new ecs.Cluster(stack, "Cluster", { vpc }),
    listener,
    serviceSecurityGroup,
    albSecurityGroup,
    repository: ecr.Repository.fromRepositoryName(stack, "Images", "sgsdattasannidhi"),
    imageTag: "0123456789ab",
    databaseHost: "staging.rds.amazonaws.com",
    databaseSecret: sm.Secret.fromSecretNameV2(stack, "DbSecret", "staging-rds"),
    ready,
    productionAuthorized,
    originVerifyHeader:
      environment === "production" ? "test-origin-header-not-a-secret" : undefined,
  });
  return Template.fromStack(stack).toJSON() as Synthesized;
}

test("staging starts stopped until its explicit migration succeeds", () => {
  const template = fixture();
  const resources = Object.values(template.Resources);
  const services = resources.filter((r) => r.Type === "AWS::ECS::Service");
  assert.equal(services.length, 2);
  assert.ok(services.every((r) => r.Properties.DesiredCount === 0));
  const tasks = resources.filter((r) => r.Type === "AWS::ECS::TaskDefinition");
  assert.equal(tasks.length, 3);
  for (const task of tasks) {
    const c = task.Properties.ContainerDefinitions[0];
    assert.equal(
      c.Environment.find((e: NamedValue) => e.Name === "STUDIO_PUBLISHING_ENABLED").Value,
      "false",
    );
    assert.equal(
      c.Environment.find((e: NamedValue) => e.Name === "STUDIO_CHANNEL_CONFIG_BACKEND").Value,
      "database",
    );
    assert.equal(task.Properties.Volumes, undefined);
    if (c.Name !== "hub-migrate")
      assert.ok(!c.Secrets.some((s: NamedValue) => /ADMIN|MIGRATION/.test(s.Name)));
    if (c.Name === "hub-web") assert.ok(!c.Secrets.some((s: NamedValue) => /API_KEY/.test(s.Name)));
  }
  const bucket = resources.find((r) => r.Type === "AWS::S3::Bucket");
  assert.equal(bucket.DeletionPolicy, "Retain");
  assert.ok(
    Object.values(bucket.Properties.PublicAccessBlockConfiguration).every((v) => v === true),
  );
  assert.ok(!resources.some((r) => r.Type === "AWS::EFS::FileSystem"));
});
test("ready staging has one web and one renderer, production is refused", () => {
  const resources = Object.values(fixture("staging", true).Resources);
  assert.ok(
    resources
      .filter((r) => r.Type === "AWS::ECS::Service")
      .every((r) => r.Properties.DesiredCount === 1),
  );
  assert.throws(() => fixture("production"), /explicit provisioning authorization/);
});

test("production is isolated and stopped before migration", () => {
  const resources = Object.values(fixture("production", false, true).Resources);
  const rule = resources.find((r) => r.Type === "AWS::ElasticLoadBalancingV2::ListenerRule");
  assert.ok(rule.Properties.Conditions.some((c: { Field: string }) => c.Field === "http-header"));
  assert.ok(
    resources
      .filter((r) => r.Type === "AWS::ECS::Service")
      .every((r) => r.Properties.DesiredCount === 0),
  );
  for (const task of resources.filter((r) => r.Type === "AWS::ECS::TaskDefinition")) {
    assert.ok(task.Properties.Family.startsWith("sgsdattasannidhi-production-"));
    const c = task.Properties.ContainerDefinitions[0];
    assert.equal(
      c.Environment.find((e: NamedValue) => e.Name === "DEPLOY_ENV").Value,
      "production",
    );
    assert.ok(!JSON.stringify(c.Secrets).includes("sgs-staging-hub"));
    assert.equal(
      c.Environment.some((e: NamedValue) => e.Name === "HUB_PRODUCTION_BOOTSTRAP"),
      c.Name === "hub-migrate",
    );
  }
});
